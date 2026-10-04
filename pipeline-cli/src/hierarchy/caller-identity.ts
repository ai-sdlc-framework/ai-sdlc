/**
 * Who is calling `cli-hierarchy`.
 *
 * The commands that write the board or act with dispatch authority must not rely
 * on a `--worker` string the caller supplies: any session can type any name. They
 * resolve the calling session instead, with the same rules the plugin hooks and
 * the executor skill use: the nearest ancestor process that is a running roster
 * entry, and only when that process is a claude process. Entries that are not
 * running never match, names and roles must pass the allowlists, and a pid that is
 * not a claude process (reused by a shell, say) is not a session.
 *
 * This is a mistake guard, not authentication: it stops a session from using the
 * dispatch commands by accident, and a session running as the same user can still
 * defeat it.
 *
 * The roster reader and the process lookups are injected, so tests never read the
 * real process table.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ROSTER_FILENAME } from './roster.js';

/** Same allowlist as the hook and the skills. */
export const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Roles a roster entry may carry. */
const ROLES: readonly string[] = ['executor', 'operator-dispatch', 'planner'];
/** Most ancestors examined. */
const MAX_DEPTH = 16;

/** A roster entry as the identity check sees it. */
export interface CallerSession {
  name: string;
  role: string;
  pid: number;
  status: string;
}

/** Collaborators of {@link resolveCaller}. */
export interface IdentityDeps {
  /** Roster entries. */
  readSessions: () => CallerSession[];
  /** Parent of a process, or null when it cannot be read. */
  parentPid: (pid: number) => number | null;
  /** Command name of a process, or '' when it cannot be read. */
  comm: (pid: number) => string;
  /** Process the walk starts at: the caller's parent shell. */
  startPid: number;
}

/** The resolved session. */
export interface CallerIdentity {
  name: string;
  role: string;
}

/** True when a process command (path or bare name) is a claude process. */
export function isClaudeCommand(comm: string): boolean {
  const base = String(comm || '')
    .trim()
    .split('/')
    .pop();
  return /^claude(-code)?$/i.test(base ?? '');
}

/**
 * The calling session, or null when none of this process's ancestors is a running
 * roster entry that is a claude process.
 */
export function resolveCaller(deps: IdentityDeps): CallerIdentity | null {
  let sessions: CallerSession[];
  try {
    sessions = deps.readSessions();
  } catch {
    return null;
  }
  const eligible = sessions.filter(
    (s) =>
      s !== null &&
      typeof s === 'object' &&
      s.status === 'running' &&
      typeof s.name === 'string' &&
      SAFE_SESSION_NAME.test(s.name) &&
      ROLES.includes(s.role) &&
      Number.isInteger(s.pid),
  );
  if (eligible.length === 0) return null;
  const seen = new Set<number>();
  let pid: number | null = deps.startPid;
  let self: CallerSession | undefined;
  for (let i = 0; i < MAX_DEPTH && pid !== null && pid > 1 && !seen.has(pid); i++) {
    seen.add(pid);
    self = eligible.find((s) => s.pid === pid);
    if (self) break;
    pid = deps.parentPid(pid);
  }
  if (!self || pid === null) return null;
  // The nearest hit decides: a pid that is not a claude process is not this session.
  let comm: string;
  try {
    comm = deps.comm(pid);
  } catch {
    return null;
  }
  if (!isClaudeCommand(comm)) return null;
  return { name: self.name, role: self.role };
}

/** The result of {@link requireDispatchCaller}. */
export type CallerCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Accept the caller only when it resolves to the dispatch session. A `--worker`
 * value, when given, must also equal the resolved name; it never decides who the
 * caller is.
 */
export function requireDispatchCaller(
  deps: IdentityDeps,
  worker: string | undefined,
  command: string,
): CallerCheck {
  const caller = resolveCaller(deps);
  if (!caller) {
    return {
      ok: false,
      reason: `${command}: the calling session is not a running session in the roster`,
    };
  }
  if (caller.role !== 'operator-dispatch') {
    return {
      ok: false,
      reason: `${command}: only the dispatch session may run this command (the caller's role is ${caller.role})`,
    };
  }
  if (worker !== undefined && worker !== caller.name) {
    return {
      ok: false,
      reason: `${command}: --worker does not match the calling session's own roster name`,
    };
  }
  return { ok: true, name: caller.name };
}

function psField(field: string, pid: number): string | null {
  try {
    const res = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return res.status === 0 ? String(res.stdout ?? '').trim() : null;
  } catch {
    return null;
  }
}

/** Production dependencies: the roster file on the board and `ps`. */
export function createSystemIdentity(
  boardDir: string,
  lookup: Partial<Pick<IdentityDeps, 'parentPid' | 'comm' | 'startPid'>> = {},
): IdentityDeps {
  return {
    readSessions: () => {
      const file = path.join(boardDir, ROSTER_FILENAME);
      if (!existsSync(file)) return [];
      const doc = JSON.parse(readFileSync(file, 'utf-8')) as {
        schemaVersion?: unknown;
        sessions?: unknown;
      };
      if (doc?.schemaVersion !== 'v1' || !Array.isArray(doc.sessions)) return [];
      return doc.sessions as CallerSession[];
    },
    parentPid: (pid) => {
      const out = psField('ppid', pid);
      if (out === null || !/^[0-9]+$/.test(out)) return null;
      return Number.parseInt(out, 10);
    },
    comm: (pid) => psField('comm', pid) ?? '',
    startPid: process.ppid,
    ...lookup,
  };
}
