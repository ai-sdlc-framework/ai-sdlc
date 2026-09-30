/**
 * Follow-up rule for completed backlog tasks.
 *
 * A follow-up written as prose in a Final Summary is read by nobody, so the
 * work it names is silently dropped. In a task's `Follow-up` section every item
 * must therefore be tracked work, an explicit "none", or an explicit refusal.
 *
 * This is the single implementation of the rule. It is consumed by the
 * pre-push script (`scripts/check-followups.mjs`, via the built `dist/`) and by
 * the plugin's `task_complete` tool (via the package barrel), so both surfaces
 * accept and reject exactly the same text and print exactly the same message.
 */

export interface FollowupViolation {
  /** The offending item, trimmed and with list markers removed. */
  item: string;
  /** Why it was rejected. */
  reason: 'no-tracked-id' | 'declined-without-reason';
}

export interface FollowupCheckOptions {
  /** Backlog task-id prefix for this project (default `AISDLC`). */
  taskPrefix?: string;
}

export interface FollowupCheckResult {
  ok: boolean;
  violations: FollowupViolation[];
}

const DEFAULT_TASK_PREFIX = 'AISDLC';
const MIN_DECLINE_REASON_LENGTH = 10;

/** `### Follow-up` / `## Follow-ups` (with optional trailing qualifier). */
const HEADING_RE = /^(#{2,4})\s+follow-?ups?\b.*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
const FENCE_RE = /^\s*(```|~~~)/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
/** GitHub issue reference: `#123`, `owner/repo#123`. */
const ISSUE_REF_RE = /(?:^|[^\w&])(?:[\w.-]+\/[\w.-]+)?#\d+\b/;
const DECLINED_RE = /^declined:\s*(.*)$/is;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function taskIdRegExp(prefix: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(prefix)}-\\d+(?:\\.\\d+)*(?![A-Za-z0-9])`, 'i');
}

/** Lines of the Follow-up section body, or null when there is no such section. */
function extractSection(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) {
      start = i + 1;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  inFence = false;
  for (let i = start; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence;
    else if (!inFence) {
      const h = ANY_HEADING_RE.exec(lines[i]);
      if (h && h[1].length <= level) break;
    }
    body.push(lines[i]);
  }
  return body;
}

/** Group section lines into items: one per list entry, one per paragraph. */
function toItems(body: string[]): string[] {
  const items: string[] = [];
  let current: string[] | null = null;
  let currentIsList = false;
  const flush = (): void => {
    if (current) items.push(current.join(' ').replace(/\s+/g, ' ').trim());
    current = null;
    currentIsList = false;
  };
  for (const line of body) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (LIST_MARKER_RE.test(line)) {
      flush();
      current = [line.replace(LIST_MARKER_RE, '')];
      currentIsList = true;
    } else if (current && (currentIsList ? /^\s+/.test(line) : true)) {
      current.push(line.trim());
    } else {
      flush();
      current = [line.trim()];
    }
  }
  flush();
  return items.filter((s) => s.length > 0);
}

function stripEmphasis(s: string): string {
  return s.replace(/^[*_`\s]+|[*_`\s]+$/g, '');
}

/**
 * Check the `Follow-up` section of a markdown document (a whole task file or a
 * bare Final Summary). Absent section, or one whose only content is `(none)`,
 * passes.
 */
export function checkFollowups(
  markdown: string,
  options: FollowupCheckOptions = {},
): FollowupCheckResult {
  const body = extractSection(markdown);
  if (!body) return { ok: true, violations: [] };

  const idRe = taskIdRegExp(options.taskPrefix ?? DEFAULT_TASK_PREFIX);
  const violations: FollowupViolation[] = [];
  for (const raw of toItems(body)) {
    const item = stripEmphasis(raw);
    if (/^\(?none\)?\.?$/i.test(item)) continue;
    const declined = DECLINED_RE.exec(item);
    if (declined) {
      if (declined[1].trim().length >= MIN_DECLINE_REASON_LENGTH) continue;
      violations.push({ item: raw, reason: 'declined-without-reason' });
      continue;
    }
    if (idRe.test(item) || ISSUE_REF_RE.test(item)) continue;
    violations.push({ item: raw, reason: 'no-tracked-id' });
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Human-readable rejection text. Quotes every offending item and lists the
 * three accepted forms. Carries no internal identifiers.
 */
export function formatFollowupViolations(
  violations: readonly FollowupViolation[],
  options: FollowupCheckOptions & { file?: string } = {},
): string {
  const prefix = options.taskPrefix ?? DEFAULT_TASK_PREFIX;
  const out: string[] = [];
  out.push(
    options.file
      ? `Follow-up section in ${options.file} has ${violations.length} untracked item(s):`
      : `Follow-up section has ${violations.length} untracked item(s):`,
  );
  for (const v of violations) {
    out.push(
      `  - "${v.item}"${v.reason === 'declined-without-reason' ? ' (declined: needs a reason of at least 10 characters)' : ''}`,
    );
  }
  out.push('');
  out.push('A follow-up that is only prose is never acted on. Each item must be one of:');
  out.push(
    `  1. Tracked work: cite a task id (e.g. ${prefix}-123) or an issue reference (e.g. #123).`,
  );
  out.push('  2. None: make the whole section read "(none)".');
  out.push('  3. Declined: start the item with "declined:" followed by a reason (10+ characters).');
  return out.join('\n');
}
