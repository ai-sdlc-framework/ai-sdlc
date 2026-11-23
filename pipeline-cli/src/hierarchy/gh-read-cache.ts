import type { CommandResult, CommandRunner } from './types.js';

/**
 * AISDLC-1380: process-lifetime cache of `gh` reads whose answer cannot change
 * between dispatch passes (the login, a run id's jobs, a job id's annotations)
 * or only changes with its key (a sha). Scoped to one runner so two runners
 * never share an answer. Only successful reads are stored.
 */
const caches = new WeakMap<CommandRunner, Map<string, { at: number; value: CommandResult }>>();

/** Run `gh <args>` through `run`, reusing a successful answer for `key` for `ttlMs` (default: forever). */
export function cachedGh(
  run: CommandRunner,
  key: string,
  args: readonly string[],
  opts: { cwd?: string },
  ttlMs: number = Infinity,
  now: () => number = Date.now,
): CommandResult {
  let m = caches.get(run);
  if (!m) caches.set(run, (m = new Map()));
  const hit = m.get(key);
  if (hit && now() - hit.at < ttlMs) return hit.value;
  const r = run('gh', args, opts);
  if (r.status === 0) m.set(key, { at: now(), value: r });
  return r;
}

/** How long a mutable-but-slow read (main's sha, the newest docs-bump run, repo settings) is reused. */
export const GH_READ_TTL_MS = 5 * 60_000;
