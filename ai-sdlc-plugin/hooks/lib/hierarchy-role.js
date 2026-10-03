/**
 * Role re-injection for hierarchy sessions after `/clear`.
 *
 * `/clear` empties a session's context but keeps its name and permission mode,
 * and fires SessionStart with source `clear`. A session that is listed in the
 * hierarchy roster needs to be told what it is again; this builds that short
 * block. Any other session, and any other source, gets nothing.
 *
 * The roster is read with plain JSON parsing and a minimal shape check: the hook
 * is a standalone script and must never throw into session start.
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

/** Skill each roster role runs for its whole life. */
const ROLE_SKILL = {
  executor: '/ai-sdlc executor',
  'operator-dispatch': '/ai-sdlc operator-dispatch',
  planner: '/ai-sdlc planner',
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Read the roster's session entries, or [] when it is missing or malformed. */
function readRosterSessions(boardDir) {
  const file = join(boardDir, 'hierarchy.json');
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    if (!doc || doc.schemaVersion !== 'v1' || !Array.isArray(doc.sessions)) return [];
    return doc.sessions.filter(
      (s) =>
        s &&
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
 * The role block for a cleared session, or null.
 *
 * @param {object} args
 * @param {string | undefined} args.source SessionStart source (`startup`, `resume`, `clear`, `compact`).
 * @param {string} args.boardDir directory holding `hierarchy.json`.
 * @param {number[]} args.pids this process and its ancestors; the session is the roster entry whose pid is among them.
 * @returns {string | null}
 */
function buildHierarchyRoleBlock({ source, boardDir, pids }) {
  if (source !== 'clear') return null;
  const sessions = readRosterSessions(boardDir);
  if (sessions.length === 0) return null;
  const self = sessions.find((s) => Number.isInteger(s.pid) && pids.includes(s.pid));
  if (!self) return null;
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

module.exports = { buildHierarchyRoleBlock, readRosterSessions, ROLE_SKILL };
