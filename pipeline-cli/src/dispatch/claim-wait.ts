/**
 * `cli-dispatch claim --wait <sec>`: claim the next eligible manifest, blocking
 * until one can be claimed or the wait lapses.
 *
 * An idle executor makes no model calls while this blocks. It wakes on a change
 * to `queue/` (`fs.watch`) and, because a watch can miss events and a manifest can
 * become eligible without the queue changing (a dependency moved to `done/`), also
 * re-checks on a fixed poll floor.
 */

import { existsSync, watch } from 'node:fs';
import path from 'node:path';

import { claimNext, ensureBoardDirs } from './board.js';
import type { ClaimResult, WorkerKind } from './types.js';

/** Longest the poll floor may be: an enqueue is noticed at least this often. */
export const DEFAULT_CLAIM_POLL_MS = 2000;

/** Inputs of {@link claimWithWait}. */
export interface ClaimWaitOptions {
  /** Seconds to wait for an eligible manifest; 0 claims once and returns. */
  waitSec: number;
  workerId?: string;
  pollMs?: number;
  /** Replaces the claim (tests). */
  claim?: (boardDir: string, kind: WorkerKind, workerId?: string) => ClaimResult;
  /** Clock in milliseconds (tests). */
  nowMs?: () => number;
}

/** Resolve after `ms`, or earlier when `queueDir` changes. Never rejects. */
function waitForChange(queueDir: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let watcher: ReturnType<typeof watch> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      watcher?.close();
      resolve();
    };
    const timer = setTimeout(done, ms);
    try {
      watcher = watch(queueDir, { persistent: true }, done);
      watcher.on('error', done);
    } catch {
      /* no watch support here: the poll floor still wakes us */
    }
  });
}

/**
 * Claim the next eligible manifest, waiting up to `waitSec` seconds for one.
 * Returns the same result as {@link claimNext}; `{ claimed: false }` only after
 * the wait has lapsed.
 */
export async function claimWithWait(
  boardDir: string,
  workerKind: WorkerKind,
  opts: ClaimWaitOptions,
): Promise<ClaimResult> {
  const claim =
    opts.claim ??
    ((dir, kind, workerId) =>
      claimNext(dir, kind, undefined, workerId === undefined ? {} : { workerId }));
  const nowMs = opts.nowMs ?? Date.now;
  const pollMs = opts.pollMs ?? DEFAULT_CLAIM_POLL_MS;
  const deadline = nowMs() + opts.waitSec * 1000;
  const queueDir = path.join(boardDir, 'queue');
  for (;;) {
    const result = claim(boardDir, workerKind, opts.workerId);
    if (result.claimed) return result;
    const remaining = deadline - nowMs();
    if (remaining <= 0) return result;
    if (!existsSync(queueDir)) ensureBoardDirs(boardDir);
    await waitForChange(queueDir, Math.min(pollMs, remaining));
  }
}
