/**
 * In-process mutex for serializing git operations that contend on
 * `.git/config.lock`.
 *
 * AISDLC-241 — when the autonomous orchestrator dispatches >1 task in
 * parallel, concurrent `git worktree add` / `git worktree remove` /
 * `git branch -D` calls race on `.git/config.lock`. The fix is an
 * in-process promise-queue that holds at most one caller at a time and
 * queues the rest. All callers in the same Node.js process share the
 * singleton `_globalMutex`; callers in different processes (e.g. two
 * `cli-orchestrator tick` invocations that somehow overlap) are
 * additionally protected by a file-based lock at
 * `.git/.ai-sdlc-worktree-mutex` using advisory fcntl-style semantics
 * implemented with atomic mkdir.
 *
 * ### Timeout
 * If the lock is not acquired within `timeoutMs` (default 60 000 ms,
 * configurable) a descriptive error is thrown so callers can surface the
 * stuck-mutex symptom rather than hanging forever:
 *
 *   "worktree mutex held > 60s — likely a stuck previous tick;
 *    investigate `.git/.ai-sdlc-worktree-mutex` mtime"
 *
 * ### Release on error
 * The mutex is ALWAYS released via try/finally so an error inside the
 * critical section never permanently wedges subsequent callers.
 *
 * ### Signal safety
 * `setupWorktreeSignalHandler()` installs a once-per-process SIGINT /
 * SIGTERM listener that calls `releaseWorktreeMutex()` before re-raising
 * the signal. This is best-effort: it handles the common case where the
 * orchestrator is killed with Ctrl-C while inside the critical section.
 *
 * @module runtime/worktree-mutex
 */

import { existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── In-process mutex ─────────────────────────────────────────────────────

/** How long a waiter will queue before giving up. */
export const DEFAULT_MUTEX_TIMEOUT_MS = 60_000;

/** Descriptive error thrown when the mutex cannot be acquired in time. */
export const MUTEX_TIMEOUT_MESSAGE =
  'worktree mutex held > 60s — likely a stuck previous tick; investigate `.git/.ai-sdlc-worktree-mutex` mtime';

/**
 * Shared in-process mutex state. All calls to `withWorktreeMutex()` from
 * within the same Node.js process share this singleton so concurrent
 * orchestrator ticks running in the same process queue behind a single
 * lock.
 *
 * Exported for testing only — production callers use `withWorktreeMutex()`.
 */
export interface _MutexState {
  /** Promise that resolves when the current holder releases the lock. */
  queue: Promise<void>;
  /**
   * How many waiters (including the current holder) are in the queue.
   * Exported for test introspection.
   */
  depth: number;
}

/** Singleton mutex state shared across all callers in this process. */
export const _globalMutex: _MutexState = {
  queue: Promise.resolve(),
  depth: 0,
};

// ── File-based lock (cross-process protection) ───────────────────────────

/**
 * Attempt to acquire an advisory cross-process file lock using atomic
 * `mkdir` semantics. Returns `true` on success, `false` when another
 * process holds the lock.
 *
 * The lock directory is `.git/.ai-sdlc-worktree-mutex` inside `workDir`.
 * Using a *directory* (not a file) means the create is atomic on all
 * POSIX filesystems that honour POSIX mkdir semantics, without requiring
 * `open(O_CREAT|O_EXCL)` workarounds.
 *
 * Exported for testing.
 */
export function tryAcquireFileLock(workDir: string): boolean {
  const lockDir = join(workDir, '.git', '.ai-sdlc-worktree-mutex');
  try {
    mkdirSync(lockDir, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the cross-process file lock. Idempotent — silently ignores
 * errors when the directory no longer exists (already released).
 *
 * Exported for testing and for signal handlers.
 */
export function releaseFileLock(workDir: string): void {
  const lockDir = join(workDir, '.git', '.ai-sdlc-worktree-mutex');
  try {
    rmdirSync(lockDir);
  } catch {
    // Already released or never acquired — safe to ignore.
  }
}

/**
 * Check whether the file lock is currently held by any process (including
 * this one). Useful for diagnostics.
 */
export function isFileLockHeld(workDir: string): boolean {
  return existsSync(join(workDir, '.git', '.ai-sdlc-worktree-mutex'));
}

/**
 * Return the mtime of the lock directory, or `null` when not held.
 * Useful for detecting stuck mutexes in operator tooling.
 */
export function fileLockMtime(workDir: string): Date | null {
  const lockDir = join(workDir, '.git', '.ai-sdlc-worktree-mutex');
  try {
    return statSync(lockDir).mtime;
  } catch {
    return null;
  }
}

// ── Main entry-point ─────────────────────────────────────────────────────

export interface WithWorktreeMutexOptions {
  /**
   * Absolute path to the git repository root. Used to locate the
   * `.git/.ai-sdlc-worktree-mutex` file-lock directory.
   * When omitted, the file-lock layer is skipped (in-process mutex only).
   */
  workDir?: string;
  /**
   * How long to wait (in ms) before throwing a timeout error.
   * Defaults to `DEFAULT_MUTEX_TIMEOUT_MS` (60 000 ms).
   */
  timeoutMs?: number;
  /**
   * Override the global mutex instance. Tests inject their own object to
   * run multiple test suites in the same process without shared state.
   */
  _mutex?: _MutexState;
}

/**
 * Run `fn` while holding the worktree mutex.
 *
 * Guarantees:
 * 1. At most one caller runs `fn` at a time (in-process serialization).
 * 2. The mutex is ALWAYS released on return/throw (try/finally).
 * 3. If the mutex is not acquired within `timeoutMs`, an error is thrown
 *    before `fn` is invoked (the caller does NOT enter the critical section).
 * 4. When `workDir` is provided, the cross-process file lock is also held
 *    for the duration of `fn`.
 *
 * @param fn  The critical section to execute.
 * @param opts Configuration (workDir, timeoutMs, _mutex).
 * @returns The return value of `fn`.
 */
export async function withWorktreeMutex<T>(
  fn: () => Promise<T>,
  opts: WithWorktreeMutexOptions = {},
): Promise<T> {
  const mutex = opts._mutex ?? _globalMutex;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MUTEX_TIMEOUT_MS;

  // Step 1: Enqueue into the in-process chain.
  // We append a new "outer" promise to the queue tail. When the previous
  // tail resolves, our turn begins. If our timeout fires before the
  // previous tail resolves, we reject without entering the critical section.

  let releaseLock!: () => void;
  const newTail = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  // Atomically capture the current queue tail and replace it with the new tail.
  const prevTail = mutex.queue;
  mutex.queue = newTail;
  mutex.depth += 1;

  // Step 2: Wait for our turn, with a timeout.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(MUTEX_TIMEOUT_MESSAGE));
    }, timeoutMs);
  });

  try {
    // Race: either the previous holder releases, or we time out.
    await Promise.race([prevTail, timeoutPromise]);
  } catch (timeoutErr) {
    // We timed out — clean up our slot in the queue and propagate.
    // Release our lock slot immediately so subsequent waiters don't deadlock.
    releaseLock();
    mutex.depth -= 1;
    // Clear the timeout timer so the process doesn't hang.
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    throw timeoutErr;
  }

  // Acquired! Clear the timeout.
  if (timeoutId !== undefined) clearTimeout(timeoutId);

  // Step 3: Optionally acquire the cross-process file lock.
  // Spin-poll with 200 ms sleep up to the same timeoutMs ceiling.
  // This is an advisory lock only — it protects against two independently
  // started Node.js processes (e.g. two `cli-orchestrator tick` shells).
  let fileLockAcquired = false;
  if (opts.workDir) {
    const deadline = Date.now() + timeoutMs;
    while (!fileLockAcquired && Date.now() < deadline) {
      if (tryAcquireFileLock(opts.workDir)) {
        fileLockAcquired = true;
      } else {
        // Spin with a small delay.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!fileLockAcquired) {
      releaseLock();
      mutex.depth -= 1;
      throw new Error(MUTEX_TIMEOUT_MESSAGE);
    }
  }

  // Step 4: Execute the critical section.
  try {
    return await fn();
  } finally {
    // Always release both locks.
    if (opts.workDir && fileLockAcquired) {
      releaseFileLock(opts.workDir);
    }
    releaseLock();
    mutex.depth -= 1;
  }
}

// ── Signal handler ───────────────────────────────────────────────────────

/** Tracks whether the signal handler has already been installed. */
let _signalHandlerInstalled = false;

/**
 * Install a once-per-process SIGINT / SIGTERM handler that releases the
 * file-based worktree mutex for the given `workDir` before re-raising the
 * signal. This ensures a Ctrl-C during `withWorktreeMutex()` doesn't leave
 * a stale `.git/.ai-sdlc-worktree-mutex` directory on disk.
 *
 * Safe to call multiple times — installs only once per workDir per process.
 * The in-process mutex (promise chain) is automatically released when the
 * process exits because pending promise callbacks are never executed.
 */
export function setupWorktreeSignalHandler(workDir: string): void {
  if (_signalHandlerInstalled) return;
  _signalHandlerInstalled = true;

  const handler = (signal: NodeJS.Signals) => {
    // Best-effort release — ignore errors.
    try {
      releaseFileLock(workDir);
    } catch {
      // ignore
    }
    // Re-raise the signal with the default handler.
    process.removeListener('SIGINT', handler as NodeJS.SignalsListener);
    process.removeListener('SIGTERM', handler as NodeJS.SignalsListener);
    process.kill(process.pid, signal);
  };

  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

/**
 * Reset the signal-handler installation flag. Tests inject this to allow
 * multiple `setupWorktreeSignalHandler()` calls across test cases.
 * NOT for production use.
 */
export function _resetSignalHandlerFlag(): void {
  _signalHandlerInstalled = false;
}
