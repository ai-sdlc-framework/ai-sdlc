/**
 * AI-SDLC Usage Ingest Hook (Stop + SessionStart)
 *
 * Launches `cli-usage ingest` detached so the machine-level usage ledger stays
 * current. The hook itself never waits for the ingester: it spawns an unref'd
 * child with ignored stdio and a hard time limit (`--max-seconds`), then exits
 * 0 at once. Every failure (no pipeline-cli installed, spawn error, unwritable
 * directory) is swallowed, so a session is never delayed or failed by it.
 *
 * The ingester itself is a no-op in a remote sandbox; this hook also skips the
 * launch there so no process is started at all.
 *
 * Bin resolution is file-existence only (no install, no network, no scan of the
 * user-writable plugin cache): $PIPELINE_CLI_BIN, then the plugin's own
 * node_modules, then the monorepo checkout.
 */

'use strict';

const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, statSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const BIN_NAME = 'cli-usage.mjs';
const MAX_SECONDS = 25;
/** Stop fires every turn; launch at most once per this window. */
const DEBOUNCE_MS = 20_000;
const STAMP_FILE = '.ingest-launch';
const PIPELINE_CLI_REL = join('node_modules', '@ai-sdlc', 'pipeline-cli', 'bin');

function isOff(env) {
  return ['off', '0', 'false', 'no', 'disabled'].includes(
    String(env.AI_SDLC_USAGE_INGEST || '').toLowerCase(),
  );
}

function isRemoteSandbox(env) {
  return env.CLAUDE_CODE_ENV === 'ccr' || env.CLAUDE_REMOTE_EXECUTION === '1';
}

/** Path of cli-usage.mjs, or undefined when none is installed. */
function resolveBin(env, pluginDir, cwd) {
  const candidates = [];
  if (env.PIPELINE_CLI_BIN) candidates.push(join(env.PIPELINE_CLI_BIN, BIN_NAME));
  if (env.CLAUDE_PLUGIN_ROOT)
    candidates.push(join(env.CLAUDE_PLUGIN_ROOT, PIPELINE_CLI_REL, BIN_NAME));
  if (env.CLAUDE_PLUGIN_DIR)
    candidates.push(join(env.CLAUDE_PLUGIN_DIR, PIPELINE_CLI_REL, BIN_NAME));
  candidates.push(join(pluginDir, PIPELINE_CLI_REL, BIN_NAME));
  candidates.push(join(pluginDir, '..', 'pipeline-cli', 'bin', BIN_NAME));
  candidates.push(join(cwd, 'pipeline-cli', 'bin', BIN_NAME));
  return candidates.find((c) => existsSync(c));
}

function usageDirOf(env) {
  return env.AI_SDLC_USAGE_DIR || join(homedir(), '.ai-sdlc', 'usage');
}

/** True when a launch happened within the debounce window; otherwise records one. */
function debounced(env, now) {
  try {
    const dir = usageDirOf(env);
    const stamp = join(dir, STAMP_FILE);
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < DEBOUNCE_MS) return true;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(stamp, '', { mode: 0o600 });
  } catch {
    // cannot debounce: launch anyway
  }
  return false;
}

/**
 * Launch ingestion in the background. Returns a short reason string; never
 * throws and never waits for the child.
 */
function launchIngest(options = {}) {
  try {
    const env = options.env || process.env;
    const pluginDir = options.pluginDir || join(__dirname, '..');
    const cwd = options.cwd || process.cwd();
    if (isRemoteSandbox(env)) return 'remote-sandbox';
    if (isOff(env)) return 'switched-off';
    const bin = resolveBin(env, pluginDir, cwd);
    if (!bin) return 'no-ingester';
    if (debounced(env, Date.now())) return 'debounced';
    const child = spawn(process.execPath, [bin, 'ingest', '--max-seconds', String(MAX_SECONDS)], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', () => {});
    child.unref();
    return 'launched';
  } catch {
    return 'failed';
  }
}

if (require.main === module) {
  try {
    launchIngest();
  } catch {
    // never fail the session
  }
  process.exit(0);
}

module.exports = { launchIngest, resolveBin, MAX_SECONDS, DEBOUNCE_MS };
