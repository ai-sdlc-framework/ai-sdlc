/**
 * Five-step review check (AISDLC-804, DEC-0090). Deterministic, no model
 * call. Owned by Gate 2 (required content in the body).
 *
 * A task that fixes a failure or adds a rule (label in FIVE_STEP_LABELS, or
 * a title starting with `fix`) must carry a paragraph starting with
 * `**Five-step review` that names a deletion ("Delete", "Deleted" or
 * "nothing to delete"). A `blocked.reason` in frontmatter overrides, as for
 * the other gates.
 */

import type { IssueInput } from '../types.js';

export const FIVE_STEP_LABELS = [
  'bug',
  'fix',
  'stability',
  'root-cause',
  'governance',
  'hooks',
  'ci',
] as const;

export const FIVE_STEP_QUESTION =
  'Add a paragraph starting "**Five-step review (requirements first)**" that walks the five steps in order: ' +
  '1. question the requirement (name who or what decision set it), 2. delete the part or process ' +
  '(say what is deleted, or "nothing to delete" and why), 3. simplify or optimise, 4. accelerate cycle time, 5. automate.';

export function requiresFiveStepReview(input: IssueInput): boolean {
  if (/^\s*fix/i.test(input.title)) return true;
  const labels = (input.labels ?? []).map((l) => l.toLowerCase());
  return labels.some((l) => (FIVE_STEP_LABELS as readonly string[]).includes(l));
}

/** Returns a finding string when the paragraph is missing or incomplete, else null. */
export function checkFiveStepReview(input: IssueInput): string | null {
  if (!requiresFiveStepReview(input) || input.blockedReason) return null;
  const paragraph = input.body.match(/^\s*\*\*Five-step review[\s\S]*?(?:\n\s*\n|$)/im);
  if (!paragraph) {
    return 'Fix/rule task has no "**Five-step review" paragraph.';
  }
  if (!/\bdelet(e|ed|ion)\b|nothing to delete/i.test(paragraph[0])) {
    return 'The "**Five-step review" paragraph does not name a deletion ("Delete", "Deleted" or "nothing to delete").';
  }
  return null;
}
