/**
 * Large tool output notice (RFC-0050 follow-up, AISDLC-651.5).
 *
 * Raw tool output read into a long-lived session stays in the window for every
 * later turn. For the main-session roster roles (planner, operator-dispatch) a
 * tool result above `spec.output.noticeTokens` of the usage config (default
 * 8000, estimated at four characters per token) draws a one-line notice.
 * Developer and executor sessions, and sessions outside a hierarchy, are exempt.
 *
 * Never throws and never blocks: every failure resolves to "no notice".
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { execFileSync } = require('child_process');
const { dirname, join, resolve } = require('path');
const { homedir } = require('os');

/** Mirrors DEFAULT_OUTPUT_NOTICE_TOKENS in pipeline-cli/src/usage/usage-config.ts. */
const DEFAULT_NOTICE_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;
const NOTICE_ROLES = ['planner', 'operator-dispatch'];
const CONFIG_FILE = 'usage-config.yaml';
const BASE_CONFIG_PATH = '.ai-sdlc/usage-config.yaml';

/** Characters in a PostToolUse `tool_response` (string, or any JSON value). */
function responseSize(response) {
  if (response === undefined || response === null) return 0;
  if (typeof response === 'string') return response.length;
  try {
    return JSON.stringify(response).length;
  } catch {
    return 0;
  }
}

/** `output.noticeTokens` from one config document, or undefined. Plain text scan: no YAML parser here. */
function noticeTokensFromYaml(text) {
  const block = /^[ \t]*output:[ \t]*\n((?:[ \t]+.*(?:\n|$))+)/m.exec(String(text));
  if (!block) return undefined;
  const m = /^[ \t]+noticeTokens:[ \t]*(\d+)[ \t]*(?:#.*)?$/m.exec(block[1]);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Effective threshold: machine-level config, then the base-ref config (read with
 * `git show`, never the working tree), then the default.
 */
function resolveNoticeTokens(env, projectDir, readBase = readBaseConfig) {
  try {
    const dir = env.AI_SDLC_USAGE_DIR || join(homedir(), '.ai-sdlc', 'usage');
    const machine = join(dir, CONFIG_FILE);
    if (existsSync(machine)) {
      const n = noticeTokensFromYaml(readFileSync(machine, 'utf-8'));
      if (n !== undefined) return n;
    }
    const base = readBase(projectDir);
    if (base) {
      const n = noticeTokensFromYaml(base);
      if (n !== undefined) return n;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_NOTICE_TOKENS;
}

function readBaseConfig(projectDir) {
  try {
    return execFileSync('git', ['show', `origin/main:${BASE_CONFIG_PATH}`], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

/** The hierarchy board holding `hierarchy.json`, with plain filesystem checks only. */
function findBoard(env, cwd) {
  const rosterIn = (board) => existsSync(join(board, 'hierarchy.json'));
  if (env.AI_SDLC_DISPATCH_BOARD_DIR) {
    const start = resolve(env.CLAUDE_PROJECT_DIR || cwd);
    return rosterIn(env.AI_SDLC_DISPATCH_BOARD_DIR)
      ? { boardDir: env.AI_SDLC_DISPATCH_BOARD_DIR, projectDir: start }
      : null;
  }
  let dir = resolve(env.CLAUDE_PROJECT_DIR || cwd);
  for (let depth = 0; depth < 12; depth += 1) {
    const board = join(dir, '.ai-sdlc', 'dispatch');
    if (rosterIn(board)) return { boardDir: board, projectDir: dir };
    if (env.CLAUDE_PROJECT_DIR) return null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function formatNotice(chars, threshold) {
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  return (
    `[ai-sdlc] That tool result is about ${tokens} tokens (${chars} characters, over the ${threshold} token notice threshold) ` +
    'and stays in this session for every later turn. For exploration use an Explore subagent; ' +
    'for logs use `tail` or `grep`; write large outputs to the artifacts directory and read back selectively.'
  );
}

/**
 * The notice for one PostToolUse event, or null.
 *
 * @param {object} input the hook input.
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {() => ({role: string} | null)} [opts.resolveRole] test seam; defaults to the roster lookup.
 * @param {(projectDir: string) => (string | null)} [opts.readBase] test seam for the base-ref config.
 * @returns {string | null}
 */
function largeOutputNotice(input, opts = {}) {
  try {
    const env = opts.env || process.env;
    const chars = responseSize(input && input.tool_response);
    // Cheapest exit first: nothing below the smallest sensible threshold needs a role lookup.
    if (chars < CHARS_PER_TOKEN) return null;

    const cwd = input && typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const found = findBoard(env, cwd);
    if (!found) return null;

    let role;
    if (opts.resolveRole) {
      const session = opts.resolveRole(found);
      role = session && session.role;
    } else {
      const { resolveSessionRole, ancestorPids } = require('./hierarchy-role');
      const session = resolveSessionRole({ boardDir: found.boardDir, pids: ancestorPids() });
      role = session && session.role;
    }
    if (!NOTICE_ROLES.includes(role)) return null;

    const threshold = resolveNoticeTokens(env, found.projectDir, opts.readBase);
    return chars > threshold * CHARS_PER_TOKEN ? formatNotice(chars, threshold) : null;
  } catch {
    return null;
  }
}

module.exports = {
  largeOutputNotice,
  noticeTokensFromYaml,
  resolveNoticeTokens,
  responseSize,
  DEFAULT_NOTICE_TOKENS,
  NOTICE_ROLES,
};
