/**
 * AISDLC-1061: the hierarchy hooks module's heartbeat. The module's `session.start` gate (and the dispatch
 * tick) write `<board-dir>/handoff/module-<roster-name>.json`; `status`, `up` and `doctor` read it. An
 * absent file means the module never ran in that session (not launched with a role, or refused before it
 * could write), which is exactly the state that went unnoticed for ten hours on 2026-10-23.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { HierarchyDeps, RosterEntry } from './types.js';

export type ModuleState = 'loaded' | 'refused' | 'absent' | 'stale';

export interface ModuleHealth {
  state: ModuleState;
  reason?: string;
  version?: string;
  at?: string;
}

/** The dispatch module refreshes its file on every tick (30 s); older than this and the tick has stopped. */
export const MODULE_STALE_MS = 120_000;
/** `up` waits two tick intervals for the dispatch host to report `loaded`. */
export const MODULE_WAIT_MS = 60_000;
const MODULE_POLL_MS = 5_000;

/** Runbook fix line shown by `up` and `doctor`. */
export const MODULE_FIX_LINE =
  "fix the module error named above (docs/operations/cli-hierarchy.md, 'Module absent'), rebuild, then run `cli-hierarchy down --role operator-dispatch` and `cli-hierarchy up`";

export function moduleHealthPath(boardDir: string, name: string): string {
  return path.join(boardDir, 'handoff', `module-${name}.json`);
}

/** Read one session's heartbeat; a missing or unreadable file is `absent`, a dispatch file past the stale window `stale`. */
export function readModuleHealth(
  boardDir: string,
  entry: Pick<RosterEntry, 'name' | 'role'>,
  now: Date,
): ModuleHealth {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(moduleHealthPath(boardDir, entry.name), 'utf8'));
  } catch {
    return { state: 'absent' };
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  const state = r.state === 'loaded' || r.state === 'refused' ? r.state : 'absent';
  const health: ModuleHealth = {
    state,
    ...(typeof r.reason === 'string' && r.reason ? { reason: r.reason } : {}),
    ...(typeof r.version === 'string' && r.version ? { version: r.version } : {}),
    ...(typeof r.at === 'string' ? { at: r.at } : {}),
  };
  if (state === 'loaded' && entry.role === 'operator-dispatch') {
    const at = health.at ? Date.parse(health.at) : NaN;
    if (Number.isNaN(at) || now.getTime() - at > MODULE_STALE_MS) {
      return { ...health, state: 'stale', reason: 'no heartbeat in the last two minutes' };
    }
  }
  return health;
}

/** `loaded`, `absent`, `refused: <reason>` or `stale: <reason>`. */
export function formatModuleHealth(h: ModuleHealth): string {
  return h.reason && h.state !== 'loaded' ? `${h.state}: ${h.reason}` : h.state;
}

/**
 * Wait for the dispatch host(s) to report `loaded`.
 * @throws with the reason and the runbook fix line when one does not within {@link MODULE_WAIT_MS}.
 */
export async function assertDispatchModuleLoaded(
  deps: HierarchyDeps,
  hosts: readonly RosterEntry[],
): Promise<void> {
  const attempts = Math.ceil(MODULE_WAIT_MS / MODULE_POLL_MS);
  let bad: { name: string; health: ModuleHealth }[] = [];
  for (let i = 0; i <= attempts; i++) {
    bad = hosts
      .map((e) => ({ name: e.name, health: readModuleHealth(deps.boardDir, e, deps.now()) }))
      .filter((x) => x.health.state !== 'loaded');
    if (bad.length === 0) return;
    if (i < attempts) await deps.sleep(MODULE_POLL_MS);
  }
  const named = bad.map((b) => `${b.name} MODULE ${formatModuleHealth(b.health)}`).join('; ');
  throw new Error(
    `the hierarchy hooks module is not loaded on the dispatch host, so there will be no ticks, wakes or rotations: ${named}. ${MODULE_FIX_LINE}`,
  );
}
