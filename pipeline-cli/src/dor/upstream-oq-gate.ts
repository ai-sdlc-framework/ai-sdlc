/**
 * DoR upstream-OQ gate (AISDLC-296 / RFC-0011 extension).
 *
 * Closes the governance gap surfaced by AISDLC-269/270/271: implementation
 * tasks were filed and dispatched against RFCs that still had unresolved
 * Open Questions because the DoR gate only checked task-level clarification
 * readiness, not upstream RFC OQ status.
 *
 * ## Gate rules
 *
 * A task is blocked when it references an RFC (via `references:` frontmatter
 * or via body text matching `RFC-NNNN`) AND:
 *   a) the referenced RFC's `lifecycle:` field is `Draft` or
 *      `Ready for Review` (not `Signed Off` or `Implemented`), OR
 *   b) the RFC's §OQ section contains at least one unresolved OQ
 *      (no `Resolution:` marker on the question).
 *
 * ## Manual override
 *
 * A task with `blocked.reason` in its frontmatter (explicit operator note)
 * is grandfathered — the upstream OQ check is skipped and the task is
 * treated as intentionally-acknowledged. This prevents the gate from
 * retroactively blocking in-flight tasks that the operator already reviewed.
 *
 * ## Event
 *
 * Every rejection emits a `DorRejectedByOpenUpstreamOq` event record
 * (returned in the `UpstreamOqCheckResult`). The calibration log caller is
 * responsible for persisting it; this module is side-effect-free on the
 * filesystem.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle states that BLOCK dispatching impl tasks. */
export const BLOCKED_LIFECYCLES = new Set<string>(['Draft', 'Ready for Review']);

/** Lifecycle states that ALLOW dispatching impl tasks. */
export const ALLOWED_LIFECYCLES = new Set<string>(['Signed Off', 'Implemented', 'Superseded']);

export interface RfcOqCheckInput {
  /** Stable RFC identifier (e.g. 'RFC-0024'). */
  rfcId: string;
  /** Resolved path to the RFC file on disk. */
  rfcFilePath: string;
  /**
   * Optional — RFC body text, pre-loaded. When omitted the gate reads
   * `rfcFilePath` from disk. Callers with the content already in memory
   * (tests, ingress shims) pass it to avoid duplicate I/O.
   */
  rfcContent?: string;
}

export interface RfcOqCheckResult {
  rfcId: string;
  /** Resolved lifecycle value from RFC frontmatter. 'unknown' when absent. */
  lifecycle: string;
  /**
   * Whether the lifecycle is in the blocked set (Draft / Ready for Review).
   * Note: even an `Implemented` RFC can still have open OQs (editing
   * oversight), so lifecycle and OQ checks are independent gates.
   */
  lifecycleBlocked: boolean;
  /** Number of unresolved OQs in the RFC body. */
  unresolvedOqCount: number;
  /** Summary of unresolved OQ headings (up to 5 for brevity). */
  unresolvedOqSample: string[];
  /** True when either lifecycleBlocked or unresolvedOqCount > 0. */
  rejected: boolean;
}

export interface UpstreamOqCheckInput {
  /** Task identifier (e.g. 'AISDLC-270'). Used only for event attribution. */
  taskId: string;
  /** Raw frontmatter text of the task (YAML, without the `---` delimiters). */
  frontmatter: string;
  /**
   * Markdown body of the task (without frontmatter). Used to extract bare
   * `RFC-NNNN` references that aren't already in the `references:` list.
   */
  body: string;
  /** Project root — used to resolve RFC file paths. */
  workDir: string;
  /**
   * Override the RFC loader — useful in tests to avoid filesystem I/O.
   * Receives the resolved RFC file path and returns the RFC content string,
   * or `null` when the file is not found.
   */
  readRfcFile?: (filePath: string) => string | null;
}

/** Event emitted when the gate rejects a task. */
export interface DorRejectedByOpenUpstreamOqEvent {
  eventType: 'DorRejectedByOpenUpstreamOq';
  taskId: string;
  rfcRef: string;
  openOqCount: number;
  lifecycleBlocked: boolean;
  lifecycle: string;
}

export interface UpstreamOqCheckResult {
  /** Whether the task is rejected by the upstream OQ gate. */
  rejected: boolean;
  /**
   * True when the task has an explicit `blocked.reason` in frontmatter —
   * the gate was intentionally skipped (manual override).
   */
  manualOverride: boolean;
  /** Manual override reason text, when present. */
  overrideReason?: string;
  /** Per-RFC check results for all referenced RFCs. */
  rfcChecks: RfcOqCheckResult[];
  /** Events to persist to the caller's event log. Non-empty when rejected. */
  events: DorRejectedByOpenUpstreamOqEvent[];
  /**
   * Human-readable rejection summary. Non-empty only when `rejected` is
   * true. Intended for use in comment-loop / refusal messages.
   */
  rejectionSummary?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the `lifecycle:` field from an RFC's YAML frontmatter.
 * Returns `'unknown'` when the field is absent or the frontmatter is
 * malformed. No full YAML parser — the field is always a simple scalar.
 */
export function extractRfcLifecycle(rfcContent: string): string {
  const fmMatch = rfcContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return 'unknown';
  const fm = fmMatch[1] ?? '';
  const lifecycleMatch = fm.match(/^lifecycle:\s*(.+?)\s*$/m);
  if (!lifecycleMatch) return 'unknown';
  const raw = lifecycleMatch[1] ?? '';
  // Strip surrounding quotes.
  return raw.replace(/^['"]|['"]$/g, '');
}

/**
 * Extract the `blocked.reason` value from a task's YAML frontmatter text
 * (the content between `---` delimiters, without the delimiters themselves).
 *
 * Supports both inline form:
 *   blocked:
 *     reason: 'some text'
 *
 * and single-line (rare) form:
 *   blocked: { reason: 'some text' }
 *
 * Returns `null` when absent.
 */
export function extractBlockedReason(frontmatter: string): string | null {
  // Two-line form: `blocked:` followed by `  reason: ...`
  const twoLine = frontmatter.match(/^blocked:\s*\n\s+reason:\s*(.+?)\s*$/m);
  if (twoLine) {
    const raw = twoLine[1] ?? '';
    return raw.replace(/^['"]|['"]$/g, '') || null;
  }
  // Inline braces form: `blocked: { reason: '...' }`
  const inline = frontmatter.match(/^blocked:\s*\{[^}]*reason:\s*(.+?)\s*\}/m);
  if (inline) {
    const raw = inline[1] ?? '';
    return raw.replace(/^['"]|['"]$/g, '') || null;
  }
  return null;
}

/**
 * Extract `references:` list entries from a task's YAML frontmatter.
 * Returns only entries that look like RFC file paths
 * (`spec/rfcs/RFC-NNNN-*.md`) or bare RFC IDs (`RFC-NNNN`).
 */
export function extractRfcReferences(frontmatter: string): string[] {
  const refs: string[] = [];
  // Match list items under the references: key. Collect until we hit a
  // non-list line at the same or lesser indentation.
  const refsSection = frontmatter.match(/^references:\n((?:\s+-\s+.+\n?)*)/m);
  if (!refsSection) return refs;
  const lines = refsSection[1]?.split('\n') ?? [];
  for (const line of lines) {
    const item = line.replace(/^\s+-\s+/, '').trim();
    if (!item) continue;
    // Accept spec/rfcs/RFC-NNNN-*.md paths
    if (/^spec\/rfcs\/RFC-\d{4}/.test(item)) {
      refs.push(item);
      continue;
    }
    // Accept bare RFC-NNNN identifiers
    if (/^RFC-\d{4}$/.test(item)) {
      refs.push(item);
    }
  }
  return refs;
}

/**
 * Extract bare `RFC-NNNN` identifiers from a markdown body.
 * Returns deduplicated list.
 */
export function extractRfcIdsFromBody(body: string): string[] {
  const ids = new Set<string>();
  const matches = body.matchAll(/\bRFC-(\d{4})\b/g);
  for (const m of matches) {
    ids.add(`RFC-${m[1]}`);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// RFC file resolution
// ---------------------------------------------------------------------------

/**
 * Find the RFC file path for a given RFC ID in the `spec/rfcs/` directory.
 * Handles both:
 *   - bare IDs: `RFC-0024` → `spec/rfcs/RFC-0024-*.md`
 *   - relative paths: `spec/rfcs/RFC-0024-*.md` (pass-through after normalization)
 *
 * Returns `null` when no match is found.
 */
export function resolveRfcFilePath(rfcRef: string, workDir: string): string | null {
  const rfcDir = join(workDir, 'spec', 'rfcs');
  if (!existsSync(rfcDir)) return null;

  // Already a path: normalize to filename and search.
  let rfcId: string;
  if (rfcRef.startsWith('spec/rfcs/')) {
    const filename = rfcRef.replace('spec/rfcs/', '');
    const full = join(rfcDir, filename);
    if (existsSync(full)) return full;
    // Try prefix match (the filename might be a glob-like pattern without the full slug).
    rfcId = filename.match(/^(RFC-\d{4})/i)?.[1]?.toUpperCase() ?? '';
  } else {
    rfcId = rfcRef.match(/^(RFC-\d{4})/i)?.[1]?.toUpperCase() ?? '';
  }

  if (!rfcId) return null;

  try {
    const files = readdirSync(rfcDir);
    const match = files.find((f) => f.toUpperCase().startsWith(rfcId) && f.endsWith('.md'));
    return match ? join(rfcDir, match) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OQ section scanner
// ---------------------------------------------------------------------------

/**
 * RFC section headings that contain open questions.
 * We match both Markdown `## N. Open Questions` and
 * plain `## Open Questions` (heading text only, level 2 or 3).
 */
const OQ_SECTION_RE = /^#{2,3}\s+(?:\d+\.\s+)?Open Questions\s*$/im;

/**
 * A question line inside the OQ section. Matches numbered list items
 * (`1. Q1 — ...`, `**OQ-1 — ...**`, `OQ-1 — ...`, `Q1: ...`) that look
 * like a question heading (not an inline bullet inside a resolution).
 *
 * Deliberately conservative — we look for lines that START a new question
 * record, not lines that are part of a resolution block.
 */
const OQ_QUESTION_RE = /^(?:\*\*)?(?:OQ-\d+|Q\d+|\d+\.)[\s\-—:*]+(.+?)(?:\*\*)?$/im;

/**
 * Resolution marker patterns. An OQ is considered resolved when its
 * associated section contains one of these patterns on a separate line.
 */
const RESOLUTION_MARKERS = [
  /\*\*Resolution[:\s]/i,
  /^Resolution[:\s]/im,
  /✅\s*RESOLVED/i,
  /RESOLVED[:\s]/i,
];

/**
 * Scan the §OQ section of an RFC body for unresolved open questions.
 *
 * Strategy:
 *   1. Find the OQ section heading.
 *   2. Collect text until the next same-level heading.
 *   3. Split into per-question blocks.
 *   4. For each block, check whether a resolution marker is present.
 *
 * Returns an array of unresolved OQ heading strings.
 */
export function findUnresolvedOqs(rfcContent: string): string[] {
  const sectionMatch = rfcContent.match(OQ_SECTION_RE);
  if (!sectionMatch || sectionMatch.index === undefined) return [];

  // Grab everything after the OQ heading until the next ## heading.
  const after = rfcContent.slice(sectionMatch.index + sectionMatch[0].length);
  const nextHeadingMatch = after.match(/^#{2,3}\s/m);
  const oqSectionText = nextHeadingMatch ? after.slice(0, nextHeadingMatch.index) : after;

  // Split the OQ section into per-question blocks by finding question
  // headings and taking everything up to the next question heading.
  const lines = oqSectionText.split('\n');
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const qMatch = line.match(OQ_QUESTION_RE);
    if (qMatch) {
      if (current) blocks.push(current);
      current = { heading: line.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  // For each block, check if a resolution marker appears in the block text.
  const unresolved: string[] = [];
  for (const block of blocks) {
    const blockText = block.lines.join('\n');
    const hasResolution = RESOLUTION_MARKERS.some((re) => re.test(blockText));
    if (!hasResolution) {
      unresolved.push(block.heading);
    }
  }

  return unresolved;
}

// ---------------------------------------------------------------------------
// Per-RFC check
// ---------------------------------------------------------------------------

/**
 * Check a single RFC for lifecycle and OQ readiness.
 */
export function checkRfc(input: RfcOqCheckInput): RfcOqCheckResult {
  const content =
    input.rfcContent ??
    (() => {
      if (!existsSync(input.rfcFilePath)) return null;
      try {
        return readFileSync(input.rfcFilePath, 'utf8');
      } catch {
        return null;
      }
    })();

  if (content === null) {
    // RFC file not found — treat as unknown lifecycle, no OQ data.
    return {
      rfcId: input.rfcId,
      lifecycle: 'unknown',
      lifecycleBlocked: false,
      unresolvedOqCount: 0,
      unresolvedOqSample: [],
      rejected: false,
    };
  }

  const lifecycle = extractRfcLifecycle(content);
  const lifecycleBlocked = BLOCKED_LIFECYCLES.has(lifecycle);
  const unresolvedOqs = findUnresolvedOqs(content);
  const unresolvedOqCount = unresolvedOqs.length;
  const unresolvedOqSample = unresolvedOqs.slice(0, 5).map((h) => h.slice(0, 120));
  const rejected = lifecycleBlocked || unresolvedOqCount > 0;

  return {
    rfcId: input.rfcId,
    lifecycle,
    lifecycleBlocked,
    unresolvedOqCount,
    unresolvedOqSample,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// Main gate
// ---------------------------------------------------------------------------

/**
 * Run the upstream-OQ gate against a backlog task.
 *
 * 1. Extract all RFC references from frontmatter + body.
 * 2. If the task has a `blocked.reason`, skip the gate (manual override).
 * 3. For each RFC reference, check lifecycle + OQ status.
 * 4. Aggregate and return the result.
 */
export function checkUpstreamOqs(input: UpstreamOqCheckInput): UpstreamOqCheckResult {
  // Manual override: operator acknowledged the OQ status.
  const overrideReason = extractBlockedReason(input.frontmatter);
  if (overrideReason) {
    return {
      rejected: false,
      manualOverride: true,
      overrideReason,
      rfcChecks: [],
      events: [],
    };
  }

  // Collect all RFC references (deduplicated).
  const fromFrontmatter = extractRfcReferences(input.frontmatter);
  const fromBody = extractRfcIdsFromBody(input.body);
  const allRefs = deduplicate([...fromFrontmatter, ...fromBody]);

  if (allRefs.length === 0) {
    return {
      rejected: false,
      manualOverride: false,
      rfcChecks: [],
      events: [],
    };
  }

  const rfcChecks: RfcOqCheckResult[] = [];
  const events: DorRejectedByOpenUpstreamOqEvent[] = [];

  for (const ref of allRefs) {
    const rfcId = normalizeRfcId(ref);
    const rfcFilePath = resolveRfcFilePath(ref, input.workDir) ?? '';

    // When a readRfcFile override is provided (tests), call it with the
    // resolved file path when available, otherwise fall back to the original
    // ref string so test doubles keyed on ref names (e.g. containing
    // 'RFC-9903') still match.
    const rfcContent = input.readRfcFile
      ? (input.readRfcFile(rfcFilePath || ref) ?? undefined)
      : undefined;

    const check = checkRfc({ rfcId, rfcFilePath, rfcContent });
    rfcChecks.push(check);

    if (check.rejected) {
      events.push({
        eventType: 'DorRejectedByOpenUpstreamOq',
        taskId: input.taskId,
        rfcRef: ref,
        openOqCount: check.unresolvedOqCount,
        lifecycleBlocked: check.lifecycleBlocked,
        lifecycle: check.lifecycle,
      });
    }
  }

  const rejected = rfcChecks.some((c) => c.rejected);
  const rejectionSummary = rejected ? buildRejectionSummary(rfcChecks) : undefined;

  return {
    rejected,
    manualOverride: false,
    rfcChecks,
    events,
    rejectionSummary,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRfcId(ref: string): string {
  // From path: spec/rfcs/RFC-0024-foo.md → RFC-0024
  const match = ref.match(/RFC-(\d{4})/i);
  if (match) return `RFC-${match[1]}`;
  return ref;
}

function deduplicate(refs: string[]): string[] {
  // Deduplicate by normalized RFC id so `spec/rfcs/RFC-0024-foo.md` and
  // `RFC-0024` don't produce two checks for the same RFC.
  const seen = new Map<string, string>();
  for (const ref of refs) {
    const id = normalizeRfcId(ref);
    if (!seen.has(id)) seen.set(id, ref);
  }
  return [...seen.values()];
}

function buildRejectionSummary(checks: RfcOqCheckResult[]): string {
  const parts: string[] = [];
  for (const c of checks) {
    if (!c.rejected) continue;
    const reasons: string[] = [];
    if (c.lifecycleBlocked) {
      reasons.push(`lifecycle is '${c.lifecycle}' (not Signed Off or Implemented)`);
    }
    if (c.unresolvedOqCount > 0) {
      reasons.push(
        `${c.unresolvedOqCount} unresolved OQ(s): ${c.unresolvedOqSample.slice(0, 3).join('; ')}`,
      );
    }
    parts.push(`${c.rfcId}: ${reasons.join('; ')}`);
  }
  return (
    `DoR upstream-OQ gate blocked — referenced RFC(s) have open OQs or are not Signed Off. ` +
    `Resolve these before dispatching: ${parts.join(' | ')}. ` +
    `Override by adding \`blocked.reason\` to the task's frontmatter with an explicit operator note.`
  );
}
