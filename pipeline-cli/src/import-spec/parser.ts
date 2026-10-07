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

// Each line shape is matched in two linear passes: an anchored prefix regex
// whose quantifiers cannot overlap, then a hand-rolled tail scan. The earlier
// single-regex form (`[ \t]*(.+)$`) let the optional whitespace and the title
// both consume tabs, which is polynomial backtracking on adversarial imported
// specs (CodeQL js/polynomial-redos). Callers .trim() captured text, as before.
const HEADING_PREFIX_RE = /^###[ \t]+(T-\d+)/;
const CHECKBOX_PREFIX_RE = /^-[ \t]*\[[ x]\][ \t]*(T-\d+)/i;
const AC_PREFIX_RE = /^[ \t]*(?:-[ \t]*)?AC:/i;
// `.` in the former regexes did not match these, so a line carrying one never matched.
const LINE_TERMINATOR_RE = /[\r\u2028\u2029]/;

function skipBlanks(line: string, from: number): number {
  let i = from;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return i;
}

/**
 * Capture the text after `pos`: blanks, then (when `withSeparator`) one
 * optional `—`, `-` or `:`, then blanks, then the rest of the line. When
 * nothing is left, the last consumed character becomes the capture, as the
 * backtracking regex did. Returns '' when `pos` is the end of the line, and null
 * when the tail holds a line terminator (the old regex never matched those).
 */
function captureTail(line: string, pos: number, withSeparator: boolean): string | null {
  let i = skipBlanks(line, pos);
  if (withSeparator && i < line.length && '—-:'.includes(line[i])) {
    i = skipBlanks(line, i + 1);
  }
  const rest = line.slice(i);
  if (LINE_TERMINATOR_RE.test(rest)) return null;
  if (rest.length > 0) return rest;
  return line.length > pos ? line.slice(-1) : '';
}

interface TaskLineMatch {
  taskId: string;
  title: string;
}

function matchTaskLine(prefixRe: RegExp, line: string): TaskLineMatch | null {
  const prefix = prefixRe.exec(line);
  if (!prefix) return null;
  const title = captureTail(line, prefix[0].length, true);
  if (title === null) return null;
  if (title !== '') return { taskId: prefix[1], title };
  // Nothing follows the id: the old regex gave its last digit back as the title.
  if (/\d{2}$/.test(prefix[1])) {
    return { taskId: prefix[1].slice(0, -1), title: prefix[1].slice(-1) };
  }
  return null;
}

const matchHeading = (line: string): TaskLineMatch | null => matchTaskLine(HEADING_PREFIX_RE, line);
const matchCheckbox = (line: string): TaskLineMatch | null =>
  matchTaskLine(CHECKBOX_PREFIX_RE, line);

function matchAcLine(line: string): string | null {
  const prefix = AC_PREFIX_RE.exec(line);
  return prefix ? captureTail(line, prefix[0].length, false) || null : null;
}
const TASKS_SECTION_RE = /^##\s+Tasks\s*$/i;

/**
 * Detect the spec-kit schema variant by scanning for the first task-shaped
 * line. Used both as a structural check (`unknown` means we can't parse
 * any task entries safely) and to drive the per-shape parser branch.
 */
export function detectSchema(source: string): SpecKitSchemaVersion {
  const lines = source.split('\n');
  for (const line of lines) {
    if (matchHeading(line)) return 'v0.8-headings';
    if (matchCheckbox(line)) return 'v0.7-checkboxes';
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
    const headingMatch = matchHeading(line);
    if (headingMatch) {
      flush();
      current = {
        taskId: headingMatch.taskId,
        title: headingMatch.title.trim(),
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
      const acMatch = matchAcLine(line);
      if (acMatch) {
        current.acceptanceCriteria.push(acMatch.trim());
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
    const cbMatch = matchCheckbox(line);
    if (cbMatch) {
      flush();
      current = {
        taskId: cbMatch.taskId,
        title: cbMatch.title.trim(),
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
      const acMatch = matchAcLine(line);
      if (acMatch) {
        current.acceptanceCriteria.push(acMatch.trim());
      } else if (line.trim().length > 0) {
        current.body += line.trim() + '\n';
      }
    }
  }
  flush();
  return entries;
}
