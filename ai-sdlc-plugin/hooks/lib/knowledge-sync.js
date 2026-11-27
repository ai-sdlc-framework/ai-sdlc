/**
 * Session-start knowledge sync (AISDLC-1460, DEC-0444 option a).
 *
 * When `.ai-sdlc/context.yaml` selects a `knowledge.backend` other than `files`, start
 * `cli-context sync` detached (never awaited) at most once per `knowledge.syncIntervalMinutes`
 * (default 15), debounced by a stamp file, and return one status line from `cli-context status`:
 * queued and rejected counts, the last sync time and, when present, its error.
 * The `files` backend does nothing and returns null. Fails open: any error yields one line at most.
 */

'use strict';

const { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require('fs');
const { spawn: spawnAsync, spawnSync } = require('child_process');
const { join } = require('path');

const DEFAULT_SYNC_INTERVAL_MINUTES = 15;
const LAUNCH_STAMP = join('.ai-sdlc', 'state', 'knowledge-sync-launch');
const STATUS_TIMEOUT_MS = 3000;

function unquote(v) {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
}

/**
 * `knowledge.backend` and `knowledge.syncIntervalMinutes` from the context.yaml text.
 * A minimal line reader: only the direct children of the top-level `knowledge:` block.
 */
function parseKnowledgeSettings(text) {
  const out = { backend: 'files', syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES };
  let inBlock = false;
  let childIndent = -1;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inBlock = /^knowledge:\s*$/.test(line);
      childIndent = -1;
      continue;
    }
    if (!inBlock) continue;
    if (childIndent === -1) childIndent = indent;
    if (indent !== childIndent) continue;
    const m = /^\s*([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = unquote(m[2]);
    if (m[1] === 'backend' && value) out.backend = value;
    if (m[1] === 'syncIntervalMinutes') {
      const n = Number(value);
      if (value !== '' && Number.isFinite(n) && n >= 0) out.syncIntervalMinutes = n;
    }
  }
  return out;
}

function loadKnowledgeSettings(projectDir) {
  const file = join(projectDir, '.ai-sdlc', 'context.yaml');
  if (!existsSync(file)) return parseKnowledgeSettings('');
  return parseKnowledgeSettings(readFileSync(file, 'utf-8'));
}

/** True when a launch happened within the interval; otherwise records one. */
function debounced(projectDir, intervalMinutes, now) {
  const stamp = join(projectDir, LAUNCH_STAMP);
  try {
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < intervalMinutes * 60_000) return true;
    mkdirSync(join(projectDir, '.ai-sdlc', 'state'), { recursive: true });
    writeFileSync(stamp, '');
  } catch {
    // cannot debounce: launch anyway
  }
  return false;
}

function formatStatus(s) {
  const parts = [
    `queued ${Number(s.queued) || 0}`,
    `rejected ${Number(s.rejected) || 0}`,
    `last sync ${s.lastSyncAt || 'never'}`,
  ];
  if (s.lastError) parts.push(`last error: ${s.lastError}`);
  return `knowledge sync: ${parts.join(', ')}`;
}

/**
 * @param {{cmd: string, pre: string[]}} cli resolved cli-context invocation
 * @returns {string|null} the session-start line, or null for the files backend
 */
function knowledgeSessionSync(projectDir, cli, deps = {}) {
  const spawn = deps.spawn || spawnAsync;
  const runSync = deps.spawnSync || spawnSync;
  const now = deps.now || Date.now();
  let settings;
  try {
    settings = loadKnowledgeSettings(projectDir);
  } catch {
    return null;
  }
  if (settings.backend === 'files') return null;
  try {
    if (!debounced(projectDir, settings.syncIntervalMinutes, now)) {
      const child = spawn(cli.cmd, [...cli.pre, 'sync', '--project-dir', projectDir], {
        detached: true,
        stdio: 'ignore',
        cwd: projectDir,
      });
      if (child && typeof child.on === 'function') child.on('error', () => {});
      if (child && typeof child.unref === 'function') child.unref();
    }
    const res = runSync(cli.cmd, [...cli.pre, 'status', '--project-dir', projectDir], {
      encoding: 'utf-8',
      timeout: STATUS_TIMEOUT_MS,
      cwd: projectDir,
    });
    if (!res || res.error || res.status !== 0) return 'knowledge sync: status unavailable';
    const s = JSON.parse(String(res.stdout).trim().split('\n').pop());
    if (!s || s.supported === false) return null;
    return formatStatus(s);
  } catch {
    return 'knowledge sync: status unavailable';
  }
}

module.exports = {
  knowledgeSessionSync,
  parseKnowledgeSettings,
  formatStatus,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  LAUNCH_STAMP,
};
