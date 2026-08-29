/**
 * Parent-repo lock for backlog task ID allocation (AISDLC-559).
 *
 * A read-only "next free ID" scan still races: two parallel sessions can
 * read the same "next free" number at the same instant. The actual claim is
 * creating the task file (source 2 of `task-id-scanner.ts` sees uncommitted
 * sibling-worktree files), but that still leaves a same-instant race in the
 * read-then-create window. This lock closes that window.
 *
 * The lock file lives under the PARENT repo, e.g.
 * `<parent>/.ai-sdlc/locks/task-id.lock` — never inside a worktree, so it is
 * visible to every sibling worktree racing for the same ID. `.ai-sdlc/locks/`
 * is the one sanctioned exception to "the parent working tree is read-only"
 * (it's gitignored — see `.gitignore`), matching the pattern.md contract.
 *
 * Implementation: exclusive-create (`wx` flag) a lock file. If it already
 * exists, poll until it's released or its mtime exceeds `staleMs` (a
 * crashed/killed holder cannot deadlock future allocations forever).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface TaskIdLockHandle {
  release: () => void;
}

export interface AcquireTaskIdLockOptions {
  /** A lock older than this (ms) is presumed abandoned and stolen. Default 30s. */
  staleMs?: number;
  /** Give up and throw after this long (ms) waiting for contention to clear. Default 5s. */
  timeoutMs?: number;
  /** Poll interval (ms) while waiting. Default 50ms. */
  pollMs?: number;
}

/**
 * AISDLC-559 review (MAJOR): these two MUST be ordered `staleMs < timeoutMs`,
 * or crash recovery is unreachable. With the original 30s stale / 5s timeout,
 * every caller within 30s of a crashed holder hit the 5s deadline and threw
 * before the stale takeover could ever fire — and neither MCP tool retries.
 * A crashed holder therefore bricked allocation for half a minute.
 */
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 50;

if (DEFAULT_STALE_MS >= DEFAULT_TIMEOUT_MS) {
  throw new Error(
    'task-id-lock: DEFAULT_STALE_MS must be < DEFAULT_TIMEOUT_MS or stale locks can never be reclaimed',
  );
}

export function taskIdLockDir(parentRoot: string): string {
  return join(parentRoot, '.ai-sdlc', 'locks');
}

export function taskIdLockFilePath(parentRoot: string): string {
  return join(taskIdLockDir(parentRoot), 'task-id.lock');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the task-id allocation lock under `parentRoot`. Resolves with a
 * handle whose `.release()` removes the lock file. Throws when contention
 * does not clear within `timeoutMs`.
 */
export async function acquireTaskIdLock(
  parentRoot: string,
  opts: AcquireTaskIdLockOptions = {},
): Promise<TaskIdLockHandle> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // NOTE: deliberately NOT rejecting staleMs >= timeoutMs at runtime. A caller
  // that KNOWS the lock is already stale can legitimately pass a large staleMs
  // with a short timeout — the steal happens on the first iteration, before the
  // deadline is ever consulted. Adding that guard broke three existing tests
  // that document exactly this usage. The ordering only matters for the
  // DEFAULTS, where a lock may go stale mid-wait; that is asserted at module
  // load instead.

  mkdirSync(taskIdLockDir(parentRoot), { recursive: true });
  const path = taskIdLockFilePath(parentRoot);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      // AISDLC-559 review (MAJOR): the token is what stops a SUPERSEDED holder
      // from deleting the current holder's lock. Without it, a holder whose
      // critical section outran staleMs would have its lock stolen by B, then
      // its own release() would unlink B's lock and a third caller would walk
      // straight in — two simultaneous holders, i.e. the exact race this lock
      // exists to close.
      const token = randomUUID();
      writeSync(
        fd,
        JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }),
      );
      closeSync(fd);
      return {
        release: () => {
          try {
            const held = JSON.parse(readFileSync(path, 'utf-8')) as { token?: string };
            // Only unlink a lock we still own.
            if (held.token === token) unlinkSync(path);
          } catch {
            // Already released, stolen by a stale-lock reaper, or unreadable —
            // in every case there is nothing of ours left to remove.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Someone else holds the lock. If it's stale (crashed holder), steal it.
      let stolen = false;
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > staleMs) {
          try {
            unlinkSync(path);
            // Only a SUCCESSFUL unlink earns the fast retry. Round-2 review:
            // setting this after a failed unlink reproduced the same unbounded
            // 100%-CPU spin the stat-failure fix removed — a stale lock that
            // cannot be unlinked (path is a directory, immutable flag, EACCES)
            // would loop forever, skipping both deadline check and sleep.
            stolen = true;
          } catch {
            // Another waiter reaped it, or we cannot remove it at all. Either
            // way fall through to the BOUNDED wait rather than spinning.
          }
        }
      } catch {
        // AISDLC-559 review (MINOR): do NOT `continue` here. A bare continue
        // skipped both the deadline check and the sleep, so a dangling symlink
        // at the lock path — where openSync('wx') returns EEXIST forever while
        // statSync returns ENOENT forever — became an unbounded 100%-CPU spin
        // that hung the MCP server. Fall through to the bounded wait instead.
      }
      if (stolen) continue;

      if (Date.now() >= deadline) {
        throw new Error(
          `AI-SDLC: task-id lock contention at ${path} — held for less than the ` +
            `${staleMs}ms stale threshold and did not clear within ${timeoutMs}ms. ` +
            `Retry the allocation, or remove the lock file manually if you are certain ` +
            `no other process holds it.`,
          { cause: err },
        );
      }
      await sleep(pollMs);
    }
  }
}
