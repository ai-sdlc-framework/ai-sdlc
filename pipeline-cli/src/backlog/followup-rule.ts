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
  reason: 'no-tracked-id' | 'declined-without-reason' | 'item-too-large';
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
/** Items longer than this are rejected before any regex runs (bounds backtracking). */
const MAX_ITEM_LENGTH = 4096;
const DISPLAY_LENGTH = 200;

/** `### Follow-up` / `## Follow-ups` (with optional trailing qualifier). */
const HEADING_RE = /^(#{2,4})\s+follow-?ups?\b.*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+\S/;
/** Backlog.md section markers, e.g. `<!-- SECTION:FINAL_SUMMARY:END -->`. */
const SECTION_MARKER_RE = /^\s*<!--\s*SECTION:[A-Z_]+:(?:BEGIN|END)\s*-->\s*$/;
/** A line holding nothing but HTML comments. */
const COMMENT_ONLY_RE = /^\s*(?:<!--.*?-->\s*)+$/;
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

/** Bodies of every Follow-up section (a document may hold several). */
function extractSections(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const sections: string[][] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    const body: string[] = [];
    let fence = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (FENCE_RE.test(line)) fence = !fence;
      else if (!fence) {
        if (SECTION_MARKER_RE.test(line)) break;
        const h = ANY_HEADING_RE.exec(line);
        if (h && h[1].length <= level) break;
      }
      if (!fence && COMMENT_ONLY_RE.test(line)) continue;
      body.push(line);
    }
    sections.push(body);
    i = j - 1;
  }
  return sections;
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
    const isMarker = LIST_MARKER_RE.test(line);
    if (isMarker && current && currentIsList && /^\s+/.test(line)) {
      // Nested sub-bullet: belongs to its parent item (the parent must cite).
      current.push(line.replace(LIST_MARKER_RE, '').trim());
    } else if (isMarker) {
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
  const sections = extractSections(markdown);
  const idRe = taskIdRegExp(options.taskPrefix ?? DEFAULT_TASK_PREFIX);
  const violations: FollowupViolation[] = [];
  const raws = sections.flatMap((body) => toItems(body));
  for (const raw of raws) {
    if (raw.length > MAX_ITEM_LENGTH) {
      violations.push({ item: `${raw.slice(0, DISPLAY_LENGTH)}...`, reason: 'item-too-large' });
      continue;
    }
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
      `  - "${v.item}"${
        v.reason === 'declined-without-reason'
          ? ' (declined: needs a reason of at least 10 characters)'
          : v.reason === 'item-too-large'
            ? ' (item is too long; split it into short items)'
            : ''
      }`,
    );
  }
  out.push('');
  out.push('A follow-up that is only prose is never acted on. Each item must be one of:');
  out.push(`  1. Tracked work: cite a task id (e.g. ${prefix}-123) or an issue reference.`);
  out.push(
    '     Write issue references as #123 or owner/repo#123 (not as URLs); a bare URL does not count.',
  );
  out.push('  2. None: make the whole section read "(none)".');
  out.push('  3. Declined: start the item with "declined:" followed by a reason (10+ characters).');
  return out.join('\n');
}
