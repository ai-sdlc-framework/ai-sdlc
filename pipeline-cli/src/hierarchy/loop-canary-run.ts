/**
 * `cli-hierarchy canary run --no-pr` (AISDLC-1102): start one canary run and wait for it to
 * end, polling the board. The dispatch tick records the verdict and clears the executor; this
 * command only watches. Exit 0 on a pass record, 1 on a failure record or a refusal.
 */

import { readHold } from './hold.js';
import {
  advanceCanaryRun,
  listCanaryRuns,
  CANARY_DEFAULT_DEADLINES_MS,
  runningCanary,
  startCanaryRun,
  type CanaryStage,
  type StartDeps,
} from './loop-canary.js';

/** Default spacing of board polls. */
export const CANARY_POLL_MS = 5_000;

/** Collaborators of {@link runLoopCanaryCommand}. */
export interface RunDeps extends StartDeps {
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Sends the failure message to the planner; a failure to send is ignored. */
  notifyPlanner?: (text: string) => void;
  pollMs?: number;
  deadlinesMs?: Record<CanaryStage, number>;
}

/** Run the canary to its pass or failure record. */
export async function runLoopCanaryCommand(deps: RunDeps): Promise<number> {
  const held = readHold(deps.boardDir);
  if (held) {
    deps.log(JSON.stringify({ ok: false, refused: `the board is held: ${held.reason}` }));
    return 1;
  }
  if (runningCanary(deps.boardDir)) {
    deps.log(JSON.stringify({ ok: false, refused: 'a canary run is already in flight' }));
    return 1;
  }
  const deadlines = deps.deadlinesMs ?? CANARY_DEFAULT_DEADLINES_MS;
  let run = startCanaryRun(deps);
  for (;;) {
    await deps.sleep(deps.pollMs ?? CANARY_POLL_MS);
    // The dispatch tick advances the same run; take its record when it ended it first.
    const stored = listCanaryRuns(deps.boardDir).find((x) => x.runId === run.runId);
    if (stored && stored.status !== 'running') run = stored;
    const r = advanceCanaryRun(deps.boardDir, run, deps.now(), deadlines);
    run = r.run;
    if (run.status !== 'running') {
      const message =
        r.message ??
        (run.status === 'fail'
          ? `hierarchy loop canary FAILED at ${run.failedStage} (${run.runId}): ${run.reason}`
          : undefined);
      if (run.status === 'fail' && message && r.finished) {
        try {
          deps.notifyPlanner?.(message);
        } catch {
          /* the failure record is the source of truth */
        }
      }
      deps.log(JSON.stringify({ ok: run.status === 'pass', run, ...(message ? { message } : {}) }));
      return run.status === 'pass' ? 0 : 1;
    }
  }
}
