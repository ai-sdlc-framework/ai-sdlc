/**
 * AI-SDLC Context Budget Hook (Stop)
 *
 * Reads the tail of the session's own transcript (its path is in the hook
 * input), and when the last call's context size or the model calls since the
 * last `/clear` exceed the budget of the session's role, prints a one-line
 * notice as `systemMessage`. Under budget, or for a session with no resolvable
 * role, it prints nothing. It never blocks the session (no `decision`) and
 * always exits 0; every failure is swallowed.
 *
 * Role resolution: the hierarchy roster entry for this session, else the
 * session name (`AI_SDLC_SESSION_NAME`, the hook input's `session_name`, or the
 * title recorded in the transcript) read as a role name.
 */

'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  analyzeTranscriptLines,
  buildNotice,
  loadRoleBudgets,
  readTailLines,
  roleFromName,
} = require('./lib/context-budget');
const { ancestorPids, resolveSessionRole } = require('./lib/hierarchy-role');

function readInput() {
  try {
    const text = readFileSync(0, 'utf-8');
    const parsed = text.trim() ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The notice for this Stop event, or null. Never throws.
 *
 * @param {object} input hook input (`transcript_path`, `cwd`, `session_name`).
 * @param {object} [options] test seams: `env`, `pids`, `commOf`.
 */
function contextBudgetNotice(input, options = {}) {
  try {
    const env = options.env || process.env;
    const transcriptPath = input && input.transcript_path;
    if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
    const projectDir = env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();

    const stats = analyzeTranscriptLines(readTailLines(transcriptPath));

    let role = null;
    try {
      const resolved = resolveSessionRole({
        boardDir: env.AI_SDLC_DISPATCH_BOARD_DIR || join(projectDir, '.ai-sdlc', 'dispatch'),
        pids: options.pids || ancestorPids(),
        ...(options.commOf ? { commOf: options.commOf } : {}),
      });
      role = resolved ? resolved.role : null;
    } catch {
      role = null;
    }
    if (!role) {
      role = roleFromName(
        env.AI_SDLC_SESSION_NAME || (input && input.session_name) || stats.sessionName,
      );
    }
    if (!role) return null;

    const budgets = loadRoleBudgets({ env, projectDir });
    return buildNotice(stats, budgets[role], role);
  } catch {
    return null;
  }
}

if (require.main === module) {
  try {
    const notice = contextBudgetNotice(readInput());
    if (notice) process.stdout.write(`${JSON.stringify({ systemMessage: notice })}\n`);
  } catch {
    // never fail the session
  }
  process.exit(0);
}

module.exports = { contextBudgetNotice };
