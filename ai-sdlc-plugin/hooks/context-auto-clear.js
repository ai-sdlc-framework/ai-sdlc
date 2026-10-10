/**
 * AI-SDLC Context Auto-Clear Hook (Stop) - AISDLC-766
 *
 * Reads the Stop payload from stdin (`transcript_path`) and, only in a session that
 * sits in a hierarchy roster, runs `cli-hierarchy auto-clear --transcript <path>`.
 * That command reads the context size from the transcript's usage fields, compares
 * it with the role's threshold (planner 150k, dispatch and executors 120k;
 * `contextThresholds` in the board's config.json overrides), and when it is over,
 * refreshes the handoff file and schedules `clear --self` with the role's resume
 * command. An executor holding an inflight task is deferred until its verdict is
 * written. Every failure is swallowed: a session is never delayed or failed by this.
 *
 * Bin resolution is file-existence only ($PIPELINE_CLI_BIN, the plugin's own
 * node_modules, the plugin-relative monorepo checkout); nothing is derived from the
 * project being worked on.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const BIN_NAME = 'cli-hierarchy.mjs';
const PIPELINE_CLI_REL = join('node_modules', '@ai-sdlc', 'pipeline-cli', 'bin');
const TIMEOUT_MS = 15_000;

function isOff(env) {
  return ['off', '0', 'false', 'no', 'disabled'].includes(
    String(env.AI_SDLC_AUTO_CLEAR || '').toLowerCase(),
  );
}

function resolveBin(env, pluginDir) {
  const candidates = [];
  if (env.PIPELINE_CLI_BIN) candidates.push(join(env.PIPELINE_CLI_BIN, BIN_NAME));
  if (env.CLAUDE_PLUGIN_ROOT)
    candidates.push(join(env.CLAUDE_PLUGIN_ROOT, PIPELINE_CLI_REL, BIN_NAME));
  candidates.push(join(pluginDir, PIPELINE_CLI_REL, BIN_NAME));
  candidates.push(join(pluginDir, '..', 'pipeline-cli', 'bin', BIN_NAME));
  return candidates.find((c) => existsSync(c));
}

/**
 * Board directory: the env override, else the working directory's board, else (inside a
 * worktree, which an executor works in mid-task) the main checkout's board.
 */
function boardDirOf(env, cwd, git = gitCommonDir) {
  if (env.AI_SDLC_DISPATCH_BOARD_DIR) return env.AI_SDLC_DISPATCH_BOARD_DIR;
  const local = join(cwd, '.ai-sdlc', 'dispatch');
  if (existsSync(join(local, 'hierarchy.json'))) return local;
  const common = git(cwd);
  return common ? join(dirname(common), '.ai-sdlc', 'dispatch') : local;
}

function gitCommonDir(cwd) {
  try {
    const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
    });
    return res.status === 0 ? String(res.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

/**
 * Run the auto-clear check for one Stop payload. Returns a short reason string;
 * never throws.
 * @param {object} payload parsed Stop hook input
 * @param {object} [options] { env, cwd, pluginDir, run }
 */
function runAutoClear(payload, options = {}) {
  try {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const pluginDir = options.pluginDir || join(__dirname, '..');
    if (env.CLAUDE_CODE_ENV === 'ccr' || env.CLAUDE_REMOTE_EXECUTION === '1')
      return 'remote-sandbox';
    if (isOff(env)) return 'switched-off';
    const transcript = payload && payload.transcript_path;
    if (typeof transcript !== 'string' || !transcript) return 'no-transcript';
    const boardDir = resolve(boardDirOf(env, cwd));
    // Cheap exit for every session that is not in a hierarchy roster.
    if (!existsSync(join(boardDir, 'hierarchy.json'))) return 'no-roster';
    const bin = resolveBin(env, pluginDir);
    if (!bin) return 'no-cli';
    const run = options.run || spawnSync;
    const res = run(
      process.execPath,
      [bin, 'auto-clear', '--transcript', transcript, '--board-dir', boardDir],
      { cwd, env, encoding: 'utf-8', timeout: TIMEOUT_MS },
    );
    return res && res.status === 0 ? 'ran' : 'failed';
  } catch {
    return 'failed';
  }
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf-8') || '{}');
  } catch {
    return {};
  }
}

if (require.main === module) {
  try {
    runAutoClear(readStdin());
  } catch {
    // never fail the session
  }
  process.exit(0);
}

module.exports = { runAutoClear, resolveBin, boardDirOf };
