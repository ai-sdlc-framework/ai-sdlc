/**
 * Which hierarchy role does the calling process hold?
 *
 * Mirrors the plugin hooks' resolution (`ai-sdlc-plugin/hooks/lib/hierarchy-role.js`):
 * the caller is the NEAREST running roster entry found walking outward through
 * its own process and ancestors, and only when that pid is a claude process.
 * Anything else (no roster, unreadable roster, stale entry, foreign pid) resolves
 * to null, and callers treat a null role as the operator.
 *
 * LOCKSTEP: this file and `ai-sdlc-plugin/hooks/lib/hierarchy-role.js`
 * (`resolveSessionRole`) implement the same resolution and MUST change together
 * (running status only, safe session name, known role, nearest pid decides, claude
 * process only). `session-role.test.ts` loads both and asserts they agree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { rosterPath } from './roster.js';
import type { HierarchyRole } from './types.js';

const ROLES: readonly HierarchyRole[] = ['executor', 'operator-dispatch', 'planner'];

/** Same pattern as SAFE_NAME in hierarchy-role.js. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Collaborators a test can replace so no real process table is read. */
export interface SessionRoleDeps {
  /** This process and its ancestors, nearest first. */
  pids?: () => number[];
  /** Command of a process, or '' when unreadable. */
  commOf?: (pid: number) => string;
}

function psField(field: string, pid: number): string {
  try {
    const res = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return res.status === 0 ? String(res.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

function ancestorPids(): number[] {
  const pids = [process.pid];
  let current = process.ppid;
  for (let depth = 0; depth < 16 && Number.isInteger(current) && current > 1; depth += 1) {
    if (pids.includes(current)) break;
    pids.push(current);
    const next = Number.parseInt(psField('ppid', current), 10);
    if (!Number.isInteger(next) || next === current) break;
    current = next;
  }
  return pids;
}

function isClaudeCommand(comm: string): boolean {
  const base = comm.trim().split('/').pop() ?? '';
  return /^claude(-code)?$/i.test(base);
}

/** The role the calling process holds in the roster under `boardDir`, or null. Never throws. */
export function resolveCallerRole(
  boardDir: string,
  deps: SessionRoleDeps = {},
): HierarchyRole | null {
  try {
    const file = rosterPath(boardDir);
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as {
      schemaVersion?: unknown;
      sessions?: unknown;
    };
    if (!doc || doc.schemaVersion !== 'v1' || !Array.isArray(doc.sessions)) return null;
    const running = (
      doc.sessions as { role?: unknown; pid?: unknown; status?: unknown; name?: unknown }[]
    ).filter(
      (s) =>
        s &&
        s.status === 'running' &&
        typeof s.name === 'string' &&
        SAFE_NAME.test(s.name) &&
        ROLES.includes(s.role as HierarchyRole),
    );
    const commOf = deps.commOf ?? ((pid: number) => psField('comm', pid));
    for (const pid of (deps.pids ?? ancestorPids)()) {
      const self = running.find((s) => Number.isInteger(s.pid) && s.pid === pid);
      if (!self) continue;
      // The nearest hit decides; a non-claude pid is not this session.
      return isClaudeCommand(commOf(pid)) ? (self.role as HierarchyRole) : null;
    }
    return null;
  } catch {
    return null;
  }
}
