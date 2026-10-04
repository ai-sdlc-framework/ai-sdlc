/**
 * Role re-injection for hierarchy sessions after `/clear`.
 *
 * `/clear` empties a session's context but keeps its name and permission mode,
 * and fires SessionStart with source `clear`. A session that is listed in the
 * hierarchy roster needs to be told what it is again; this builds that short
 * block. Any other session, and any other source, gets nothing.
 *
 * LOCKSTEP: `resolveSessionRole` here and `resolveCallerRole` in
 * `pipeline-cli/src/hierarchy/session-role.ts` implement the same resolution and
 * MUST change together. `pipeline-cli/src/hierarchy/session-role.test.ts` loads
 * both and asserts they agree.
 *
 * The roster is read with plain JSON parsing and a minimal shape check: the hook
 * is a standalone script and must never throw into session start.
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');

/** Skill each roster role runs for its whole life. */
const ROLE_SKILL = {
  executor: '/ai-sdlc executor',
  'operator-dispatch': '/ai-sdlc operator-dispatch',
  planner: '/ai-sdlc planner',
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Command name of a process, or '' when it cannot be read. Injectable so tests
 * never look up the real process tree.
 * @param {number} pid
 * @returns {string}
 */
function commOfPid(pid) {
  try {
    const res = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return res.status === 0 ? String(res.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

/** True when a process command (path or bare name) is a claude process. */
function isClaudeCommand(comm) {
  const base = String(comm || '')
    .trim()
    .split('/')
    .pop();
  return /^claude(-code)?$/i.test(base);
}

/**
 * Read the roster's running session entries, or [] when it is missing or
 * malformed. Entries that are not `running` are stale and never match.
 */
function readRosterSessions(boardDir) {
  const file = join(boardDir, 'hierarchy.json');
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    if (!doc || doc.schemaVersion !== 'v1' || !Array.isArray(doc.sessions)) return [];
    return doc.sessions.filter(
      (s) =>
        s &&
        s.status === 'running' &&
        typeof s.name === 'string' &&
        SAFE_NAME.test(s.name) &&
        typeof s.role === 'string' &&
        Object.prototype.hasOwnProperty.call(ROLE_SKILL, s.role),
    );
  } catch {
    return [];
  }
}

/**
 * Parent pid of a process, or null when it cannot be read. Injectable so tests
 * never look up the real process tree.
 * @param {number} pid
 * @returns {number | null}
 */
function parentPidOf(pid) {
  try {
    const res = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (res.status !== 0) return null;
    const next = Number.parseInt(String(res.stdout || '').trim(), 10);
    return Number.isInteger(next) ? next : null;
  } catch {
    return null;
  }
}

/**
 * This process and its ancestors, nearest first. A hook runs as a descendant of
 * the Claude Code process, whose pid is what the hierarchy roster records.
 * Bounded depth; stops quietly on any failure.
 * @param {object} [opts]
 * @param {number} [opts.pid] defaults to this process.
 * @param {number} [opts.ppid] defaults to this process's parent.
 * @param {(pid: number) => number | null} [opts.parentOf] defaults to `ps`.
 * @returns {number[]}
 */
function ancestorPids({ pid = process.pid, ppid = process.ppid, parentOf = parentPidOf } = {}) {
  const pids = [pid];
  let current = ppid;
  for (let depth = 0; depth < 16 && Number.isInteger(current) && current > 1; depth += 1) {
    if (pids.includes(current)) break;
    pids.push(current);
    const next = parentOf(current);
    if (!Number.isInteger(next) || next === current) break;
    current = next;
  }
  return pids;
}

/**
 * The roster entry that is this session, and the running roster it came from,
 * or null when the session cannot be resolved.
 *
 * The session is the NEAREST running roster entry found walking outward through
 * `pids`, and only when that pid is a claude process. A pid that is not a
 * claude process (reused by a shell or multiplexer) is not this session, and a
 * farther match must not stand in for it. Stale (not running) entries never
 * match. Any failure resolves to null: an unresolved session is treated as the
 * operator by every caller.
 *
 * @param {object} args
 * @param {string} args.boardDir directory holding `hierarchy.json`.
 * @param {number[]} args.pids this process and its ancestors, nearest first.
 * @param {(pid: number) => string} [args.commOf] process command lookup; defaults to `ps`.
 * @returns {{ self: object, sessions: object[] } | null}
 */
function resolveSessionSelf({ boardDir, pids, commOf = commOfPid }) {
  const sessions = readRosterSessions(boardDir);
  if (sessions.length === 0) return null;
  let self;
  for (const pid of pids) {
    self = sessions.find((s) => Number.isInteger(s.pid) && s.pid === pid);
    if (self) {
      let comm = '';
      try {
        comm = commOf(pid);
      } catch {
        comm = '';
      }
      if (!isClaudeCommand(comm)) return null;
      break;
    }
  }
  return self ? { self, sessions } : null;
}

/**
 * The RFC-0051 role this session holds, or null when it cannot be resolved.
 * `dispatchName` is the running operator-dispatch session in the roster, or
 * null when there is none.
 *
 * @param {object} args same as {@link resolveSessionSelf}
 * @returns {{ role: string, name: string, dispatchName: string | null } | null}
 */
function resolveSessionRole(args) {
  const found = resolveSessionSelf(args);
  if (!found) return null;
  const dispatch = found.sessions.find((s) => s.role === 'operator-dispatch');
  return {
    role: found.self.role,
    name: found.self.name,
    dispatchName: dispatch ? dispatch.name : null,
  };
}

/**
 * The role block for a cleared session, or null.
 *
 * @param {object} args
 * @param {string | undefined} args.source SessionStart source (`startup`, `resume`, `clear`, `compact`).
 * @param {string} args.boardDir directory holding `hierarchy.json`.
 * @param {number[]} args.pids this process and its ancestors, nearest first; see {@link resolveSessionSelf}.
 * @param {(pid: number) => string} [args.commOf] process command lookup; defaults to `ps`.
 * @returns {string | null}
 */
function buildHierarchyRoleBlock({ source, boardDir, pids, commOf = commOfPid }) {
  if (source !== 'clear') return null;
  const found = resolveSessionSelf({ boardDir, pids, commOf });
  if (!found) return null;
  const { self, sessions } = found;
  const dispatch = sessions.find((s) => s.role === 'operator-dispatch');
  const lines = [
    '### Session role',
    `- Role: ${self.role}`,
    `- Name: ${self.name}`,
    `- Dispatch session: ${dispatch ? dispatch.name : '(not in the roster)'}`,
    `- Run now: ${ROLE_SKILL[self.role]}`,
  ];
  return lines.join('\n');
}

module.exports = {
  buildHierarchyRoleBlock,
  resolveSessionRole,
  resolveSessionSelf,
  ancestorPids,
  parentPidOf,
  readRosterSessions,
  isClaudeCommand,
  commOfPid,
  ROLE_SKILL,
  SAFE_NAME,
};
