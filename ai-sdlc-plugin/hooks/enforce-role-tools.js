/**
 * AI-SDLC Role Tool Enforcement Hook (PreToolUse)
 *
 * Enforces `governance.roles.<role>.blockedTools` from `.ai-sdlc/agent-role.yaml`
 * for RFC-0051 hierarchy sessions. An executor session, by default, may not
 * message anyone but the dispatch session, may not answer / resolve / override a
 * decision, and may not create a top-level task. The rules, their matchers and
 * their wording live in `lib/role-tool-policy.js`; the same module renders the
 * executor skill's hard-rule text, so narration and enforcement cannot drift.
 *
 * Which session is this? The roster (`<board>/hierarchy.json`) names the sessions
 * by pid; the session is the nearest running roster entry among this process's
 * ancestors, and only when that pid is a claude process (`lib/hierarchy-role.js`).
 *
 * Fail posture:
 *  - a session that is not in a hierarchy (no roster) or whose role cannot be
 *    resolved is treated as the operator and is never blocked; an internal error
 *    before the role is known allows the call, so a crash can never wedge a session;
 *  - once the role resolves to EXECUTOR the hook fails CLOSED: an unreadable or
 *    invalid policy, or any evaluation error, applies the strict executor
 *    defaults (never a relaxation), and a call that cannot be evaluated at all is
 *    refused;
 *  - the non-hierarchy path spawns nothing: a plain filesystem check for the
 *    roster runs first, and everything heavier is required and run only after it.
 *
 * This is a guard against a session's own mistakes, not a sandbox: a static
 * matcher cannot see `eval`, encoded payloads or names built at run time.
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { dirname, join, resolve } = require('path');

function deny(reason) {
  process.stdout.write(
    JSON.stringify(
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Blocked by AI-SDLC governance policy: ${reason}`,
        },
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
}

/**
 * Locate the roster with plain filesystem checks only (no git, no ps): the board
 * directory from the environment, else `.ai-sdlc/dispatch` under the project
 * directory or the nearest ancestor of the tool's cwd that has one.
 * Returns `{ boardDir, projectDir }` or null.
 */
function findRoster(input) {
  const rosterIn = (board) => existsSync(join(board, 'hierarchy.json'));
  const envBoard = process.env.AI_SDLC_DISPATCH_BOARD_DIR;
  const start = resolve(
    process.env.CLAUDE_PROJECT_DIR ||
      (input && typeof input.cwd === 'string' ? input.cwd : '') ||
      process.cwd(),
  );
  if (envBoard) {
    return rosterIn(envBoard) ? { boardDir: envBoard, projectDir: start } : null;
  }
  let dir = start;
  for (let depth = 0; depth < 12; depth += 1) {
    const board = join(dir, '.ai-sdlc', 'dispatch');
    if (rosterIn(board)) return { boardDir: board, projectDir: dir };
    if (process.env.CLAUDE_PROJECT_DIR) return null; // an explicit project dir is not searched upward
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main() {
  // fd 0 (not /dev/stdin): the device-file path fails on some Linux runners.
  const input = JSON.parse(readFileSync(0, 'utf-8'));
  const toolName = input && input.tool_name;
  if (typeof toolName !== 'string' || toolName === '') return;
  const toolInput =
    input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};

  // Not in a hierarchy: nothing to enforce, and nothing has been spawned or loaded.
  const found = findRoster(input);
  if (!found) return;
  const { boardDir, projectDir } = found;

  const { resolveSessionRole, ancestorPids } = require('./lib/hierarchy-role');
  const {
    ROLES,
    loadRoleBlockedTools,
    defaultRoleBlockedTools,
    ruleCouldMatch,
    decideForSession,
  } = require('./lib/role-tool-policy');

  // An unreadable policy resolves to the strict defaults, never to "no rules".
  let rulesByRole;
  try {
    rulesByRole = loadRoleBlockedTools(projectDir);
  } catch {
    rulesByRole = defaultRoleBlockedTools();
  }

  // Cheap, context-free pass first: most calls cannot match any rule, and those
  // never pay for a session lookup. An error in the pass counts as "could match".
  let candidates;
  try {
    candidates = ROLES.some((role) =>
      (rulesByRole[role] || []).some((r) => ruleCouldMatch(r, toolName, toolInput)),
    );
  } catch {
    candidates = true;
  }
  if (!candidates) return;

  const session = resolveSessionRole({
    boardDir,
    pids: ancestorPids(),
    onMismatch: ({ pid, role, name, comm }) =>
      process.stderr.write(
        `[ai-sdlc] role tool rules NOT enforced: roster entry '${name}' (${role}) matches pid ${pid}, ` +
          `but that process is '${String(comm)
            .replace(/[^\x20-\x7e]/g, '?')
            .slice(0, 64)}', not claude\n`,
      ),
  });
  if (!session) return; // unresolved role: treated as the operator

  const message = decideForSession(
    session,
    (role) => rulesByRole[role],
    toolName,
    toolInput,
    boardDir,
    { projectDir, cwd: typeof input.cwd === 'string' ? input.cwd : undefined },
  );
  if (message) deny(message);
}

try {
  main();
} catch {
  // Before the role is known a crash allows the call; after it, decideForSession
  // has already failed closed for an executor.
}
process.exit(0);
