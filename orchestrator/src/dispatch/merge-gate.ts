/**
 * File-based merge gate per RFC-0010 §10. Single mutex (<pool>/.merge-gate.lock)
 * serializes the merge-eligibility/rebase step across parallel agents. Stale-base
 * detection + rebase-on-conflict per §10.2.
 *
 * Per project policy (feedback_never_merge_prs.md): the orchestrator MUST NOT execute
 * `gh pr merge`. The merge gate ensures a PR is in known-mergeable state when the
 * human reviewer hits merge — it does NOT perform the merge itself.
 */

import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const POLL_INTERVAL_MS = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export class MergeGateLockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`Timed out waiting for merge gate lock at ${lockPath}`);
    this.name = 'MergeGateLockTimeoutError';
  }
}

export interface MergeGateDeps {
  /** Override for tests. */
  now?: () => number;
}

/**
 * Acquire the merge gate, run `work`, release. The lock is a sentinel file; if it
 * already exists, the caller polls until it's released or the timeout elapses.
 *
 * Caveat: this is a cooperative file lock, not a kernel lock. Crashes can leave a
 * stale lock; the caller is expected to forcibly remove and retry as a recovery step.
 */
export async function withMergeGate<T>(
  poolDir: string,
  work: () => Promise<T>,
  options: { timeoutMs?: number } = {},
  deps: MergeGateDeps = {},
): Promise<T> {
  const lockPath = join(poolDir, '.merge-gate.lock');
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  await mkdir(dirname(lockPath), { recursive: true });

  // Acquire — exclusive create, polling until success or timeout.
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.write(`pid=${process.pid}\nat=${new Date().toISOString()}\n`);
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (now() - startedAt > timeoutMs) {
        throw new MergeGateLockTimeoutError(lockPath);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  try {
    return await work();
  } finally {
    // Best-effort release; if removal fails (lock file already gone), continue.
    await rm(lockPath, { force: true });
  }
}

/**
 * Force-remove a stale merge gate lock. Operators run this manually when an agent
 * crashed mid-merge-gate and the lock file is orphaned.
 */
export async function forceReleaseMergeGate(poolDir: string): Promise<void> {
  await rm(join(poolDir, '.merge-gate.lock'), { force: true });
}

/**
 * Test helper: write a sentinel lock file in an unexpected state (used by tests
 * verifying the timeout path).
 */
export async function _testWriteSentinel(poolDir: string): Promise<void> {
  const path = join(poolDir, '.merge-gate.lock');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'sentinel');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stale-base detection per RFC §10.2. Compares a branch's base SHA to the current
 * remote target's HEAD; returns true when the branch is up-to-date.
 *
 * The actual git logic is delegated to the caller via `headOfRemote` so this stays
 * unit-testable without shelling out.
 */
export async function isBranchUpToDate(
  branchBaseSha: string,
  targetBranch: string,
  headOfRemote: (target: string) => Promise<string>,
): Promise<boolean> {
  const head = await headOfRemote(targetBranch);
  return branchBaseSha === head;
}
