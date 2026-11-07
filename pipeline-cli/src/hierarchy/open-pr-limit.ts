/**
 * The open-PR limit and the reconcile lock (AISDLC-1189, DEC-0373).
 *
 * Dispatch lands and repairs open PRs before it claims new tasks. A new-task entry is not
 * claimed while the open task PRs are at the limit; a repair entry always is. The limit
 * resolves `AI_SDLC_OPEN_PR_LIMIT`, then `<board>/config.json` `{ "executors": { "openPrLimit": N } }`,
 * then `executors.max`. An invalid value falls through to the next source.
 *
 * The lock keeps the in-tick reconcile pass and the `reconcile --watch` process from running a
 * pass at the same time.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveExecutorsMax } from './executor-cap.js';
import { listLanding } from './reconcile.js';
import { configPath } from './thresholds.js';

/** The configured limit: env, then config file, then `executors.max`. */
export function resolveOpenPrLimit(
  boardDir: string,
  env: Record<string, string | undefined> = {},
): number {
  const raw = env.AI_SDLC_OPEN_PR_LIMIT;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  try {
    if (existsSync(configPath(boardDir))) {
      const doc = JSON.parse(readFileSync(configPath(boardDir), 'utf-8')) as {
        executors?: { openPrLimit?: unknown };
      };
      const m = doc.executors?.openPrLimit;
      if (typeof m === 'number' && Number.isInteger(m) && m > 0) return m;
    }
  } catch {
    /* malformed config: next source */
  }
  return resolveExecutorsMax(boardDir, env);
}

/** PR numbers of open task PRs: landed and closed-unlanded records, and non-task kinds, do not count. */
export function openTaskPrs(boardDir: string): number[] {
  try {
    return listLanding(boardDir)
      .filter((r) => r.kind === 'task' && !r.landed && !r.closedUnlanded)
      .map((r) => r.pr);
  } catch {
    return [];
  }
}

export interface OpenPrState {
  limit: number;
  open: number[];
  atLimit: boolean;
}

export function openPrState(
  boardDir: string,
  env: Record<string, string | undefined> = {},
): OpenPrState {
  const limit = resolveOpenPrLimit(boardDir, env);
  const open = openTaskPrs(boardDir);
  return { limit, open, atLimit: open.length >= limit };
}

/** The `OPEN PRS` line of `status`. */
export function formatOpenPrs(s: OpenPrState): string {
  return `OPEN PRS ${s.open.length} of limit ${s.limit}${s.atLimit ? ' (new tasks held; repairs still claimed)' : ''}`;
}

/** The reason line logged when new-task entries are held at the limit. */
export function openPrHoldReason(s: OpenPrState, held: readonly string[]): string {
  const prs = s.open.map((n) => `#${n}`).join(', ');
  return `not claiming new tasks (${held.join(', ')}): ${s.open.length} open PRs at limit ${s.limit} (${prs}); land or repair them first`;
}

/** A lock older than this is taken over (its holder crashed). */
export const RECONCILE_LOCK_STALE_MS = 10 * 60 * 1000;

function lockFile(boardDir: string): string {
  return path.join(boardDir, 'reconcile.lock');
}

/** Take the reconcile lock; false when a live holder has it. */
export function acquireReconcileLock(boardDir: string, now: Date): boolean {
  const file = lockFile(boardDir);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: now.toISOString() }), {
        flag: 'wx',
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let at = Number.NaN;
    try {
      at = Date.parse((JSON.parse(readFileSync(file, 'utf-8')) as { at?: string }).at ?? '');
    } catch {
      /* unreadable lock: stale */
    }
    if (!Number.isNaN(at) && now.getTime() - at < RECONCILE_LOCK_STALE_MS) return false;
    rmSync(file, { force: true });
  }
  return false;
}

export function releaseReconcileLock(boardDir: string): void {
  rmSync(lockFile(boardDir), { force: true });
}

/** Run `fn` under the reconcile lock; `{ ran: false }` when another pass holds it. */
export async function withReconcileLock<T>(
  boardDir: string,
  now: Date,
  fn: () => T | Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!acquireReconcileLock(boardDir, now)) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    releaseReconcileLock(boardDir);
  }
}
