/**
 * AI-SDLC Context Auto-Clear Hook (Stop) - AISDLC-766
 *
 * Reads the Stop payload from stdin (`transcript_path`) and, only in a session that
 * sits in a hierarchy roster, runs `cli-hierarchy auto-clear --transcript <path>`.
 * That command reads the context size from the transcript's usage fields, compares
 * it with the role's threshold (planner 150k, dispatch and executors 120k;
 * `contextThresholds` in the board's config.json overrides), and when it is over,
 * refreshes the handoff file and schedules `clear --self` with the role's resume
 * command. At the warn threshold the CLI first answers `warn` and this hook returns a
 * Stop `block` message telling the session to run its handoff routine; the clear comes
 * once the handoff file is rewritten (or at threshold plus 25%). An executor holding an inflight task is deferred until its verdict is
 * written. Every failure is swallowed: a session is never delayed or failed by this.
 *
 * Before that check it also persists the session's last assistant text to
 * `.claude/memory/LAST_MESSAGE.md` (AISDLC-914), so a clear never hides the final reply.
 * `AI_SDLC_LAST_MESSAGE=off` switches that off.
 *
 * Bin resolution is file-existence only ($PIPELINE_CLI_BIN, the plugin's own
 * node_modules, the plugin-relative monorepo checkout); nothing is derived from the
 * project being worked on.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
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

function isLastMessageOff(env) {
  return ['off', '0', 'false', 'no', 'disabled'].includes(
    String(env.AI_SDLC_LAST_MESSAGE || '').toLowerCase(),
  );
}

/** Text blocks of the trailing run of assistant entries in a JSONL transcript. */
function lastAssistantText(raw) {
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }
  const parts = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const role = e && (e.type || (e.message && e.message.role));
    if (role !== 'assistant') {
      if (parts.length) break;
      continue;
    }
    const content = e.message && e.message.content;
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content
              .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
          : [];
    parts.unshift(...texts);
  }
  return parts.join('\n\n').trim();
}

function currentSession(boardDir, env) {
  try {
    const roster = JSON.parse(readFileSync(join(boardDir, 'hierarchy.json'), 'utf-8'));
    const pane = env.TMUX_PANE;
    if (!pane || !Array.isArray(roster.sessions)) return undefined;
    return roster.sessions.find((s) => s && s.paneId === pane && typeof s.name === 'string');
  } catch {
    return undefined;
  }
}

/**
 * Replace this session's section of LAST_MESSAGE.md, keeping other sessions' sections.
 * Returns true when written. Never throws.
 */
function persistLastMessage(transcript, boardDir, env, now = new Date()) {
  try {
    if (isLastMessageOff(env)) return false;
    const session = currentSession(boardDir, env);
    if (!session || !existsSync(transcript)) return false;
    const text = lastAssistantText(readFileSync(transcript, 'utf-8'));
    if (!text) return false;
    const file = join(dirname(dirname(boardDir)), '.claude', 'memory', 'LAST_MESSAGE.md');
    const heading = `## ${session.name}`;
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    const sections = existing
      .split(/^(?=## )/m)
      .filter(
        (sec) =>
          sec.startsWith('## ') &&
          !sec.startsWith(`${heading} `) &&
          !sec.startsWith(`${heading}\n`),
      );
    sections.push(`${heading} (${now.toISOString()})\n\n${text}\n`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `# Last messages\n\n${sections.join('\n')}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The warn message in the CLI's output (one JSON decision per line), or ''. At the warn
 * threshold the CLI answers `action: warn`; the Stop hook relays it so the session gets
 * a turn to run its handoff routine before any clear (AISDLC-870).
 */
function warnMessageOf(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const d = JSON.parse(line);
      return d && d.action === 'warn' && typeof d.message === 'string' ? d.message : '';
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Run the auto-clear check for one Stop payload. Returns a short reason string;
 * never throws.
 * @param {object} payload parsed Stop hook input
 * @param {object} [options] { env, cwd, pluginDir, run, onWarn(message) }
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
    persistLastMessage(transcript, boardDir, env, options.now);
    const bin = resolveBin(env, pluginDir);
    if (!bin) return 'no-cli';
    const run = options.run || spawnSync;
    const res = run(
      process.execPath,
      [bin, 'auto-clear', '--transcript', transcript, '--board-dir', boardDir],
      { cwd, env, encoding: 'utf-8', timeout: TIMEOUT_MS },
    );
    if (!res || res.status !== 0) return 'failed';
    const message = warnMessageOf(res.stdout);
    if (message) {
      if (typeof options.onWarn === 'function') options.onWarn(message);
      return 'warned';
    }
    return 'ran';
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
    runAutoClear(readStdin(), {
      onWarn: (message) =>
        process.stdout.write(JSON.stringify({ decision: 'block', reason: message })),
    });
  } catch {
    // never fail the session
  }
  process.exit(0);
}

module.exports = {
  runAutoClear,
  persistLastMessage,
  lastAssistantText,
  warnMessageOf,
  resolveBin,
  boardDirOf,
};
