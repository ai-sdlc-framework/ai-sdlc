/**
 * Context usage warning (AISDLC-728): shared by the status line command
 * (`scripts/context-statusline.mjs`) and the Stop hook (`hooks/context-warn.js`).
 *
 * The status line is the only place Claude Code hands a command the context
 * percentage (`context_window.used_percentage`), so it records that number per
 * session in a small state file; the Stop hook reads it after each turn and warns
 * once per crossing of the upper threshold. Nothing here blocks or refuses.
 *
 * Unverified against current Claude Code docs (offline when written): the exact
 * status line JSON field names, and the Stop hook `systemMessage` output field.
 * Every reader below fails soft when a field is absent.
 */

'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const DEFAULT_WARN_PCT = 30;
const DEFAULT_CRIT_PCT = 40;
const SAFE_SESSION = /^[A-Za-z0-9._-]{1,128}$/;

/** A percentage 1..100 from an env value, else the fallback. */
function parsePct(value, fallback) {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback;
}

/**
 * Two thresholds, warn below crit. A misordered pair falls back to the defaults.
 * @param {Record<string, string | undefined>} [env]
 */
function thresholds(env = process.env) {
  const warn = parsePct(env.AI_SDLC_CONTEXT_WARN_PCT, DEFAULT_WARN_PCT);
  const crit = parsePct(env.AI_SDLC_CONTEXT_CRIT_PCT, DEFAULT_CRIT_PCT);
  return warn < crit ? { warn, crit } : { warn: DEFAULT_WARN_PCT, crit: DEFAULT_CRIT_PCT };
}

/** Context percentage from a status line payload, or null when absent. */
function percentageOf(payload) {
  const raw = payload && payload.context_window && payload.context_window.used_percentage;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Coloured one-line status text: green below warn, yellow from warn, red from crit. */
function renderStatusLine(pct, env = process.env) {
  if (pct === null || pct === undefined) return 'ctx --';
  const { warn, crit } = thresholds(env);
  const code = pct >= crit ? 31 : pct >= warn ? 33 : 32;
  const text = `ctx ${Math.round(pct)}%`;
  return env.NO_COLOR ? text : `\u001b[${code}m${text}\u001b[0m`;
}

function stateDir(env = process.env) {
  return env.AI_SDLC_CONTEXT_STATE_DIR || join(tmpdir(), 'ai-sdlc-context-warn');
}

function stateFile(sessionId, env = process.env) {
  return SAFE_SESSION.test(String(sessionId || ''))
    ? join(stateDir(env), `${sessionId}.json`)
    : null;
}

function readState(sessionId, env = process.env) {
  const file = stateFile(sessionId, env);
  if (!file || !existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

function writeState(sessionId, state, env = process.env) {
  const file = stateFile(sessionId, env);
  if (!file) return false;
  try {
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Record the latest percentage for a session, keeping its `warned` flag. */
function recordPercentage(sessionId, pct, env = process.env) {
  if (pct === null || pct === undefined) return false;
  const prior = readState(sessionId, env) || {};
  return writeState(sessionId, { pct, warned: Boolean(prior.warned) }, env);
}

/** Pasteable compaction line that asks for the handoff content to be kept. */
function compactLine() {
  return (
    '/compact Keep: open rulings, owed items, scheduled jobs and their prompts, next free ' +
    'task and decision ids, what each peer session is waiting on, and the current role ' +
    'skill to re-run. Drop tool output and exploration.'
  );
}

/**
 * Decide whether to warn now. Warns once when the recorded percentage reaches the
 * upper threshold, and re-arms when it falls below the lower one (after a clear
 * or compaction). Updates the state file. Returns the message, or null.
 */
function evaluateWarning(sessionId, env = process.env) {
  const state = readState(sessionId, env);
  if (!state || typeof state.pct !== 'number') return null;
  const { warn, crit } = thresholds(env);
  if (state.pct < warn) {
    if (state.warned) writeState(sessionId, { pct: state.pct, warned: false }, env);
    return null;
  }
  if (state.pct < crit || state.warned) return null;
  writeState(sessionId, { pct: state.pct, warned: true }, env);
  return (
    `Context is at ${Math.round(state.pct)}% (limit ${crit}%). Hand off and clear at the next ` +
    'turn boundary: say "handoff" to write the handoff note, then run /clear (it is reloaded ' +
    `automatically), or compact now with:\n${compactLine()}`
  );
}

module.exports = {
  DEFAULT_WARN_PCT,
  DEFAULT_CRIT_PCT,
  thresholds,
  percentageOf,
  renderStatusLine,
  stateFile,
  readState,
  recordPercentage,
  compactLine,
  evaluateWarning,
};
