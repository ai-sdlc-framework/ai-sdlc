/**
 * AISDLC-1061: the hierarchy hooks module's heartbeat. The module's `session.start` gate (and the dispatch
 * tick) write `<board-dir>/handoff/module-<roster-name>.json`; `status`, `up` and `doctor` read it. An
 * absent file means the module never ran in that session (not launched with a role, or refused before it
 * could write), which is exactly the state that went unnoticed for ten hours on 2026-10-23.
 */

import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
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

/** Plugin data directories the host keeps `$.store` files in (`~/.claude/plugins/data/ai-sdlc-*`). */
export function defaultStoreDirs(): string[] {
  const root = path.join(os.homedir(), '.claude', 'plugins', 'data');
  try {
    return readdirSync(root)
      .filter((d) => d.startsWith('ai-sdlc'))
      .map((d) => path.join(root, d));
  } catch {
    return [];
  }
}

/**
 * AISDLC-1082 fallback: the module mirrors its heartbeat to the plugin store key `hierarchy/health/<name>`.
 * Scan `*.json` files in the store directories for that key (top level or under `store`/`data`).
 */
export function readStoreHealth(storeDirs: readonly string[], name: string): unknown {
  const key = `hierarchy/health/${name}`;
  for (const dir of storeDirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Record<
          string,
          Record<string, unknown> | undefined
        >;
        const hit = (j[key] as unknown) ?? j.store?.[key] ?? j.data?.[key];
        if (hit && typeof hit === 'object') return hit;
      } catch {
        // unreadable store file: try the next
      }
    }
  }
  return undefined;
}

/**
 * Read one session's heartbeat; the board file wins, then the plugin store copy. A missing or unreadable
 * record is `absent`, a dispatch record past the stale window `stale`.
 */
export function readModuleHealth(
  boardDir: string,
  entry: Pick<RosterEntry, 'name' | 'role'>,
  now: Date,
  storeDirs: readonly string[] = defaultStoreDirs(),
): ModuleHealth {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(moduleHealthPath(boardDir, entry.name), 'utf8'));
  } catch {
    raw = readStoreHealth(storeDirs, entry.name);
    if (raw === undefined) return { state: 'absent' };
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
