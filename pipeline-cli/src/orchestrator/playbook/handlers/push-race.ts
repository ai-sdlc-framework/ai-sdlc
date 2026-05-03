/**
 * `PushRaceWithMergeQueue` handler (RFC-0015 §5.1, row 2).
 *
 * Detection: `git push` rejected with `protected branch hook declined` AND
 * a `queued for merging` mention in stderr — the merge-queue rebased the
 * world while we were preparing to push.
 *
 * Remediation: sleep 60s + retry the push. If that fails the runner
 * retries up to `budget`. After all 3 attempts the escalator emits a
 * `MergeQueueStuck` advisory event but leaves the commit local — per
 * RFC §5.1 the orchestrator does NOT force-push around the queue.
 *
 * Budget: 3.
 */

import type { Handler, RemediationOutcome, WorkerContext, HandlerDeps } from '../types.js';

const PROTECTED_BRANCH_HOOK = /protected branch hook declined/i;
const MERGE_QUEUE_MENTION = /queued for merging|merge queue|merge_queue/i;

export const RETRY_DELAY_MS = 60_000;

export const pushRaceHandler: Handler = {
  mode: 'PushRaceWithMergeQueue',
  budget: 3,
  detect(ctx: WorkerContext): boolean {
    const stderr = ctx.failure.stderr;
    if (!stderr) return false;
    return PROTECTED_BRANCH_HOOK.test(stderr) && MERGE_QUEUE_MENTION.test(stderr);
  },
  async remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome> {
    // Budget enforced by playbook-runner — handler is per-attempt only.
    deps.logger.warn(
      `[playbook/push-race] sleep ${RETRY_DELAY_MS}ms then retry push for ${ctx.taskId} (attempt ${
        ctx.attempts + 1
      }/${this.budget})`,
    );
    await deps.sleep(RETRY_DELAY_MS);
    // Retry the push. We use --force-with-lease so a sibling rebase that
    // landed during the sleep doesn't clobber unseen commits. The branch
    // is the worker's branch — scoped per RFC §13 Q4.
    const push = await deps.runner('git', ['push', '--force-with-lease', 'origin', ctx.branch], {
      cwd: ctx.worktreePath,
      allowFailure: true,
    });
    if (push.code === 0) {
      return {
        status: 'recovered',
        nextState: 'FINALIZING',
        note: `push succeeded on attempt ${ctx.attempts + 1}`,
      };
    }
    // Still racing — the runner will re-call us until budget is exhausted.
    return {
      status: 'retry',
      nextState: 'REMEDIATE_PUSH_RACE',
      note: `push still rejected: ${push.stderr.slice(0, 200)}`,
    };
  },
};
