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

/** SessionStart sources that follow an emptied or compacted context. */
const RESET_SOURCES = ['clear', 'compact'];

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
 * @param {(info: { pid: number, role: string, name: string, comm: string }) => void} [args.onMismatch]
 *   called when a RUNNING roster entry matches an ancestor pid whose process is not claude, so a
 *   no-op enforcer can be made visible. It never changes the result.
 * @returns {{ self: object, sessions: object[] } | null}
 */
function resolveSessionSelf({ boardDir, pids, commOf = commOfPid, onMismatch }) {
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
      if (!isClaudeCommand(comm)) {
        if (typeof onMismatch === 'function') {
          try {
            onMismatch({ pid, role: self.role, name: self.name, comm });
          } catch {
            // a diagnostic must never change the decision
          }
        }
        return null;
      }
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
 * The role block (and handoff, when `readHandoff` is given) for a cleared or compacted session, or null.
 *
 * @param {object} args
 * @param {string | undefined} args.source SessionStart source (`startup`, `resume`, `clear`, `compact`).
 * @param {string} args.boardDir directory holding `hierarchy.json`.
 * @param {number[]} args.pids this process and its ancestors, nearest first; see {@link resolveSessionSelf}.
 * @param {(pid: number) => string} [args.commOf] process command lookup; defaults to `ps`.
 * @param {(self: object) => string | null} [args.readHandoff] handoff text for the session.
 * @returns {string | null}
 */
function buildHierarchyRoleBlock({ source, boardDir, pids, commOf = commOfPid, readHandoff }) {
  if (!RESET_SOURCES.includes(source)) return null;
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
  const handoff = typeof readHandoff === 'function' ? readHandoff(self) : null;
  if (handoff) {
    lines.push('', '### Handoff (reloaded after ' + source + ')', handoff);
  }
  if (self.role === 'planner') {
    lines.push(
      '',
      'Scheduled jobs: list them now and recreate any that this session lost, using the prompts in the handoff notes.',
    );
  }
  return lines.join('\n');
}

/** Longest handoff text injected into a fresh context, in characters. */
const HANDOFF_MAX_CHARS = 12000;

/**
 * Handoff text for a roster session via `cli-hierarchy handoff read`, truncated,
 * or null when the CLI is missing or fails. `run` is injectable for tests.
 * @param {{ role: string, name: string }} self
 * @param {object} args
 * @param {string} args.bin path of cli-hierarchy.mjs, or ''.
 * @param {string} args.boardDir
 * @param {Function} [args.run] spawnSync-compatible.
 * @returns {string | null}
 */
function readHandoffText(self, { bin, boardDir, run = spawnSync }) {
  if (!bin || !SAFE_NAME.test(self.name)) return null;
  try {
    const res = run(
      process.execPath,
      [bin, 'handoff', 'read', '--role', self.role, '--name', self.name, '--board-dir', boardDir],
      { encoding: 'utf-8', timeout: 10000 },
    );
    const text = res && res.status === 0 ? String(res.stdout || '').trim() : '';
    if (!text) return null;
    if (text.length <= HANDOFF_MAX_CHARS) return text;
    // Keep the head (state block) and the tail (newest notes); drop the middle.
    const head = Math.floor(HANDOFF_MAX_CHARS / 3);
    const tail = HANDOFF_MAX_CHARS - head;
    return `${text.slice(0, head)}\n[handoff middle omitted]\n${text.slice(text.length - tail)}`;
  } catch {
    return null;
  }
}

module.exports = {
  readHandoffText,
  HANDOFF_MAX_CHARS,
  RESET_SOURCES,
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
