/**
 * Round-trip safe Backlog.md task file editor.
 *
 * Why this exists (AISDLC-73):
 *   The upstream `mcp__backlog__task_edit` tool re-serialises the YAML
 *   frontmatter from its known schema and silently drops any unrecognised
 *   keys. Tasks declaring custom fields (notably `permittedExternalPaths`,
 *   used by `/ai-sdlc execute` to allowlist sibling-repo writes) lose
 *   those fields after a single status flip, breaking subsequent runs.
 *
 *   This module provides drop-in replacements (`task_edit` and
 *   `task_complete`) that mutate ONLY the specific lines / sections that
 *   change and pass every other byte of the file through verbatim. The
 *   strategy is intentionally "minimum-mutation": we never round-trip the
 *   whole document through a YAML parser, so we cannot lose unknown keys,
 *   re-flow multi-line scalars, change quote styles, or otherwise drift.
 *
 *   The trade-off is that we do less validation of the YAML — but for the
 *   narrow set of mutations the dogfood pipeline performs (status,
 *   updated_date, AC checkbox, optional Final Summary section), staying
 *   line-local is the safest possible behaviour.
 */

// ── Frontmatter splitting ──────────────────────────────────────────────

const FRONTMATTER_DELIMITER = '---';

export interface FrontmatterSplit {
  /**
   * `true` when the file starts with a `---` delimited frontmatter block.
   * `false` when there is no frontmatter at all.
   */
  hasFrontmatter: boolean;
  /** Frontmatter lines WITHOUT the surrounding `---` delimiters. */
  frontmatterLines: string[];
  /** Body lines AFTER the closing `---`. */
  bodyLines: string[];
  /**
   * Detected line ending — preserved when joining back. We default to LF
   * because every Backlog.md file in this repo (and the upstream tool's
   * output) uses LF, but the parser sniffs CRLF for Windows-edited files.
   */
  lineEnding: '\n' | '\r\n';
}

/**
 * Split a Backlog.md task file into frontmatter + body, preserving every
 * non-delimiter byte. Idempotent: `joinFrontmatter(splitFrontmatter(s))`
 * round-trips to `s` byte-for-byte for any input.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const lineEnding: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(lineEnding);

  // Empty file or no leading `---` → no frontmatter.
  if (lines.length === 0 || lines[0] !== FRONTMATTER_DELIMITER) {
    return { hasFrontmatter: false, frontmatterLines: [], bodyLines: lines, lineEnding };
  }

  // Find the closing `---`. Must appear on its own line.
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      closeIdx = i;
      break;
    }
  }

  // Unclosed frontmatter → treat as no frontmatter so callers don't
  // accidentally truncate the file. The bug we are fixing is silent
  // data loss; we should not introduce a new failure mode here.
  if (closeIdx === -1) {
    return { hasFrontmatter: false, frontmatterLines: [], bodyLines: lines, lineEnding };
  }

  return {
    hasFrontmatter: true,
    frontmatterLines: lines.slice(1, closeIdx),
    bodyLines: lines.slice(closeIdx + 1),
    lineEnding,
  };
}

/** Reassemble a `FrontmatterSplit` into a single string. */
export function joinFrontmatter(split: FrontmatterSplit): string {
  const { hasFrontmatter, frontmatterLines, bodyLines, lineEnding } = split;
  if (!hasFrontmatter) {
    return bodyLines.join(lineEnding);
  }
  return [FRONTMATTER_DELIMITER, ...frontmatterLines, FRONTMATTER_DELIMITER, ...bodyLines].join(
    lineEnding,
  );
}

// ── Frontmatter block parsing ──────────────────────────────────────────

/**
 * A single top-level key in the frontmatter, with all of its raw lines
 * (the `key:` line and any continuation lines belonging to it). We never
 * try to interpret the value — we just keep the bytes so they can be
 * passed through verbatim when we are not editing this key.
 */
export interface FrontmatterBlock {
  /** Top-level key name, e.g. `status`, `permittedExternalPaths`. */
  key: string;
  /** Raw lines exactly as they appeared in the source file. */
  lines: string[];
}

/**
 * Parse the frontmatter line array into a list of top-level blocks.
 *
 * A "top-level" line starts with `<identifier>:` at column 0. Every
 * subsequent indented (`/^[ \t]/`) or empty line is folded into the
 * preceding block — that captures both YAML block sequences (`  - x`)
 * and folded/literal scalars (`>-` / `|`) without parsing them.
 *
 * Lines that look like neither (e.g. stray comments at column 0, or
 * malformed YAML) are emitted as their own zero-key block so they still
 * round-trip. Their `key` is the empty string so they can be detected
 * and preserved as-is.
 */
export function parseFrontmatterBlocks(frontmatterLines: string[]): FrontmatterBlock[] {
  const blocks: FrontmatterBlock[] = [];
  let current: FrontmatterBlock | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s|$)/);
    if (keyMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current) blocks.push(current);
      current = { key: keyMatch[1], lines: [line] };
      continue;
    }
    if (!current) {
      // Stray line before any key — preserve as a keyless block.
      current = { key: '', lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Serialise blocks back into a flat line array. Inverse of `parseFrontmatterBlocks`. */
export function serializeFrontmatterBlocks(blocks: FrontmatterBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) out.push(...block.lines);
  return out;
}

// ── Single-key mutators ────────────────────────────────────────────────

/**
 * Replace a scalar key's value (e.g. `status: To Do` → `status: In Progress`).
 *
 * Behaviour:
 *   - If the key already exists as a single-line scalar, we replace ONLY
 *     the value portion of that line (preserving any trailing comment
 *     after a `#` is intentionally NOT supported — Backlog.md never
 *     emits trailing comments and supporting them adds bug surface).
 *   - If the key exists as a multi-line block (sequence or folded
 *     scalar), we replace the entire block with a single-line scalar.
 *   - If the key does not exist, we append a new block at the end of
 *     the frontmatter. This keeps the existing key order stable, which
 *     matters for diffs and human review.
 */
export function setFrontmatterScalar(
  blocks: FrontmatterBlock[],
  key: string,
  value: string,
): FrontmatterBlock[] {
  const formatted = formatScalarLine(key, value);
  const idx = blocks.findIndex((b) => b.key === key);
  if (idx === -1) {
    return [...blocks, { key, lines: [formatted] }];
  }
  const next = [...blocks];
  next[idx] = { key, lines: [formatted] };
  return next;
}

/**
 * Format a scalar key/value line. Quoting rules mirror the upstream
 * tool's emission: quote with single quotes when the value contains a
 * `:` (would be ambiguous), starts with a YAML indicator character, or
 * is the empty string. Otherwise emit unquoted.
 *
 * We deliberately keep the rules narrow — the common case (`status: Done`,
 * `updated_date: '2026-04-27 23:09'`) needs to look identical to what
 * the upstream tool would emit so PR diffs stay clean.
 */
function formatScalarLine(key: string, value: string): string {
  if (needsQuoting(value)) {
    // Escape single quotes by doubling them (YAML 1.2 single-quoted style).
    const escaped = value.replace(/'/g, "''");
    return `${key}: '${escaped}'`;
  }
  return `${key}: ${value}`;
}

function needsQuoting(value: string): boolean {
  if (value === '') return true;
  // Leading YAML indicators or whitespace-sensitive characters.
  if (/^[\s!&*?|>%@`#,[\]{}'"-]/.test(value)) return true;
  // Contains `:` (ambiguous scalar/key boundary) or `#` (comment).
  if (/[:#]/.test(value)) return true;
  // Booleans / nulls / numbers that should stay strings (status:Done is
  // safe but `status: True` would parse as boolean).
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  return false;
}

// ── Body mutators ──────────────────────────────────────────────────────

/**
 * Toggle one or more Acceptance Criteria checkboxes to `[x]`. AC indices
 * are 1-based and match the `#N` markers Backlog.md emits, e.g.
 * `- [ ] #3 Regression test...`. ACs without an explicit `#N` marker
 * are numbered by their position in the AC section.
 *
 * The `## Acceptance Criteria` heading and AC bounds (`<!-- AC:BEGIN -->`
 * / `<!-- AC:END -->`) are preserved. Lines outside the AC region are
 * passed through unchanged.
 */
export function checkAcceptanceCriteria(bodyLines: string[], indices: readonly number[]): string[] {
  if (indices.length === 0) return bodyLines;
  const wanted = new Set(indices);
  const out: string[] = [];
  let inAcSection = false;
  let positionalIdx = 0;

  for (const line of bodyLines) {
    // Section boundaries — header detection is intentionally loose to
    // match Backlog.md's own emission (always `## Acceptance Criteria`).
    if (/^##\s+Acceptance Criteria/i.test(line)) {
      inAcSection = true;
      positionalIdx = 0;
      out.push(line);
      continue;
    }
    if (inAcSection && /^##\s+/.test(line)) {
      inAcSection = false;
      out.push(line);
      continue;
    }

    if (!inAcSection) {
      out.push(line);
      continue;
    }

    const acMatch = line.match(/^(\s*-\s+\[)([ xX])(\]\s+)(?:#(\d+)\s+)?(.*)$/);
    if (!acMatch) {
      out.push(line);
      continue;
    }
    positionalIdx += 1;
    const explicitIdx = acMatch[4] ? Number(acMatch[4]) : undefined;
    const acIdx = explicitIdx ?? positionalIdx;
    if (wanted.has(acIdx)) {
      const prefix = acMatch[1];
      const suffix = acMatch[3];
      const numberMarker = explicitIdx !== undefined ? `#${explicitIdx} ` : '';
      out.push(`${prefix}x${suffix}${numberMarker}${acMatch[5]}`);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Append (or replace) the `## Final Summary` section at the end of the
 * body. If the section already exists, the existing content is replaced
 * with the new summary; otherwise a new section is appended. This
 * mirrors what `/ai-sdlc execute` step 13 expects.
 */
export function setFinalSummary(bodyLines: string[], summary: string): string[] {
  const headingIdx = bodyLines.findIndex((line) => /^##\s+Final Summary\s*$/i.test(line));
  const summaryLines = summary.split(/\r?\n/);

  if (headingIdx === -1) {
    // Append. Ensure exactly one blank line separates the previous
    // content from the new heading; trim any trailing blank lines first.
    const trimmed = trimTrailingBlankLines(bodyLines);
    const out = [...trimmed];
    if (out.length > 0) out.push('');
    out.push('## Final Summary', '', ...summaryLines, '');
    return out;
  }

  // Replace existing section: keep everything up to (and including) the
  // heading + blank line, drop the rest, append new summary.
  let endIdx = bodyLines.length;
  for (let i = headingIdx + 1; i < bodyLines.length; i++) {
    if (/^##\s+/.test(bodyLines[i])) {
      endIdx = i;
      break;
    }
  }
  const before = bodyLines.slice(0, headingIdx + 1);
  const after = bodyLines.slice(endIdx);
  return [...before, '', ...summaryLines, '', ...after];
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}

// ── High-level edit operation ──────────────────────────────────────────

export interface TaskEditOperation {
  /** New value for the `status` frontmatter key (e.g. `'In Progress'`). */
  status?: string;
  /**
   * Stamp the `updated_date` frontmatter key. Pass `false` to skip,
   * `true` to use the current time, or a string for an explicit value.
   * Defaults to `true` whenever any other field changes — matching the
   * upstream tool's behaviour.
   */
  updatedDate?: string | boolean;
  /** AC indices (1-based) to flip from `[ ]` to `[x]`. */
  acceptanceCriteriaCheck?: readonly number[];
  /** Replacement / appended content for the `## Final Summary` section. */
  finalSummary?: string;
}

/**
 * Apply a `TaskEditOperation` to a Backlog.md task file's contents and
 * return the new contents. Unknown frontmatter keys are preserved
 * verbatim — that is the entire point of this module.
 *
 * The operation is pure and side-effect free; callers are responsible
 * for writing the result to disk and staging it with git.
 */
export function applyTaskEdit(content: string, op: TaskEditOperation): string {
  const split = splitFrontmatter(content);
  const blocks = parseFrontmatterBlocks(split.frontmatterLines);

  let nextBlocks = blocks;
  let frontmatterChanged = false;
  if (op.status !== undefined) {
    nextBlocks = setFrontmatterScalar(nextBlocks, 'status', op.status);
    frontmatterChanged = true;
  }

  // Stamp updated_date when the caller asks, OR when any other
  // frontmatter / body change happened and they didn't opt out. We
  // default-on because the upstream tool always stamps it and we want
  // diffs to look the same.
  const bodyOps = op.acceptanceCriteriaCheck !== undefined || op.finalSummary !== undefined;
  const shouldStampDate =
    op.updatedDate === true ||
    (typeof op.updatedDate === 'string' && op.updatedDate.length > 0) ||
    (op.updatedDate !== false && (frontmatterChanged || bodyOps));
  if (shouldStampDate) {
    const value = typeof op.updatedDate === 'string' ? op.updatedDate : nowStamp();
    nextBlocks = setFrontmatterScalar(nextBlocks, 'updated_date', value);
  }

  let nextBody = split.bodyLines;
  if (op.acceptanceCriteriaCheck !== undefined) {
    nextBody = checkAcceptanceCriteria(nextBody, op.acceptanceCriteriaCheck);
  }
  if (op.finalSummary !== undefined) {
    nextBody = setFinalSummary(nextBody, op.finalSummary);
  }

  const nextSplit: FrontmatterSplit = {
    ...split,
    frontmatterLines: serializeFrontmatterBlocks(nextBlocks),
    bodyLines: nextBody,
  };
  return joinFrontmatter(nextSplit);
}

/**
 * Format a timestamp the same way Backlog.md does: `YYYY-MM-DD HH:MM`
 * in UTC. Stable, sortable, no locale surprises.
 */
function nowStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

// ── Read helpers ───────────────────────────────────────────────────────

/**
 * Extract the value of a top-level scalar key, returning the raw string
 * (un-quoted). For multi-line / sequence values, returns the joined raw
 * text after the colon — callers that need structured access should
 * parse that themselves.
 *
 * Returns `undefined` when the key is absent or the file has no
 * frontmatter.
 */
export function readFrontmatterScalar(content: string, key: string): string | undefined {
  const split = splitFrontmatter(content);
  if (!split.hasFrontmatter) return undefined;
  const blocks = parseFrontmatterBlocks(split.frontmatterLines);
  const block = blocks.find((b) => b.key === key);
  if (!block) return undefined;
  if (block.lines.length === 0) return undefined;
  const first = block.lines[0];
  const m = first.match(/^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*(.*)$/);
  if (!m) return undefined;
  let value = m[1].trim();
  if (
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
  ) {
    value = value.slice(1, -1);
    // Un-double single quotes (YAML 1.2 single-quoted escape).
    if (first.includes(": '")) value = value.replace(/''/g, "'");
  }
  return value;
}
