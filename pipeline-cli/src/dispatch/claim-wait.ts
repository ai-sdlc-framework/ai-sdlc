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

/**
 * One watcher on `queueDir`, opened before the first claim attempt and reused for the
 * whole wait: a change that lands after a claim attempt (or while no wait is pending)
 * is remembered and wakes the next wait at once.
 */
function openQueueWatch(queueDir: string): {
  wait: (ms: number) => Promise<void>;
  close: () => void;
} {
  let changed = false;
  let wake: (() => void) | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  const signal = (): void => {
    changed = true;
    wake?.();
  };
  try {
    watcher = watch(queueDir, { persistent: true }, signal);
    watcher.on('error', signal);
  } catch {
    /* no watch support here: the poll floor still wakes us */
  }
  return {
    wait: (ms) =>
      new Promise<void>((resolve) => {
        if (changed) {
          changed = false;
          resolve();
          return;
        }
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          wake = undefined;
          changed = false;
          resolve();
        }
        wake = done;
      }),
    close: () => watcher?.close(),
  };
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
  if (!existsSync(queueDir)) ensureBoardDirs(boardDir);
  // Watch first, then claim: an enqueue between a failed claim and the wait is not missed.
  const queueWatch = openQueueWatch(queueDir);
  try {
    for (;;) {
      const result = claim(boardDir, workerKind, opts.workerId);
      if (result.claimed) return result;
      const remaining = deadline - nowMs();
      if (remaining <= 0) return result;
      await queueWatch.wait(Math.min(pollMs, remaining));
    }
  } finally {
    queueWatch.close();
  }
}
