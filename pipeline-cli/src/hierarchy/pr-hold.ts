/**
 * AISDLC-1386: hold one PR open for a human. `cli-hierarchy pr-hold <pr> --reason <text>`
 * adds the `ai-sdlc/hold` label and posts the reason as a PR comment; `--clear` removes the
 * label. `cli-merge-if-eligible` and the reconciler read the label and never arm, flip or
 * merge a held PR.
 */

import { PR_HOLD_LABEL } from '../governance/merge-if-eligible.js';
import type { CommandRunner } from './types.js';

export interface PrHoldResult {
  ok: boolean;
  error?: string;
}

function failed(step: string, r: { status: number | null; stderr: string }): PrHoldResult {
  return { ok: false, error: `${step} failed: ${r.stderr.trim() || `exit ${String(r.status)}`}` };
}

/** Add (or, with `clear`, remove) the hold label on one PR and comment why. */
export function prHold(
  run: CommandRunner,
  cwd: string,
  pr: number,
  opts: { clear: boolean; reason?: string; by: string },
): PrHoldResult {
  const n = String(pr);
  if (!opts.clear) {
    // The label may not exist in an adopter repository yet; `--force` makes this idempotent.
    const created = run(
      'gh',
      [
        'label',
        'create',
        PR_HOLD_LABEL,
        '--color',
        'B60205',
        '--description',
        'Held for a human: never armed or merged by the pipeline',
        '--force',
      ],
      { cwd },
    );
    if (created.status !== 0) return failed('gh label create', created);
  }
  const edit = run(
    'gh',
    ['pr', 'edit', n, opts.clear ? '--remove-label' : '--add-label', PR_HOLD_LABEL],
    { cwd },
  );
  if (edit.status !== 0) return failed('gh pr edit', edit);
  const body = opts.clear
    ? `Hold lifted by ${opts.by}${opts.reason ? `: ${opts.reason}` : ''}. The pipeline may arm and merge this PR again.`
    : `Held by ${opts.by}: ${opts.reason ?? ''}\n\nLabel \`${PR_HOLD_LABEL}\`: the pipeline does not arm, flip or merge this PR until \`cli-hierarchy pr-hold ${n} --clear\`.`;
  const comment = run('gh', ['pr', 'comment', n, '--body', body], { cwd });
  if (comment.status !== 0) return failed('gh pr comment', comment);
  return { ok: true };
}
