/**
 * Spec-kit `tasks.md` parser.
 *
 * RFC-0036 Phase 4 (AISDLC-329). Reads spec-kit's `tasks.md` and produces
 * a list of structured task entries the import path can translate into
 * backlog tasks.
 *
 * Per OQ-1 the bridge reads `tasks.md` only — no fallback to `spec.md`.
 * Per OQ-11 the parser auto-detects the spec-kit schema version; an
 * unknown layout returns `schemaVersion: 'unknown'` and the import path
 * routes that through a `Decision: upstream-schema-unknown`.
 *
 * Tested layouts (spec-kit ≥ v0.8.x):
 *   ## Tasks
 *
 *   ### T-001 — <title>
 *   <body lines...>
 *
 *   ### T-002 — <title>
 *   ...
 *
 *   OR
 *
 *   - [ ] T-001 — <title>
 *     - AC: <criterion>
 *     - AC: <criterion>
 *
 * Both shapes are present in real spec-kit projects; v0.8 leans on the
 * `### T-NNN` heading form for `/speckit.tasks`, while older layouts use
 * the checkbox-list form.
 *
 * @module import-spec/parser
 */

export type SpecKitSchemaVersion = 'v0.8-headings' | 'v0.7-checkboxes' | 'unknown';

export interface SpecKitTaskEntry {
  /** Upstream task identifier — e.g. 'T-001'. */
  taskId: string;
  /** Human-readable task title. */
  title: string;
  /** Markdown body lines, joined with newlines, trimmed. */
  body: string;
  /** Acceptance criteria extracted from `AC:` / `- AC:` lines. */
  acceptanceCriteria: string[];
}

export interface ParseTasksMdResult {
  schemaVersion: SpecKitSchemaVersion;
  /** Empty when `schemaVersion === 'unknown'`. */
  entries: SpecKitTaskEntry[];
}

// Trailing title/AC text uses a greedy `(.+)$` (linear) rather than the lazy
// `(.+?)\s*$` form, whose lazy-capture-then-optional-trailing-whitespace overlap
// is polynomial (CodeQL js/polynomial-redos) on adversarial imported specs.
// Callers `.trim()` the captured group to preserve the prior trailing-strip.
const HEADING_RE = /^###\s+(T-\d+)\s*[—\-:]?\s*(.+)$/;
const CHECKBOX_RE = /^-\s*\[[ x]\]\s*(T-\d+)\s*[—\-:]?\s*(.+)$/i;
const AC_LINE_RE = /^\s*(?:-\s*)?AC:\s*(.+)$/i;
const TASKS_SECTION_RE = /^##\s+Tasks\s*$/i;

/**
 * Detect the spec-kit schema variant by scanning for the first task-shaped
 * line. Used both as a structural check (`unknown` means we can't parse
 * any task entries safely) and to drive the per-shape parser branch.
 */
export function detectSchema(source: string): SpecKitSchemaVersion {
  const lines = source.split('\n');
  for (const line of lines) {
    if (HEADING_RE.test(line)) return 'v0.8-headings';
    if (CHECKBOX_RE.test(line)) return 'v0.7-checkboxes';
  }
  return 'unknown';
}

/**
 * Parse the spec-kit `tasks.md` source into structured entries.
 *
 * When `schemaVersion` is `unknown` the caller MUST treat it as an
 * upstream-schema-mismatch and emit `Decision: upstream-schema-unknown`
 * via the Decision Catalog rather than producing zero tasks silently.
 */
export function parseTasksMd(source: string): ParseTasksMdResult {
  const schemaVersion = detectSchema(source);
  if (schemaVersion === 'unknown') return { schemaVersion, entries: [] };

  // Optionally narrow to a `## Tasks` section if present; not required.
  const lines = source.split('\n');
  let startIdx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (TASKS_SECTION_RE.test(lines[i])) {
      startIdx = i + 1;
      break;
    }
  }

  if (schemaVersion === 'v0.8-headings') {
    return { schemaVersion, entries: parseHeadings(lines, startIdx) };
  }
  return { schemaVersion, entries: parseCheckboxes(lines, startIdx) };
}

function parseHeadings(lines: string[], startIdx: number): SpecKitTaskEntry[] {
  const entries: SpecKitTaskEntry[] = [];
  let current: SpecKitTaskEntry | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      entries.push(current);
    }
    current = null;
  };

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flush();
      current = {
        taskId: headingMatch[1],
        title: headingMatch[2].trim(),
        body: '',
        acceptanceCriteria: [],
      };
      continue;
    }
    // Stop the current entry when a new top-level section starts.
    if (/^##\s+/.test(line) && !/^##\s+Tasks/i.test(line)) {
      flush();
      continue;
    }
    if (current) {
      const acMatch = AC_LINE_RE.exec(line);
      if (acMatch) {
        current.acceptanceCriteria.push(acMatch[1].trim());
      } else {
        current.body += line + '\n';
      }
    }
  }
  flush();
  return entries;
}

function parseCheckboxes(lines: string[], startIdx: number): SpecKitTaskEntry[] {
  const entries: SpecKitTaskEntry[] = [];
  let current: SpecKitTaskEntry | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      entries.push(current);
    }
    current = null;
  };

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    const cbMatch = CHECKBOX_RE.exec(line);
    if (cbMatch) {
      flush();
      current = {
        taskId: cbMatch[1],
        title: cbMatch[2].trim(),
        body: '',
        acceptanceCriteria: [],
      };
      continue;
    }
    if (/^##\s+/.test(line) && !/^##\s+Tasks/i.test(line)) {
      flush();
      continue;
    }
    if (current) {
      const acMatch = AC_LINE_RE.exec(line);
      if (acMatch) {
        current.acceptanceCriteria.push(acMatch[1].trim());
      } else if (line.trim().length > 0) {
        current.body += line.trim() + '\n';
      }
    }
  }
  flush();
  return entries;
}
