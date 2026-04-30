#!/usr/bin/env node
/**
 * AI-SDLC Plugin Version-Check Hook (AISDLC-89)
 *
 * SessionStart hook that nags when the bundled plugin version is older than
 * the published latest in the marketplace. Same UX pattern as `pnpm`, `gh`,
 * `kubectl`, `terraform` — a single yellow line, one terminal message, no
 * auto-update.
 *
 * Behavior contract:
 *  - Reads bundled version from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`
 *    (falls back to the script's parent dir if the env var is unset, so the
 *    hook still works under `node check-plugin-version.js` for tests).
 *  - Fetches the marketplace.json from `main` on GitHub raw and parses
 *    `plugins[0].version` as the latest published.
 *  - Caches the latest-version result at `~/.cache/ai-sdlc-plugin/version-check.json`
 *    with a 24h TTL. Subsequent runs within TTL skip the network call.
 *  - On staleness (latest > installed), prints a yellow banner to stderr and
 *    EXITS 0 — never blocks SessionStart. Banner is one-shot per process.
 *  - Silent on every failure mode (offline, 403, malformed JSON, cache parse
 *    error). Last error optionally captured at `~/.cache/ai-sdlc-plugin/last-error.log`
 *    when AI_SDLC_PLUGIN_VERSION_CHECK_DEBUG=1.
 *  - Honors AI_SDLC_DISABLE_VERSION_CHECK=1 — exits immediately, no fetch,
 *    no cache touch.
 *  - Supports two modes:
 *      * Default (no argv): SessionStart hook — read stdin if present, use
 *        cache, print banner only on staleness, output empty JSON on stdout
 *        so Claude Code's hook protocol stays happy.
 *      * `--print` (or argv[2] === 'print'): structured-status mode for
 *        `/ai-sdlc version` — bypasses cache, always fetches, prints a
 *        human-readable status block to stdout (not stderr).
 *
 * Zero new deps — uses node:https + node:fs only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/ai-sdlc-framework/ai-sdlc/main/.claude-plugin/marketplace.json';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ai-sdlc-plugin');
const CACHE_FILE = path.join(CACHE_DIR, 'version-check.json');
const ERROR_LOG = path.join(CACHE_DIR, 'last-error.log');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 3000;

// ── Mode detection ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const PRINT_MODE = argv.includes('--print') || argv.includes('print');

// ── Opt-out short-circuit ───────────────────────────────────────────────
if (process.env.AI_SDLC_DISABLE_VERSION_CHECK === '1') {
  if (PRINT_MODE) {
    process.stdout.write(
      'ai-sdlc plugin version check disabled (AI_SDLC_DISABLE_VERSION_CHECK=1)\n',
    );
  }
  process.exit(0);
}

// ── Main ────────────────────────────────────────────────────────────────
let _ran = false;

// Drain stdin if SessionStart fed us JSON, then run.
//
// Claude Code SessionStart hooks receive a JSON payload on stdin. We don't
// USE it (the version check is independent of the session payload) but we
// still need to drain so the parent doesn't block on an unread pipe. In
// PRINT_MODE we skip stdin entirely — slash-command bash invocations don't
// pass any payload.
if (!PRINT_MODE && process.stdin.isTTY === false) {
  let _drained = '';
  process.stdin.on('data', (chunk) => {
    _drained += chunk;
  });
  process.stdin.on('end', () => {
    void _drained;
    main();
  });
  // Defensive: if stdin doesn't close within 100ms, run anyway so we don't
  // hang SessionStart on an idle pipe.
  setTimeout(() => main(), 100).unref();
} else {
  main();
}

function main() {
  if (_ran) return;
  _ran = true;

  const installed = readInstalledVersion();
  if (!installed && !PRINT_MODE) {
    // Can't compare without a baseline — silent exit on hook path.
    process.exit(0);
  }

  if (PRINT_MODE) {
    // Slash-command path: always re-fetch, always print structured status.
    fetchLatestVersion()
      .then((latest) => {
        const checkedAt = new Date().toISOString();
        if (latest) {
          writeCache({ checkedAt, latestVersion: latest });
        }
        printStatus({ installed: installed || 'unknown', latest, checkedAt });
        process.exit(0);
      })
      .catch((err) => {
        logError(err);
        printStatus({ installed: installed || 'unknown', latest: null, checkedAt: null });
        process.exit(0);
      });
    return;
  }

  // Hook path: try cache first.
  const cached = readCache();
  if (cached && cached.latestVersion && Date.now() - Date.parse(cached.checkedAt) < CACHE_TTL_MS) {
    maybeNag(installed, cached.latestVersion);
    emitEmptyHookResponse();
    return;
  }

  // Cache stale or missing — fetch.
  fetchLatestVersion()
    .then((latest) => {
      if (latest) {
        writeCache({ checkedAt: new Date().toISOString(), latestVersion: latest });
        maybeNag(installed, latest);
      }
      emitEmptyHookResponse();
    })
    .catch((err) => {
      logError(err);
      // Silent on failure — never block SessionStart.
      emitEmptyHookResponse();
    });
}

// ── Helpers ─────────────────────────────────────────────────────────────

function readInstalledVersion() {
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
  const pluginJsonPath = path.join(root, '.claude-plugin', 'plugin.json');
  try {
    const raw = fs.readFileSync(pluginJsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    // Fallback: try the legacy top-level plugin.json some installs may have.
    try {
      const legacy = fs.readFileSync(path.join(root, 'plugin.json'), 'utf-8');
      const parsed = JSON.parse(legacy);
      return typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
      return null;
    }
  }
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.checkedAt === 'string' &&
      typeof parsed.latestVersion === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(entry) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry, null, 2) + '\n', 'utf-8');
  } catch {
    // Cache write failures are non-fatal.
  }
}

function fetchLatestVersion() {
  // Honor a custom override URL for tests.
  const url = process.env.AI_SDLC_PLUGIN_MARKETPLACE_URL || MARKETPLACE_URL;
  const client = url.startsWith('http://') ? http : https;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const v = parsed && parsed.plugins && parsed.plugins[0] && parsed.plugins[0].version;
          if (typeof v !== 'string') {
            reject(new Error('marketplace.json: plugins[0].version missing'));
            return;
          }
          resolve(v);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => reject(err));
  });
}

function maybeNag(installed, latest) {
  if (!installed || !latest) return;
  if (compareSemver(latest, installed) <= 0) return;
  // Yellow ANSI; trailing reset. stderr only — never pollutes stdout, which
  // is reserved for the hook protocol response.
  const YELLOW = '\x1b[33m';
  const RESET = '\x1b[0m';
  process.stderr.write(
    `${YELLOW}⚠ ai-sdlc plugin v${installed} installed, v${latest} available.\n` +
      `  Run: /plugin update ai-sdlc && /reload-plugins\n` +
      `  Changelog: https://github.com/ai-sdlc-framework/ai-sdlc/releases${RESET}\n`,
  );
}

function printStatus({ installed, latest, checkedAt }) {
  const lines = ['ai-sdlc plugin', `- Installed: v${installed}`];
  if (latest) {
    lines.push(`- Latest: v${latest}`);
    lines.push(`- Last checked: ${checkedAt ? formatRelative(checkedAt) : 'just now'}`);
    if (installed === 'unknown') {
      lines.push('- Status: ? installed version unknown');
    } else if (compareSemver(latest, installed) > 0) {
      lines.push('- Status: ⚠ stale — run /plugin update ai-sdlc && /reload-plugins');
    } else {
      lines.push('- Status: ✓ up to date');
    }
  } else {
    lines.push('- Latest: unknown (fetch failed)');
    lines.push('- Status: ? could not reach marketplace.json');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

function formatRelative(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 5) return 'just now';
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

function compareSemver(a, b) {
  // Returns >0 if a>b, <0 if a<b, 0 if equal. Strips a leading `v` and any
  // pre-release tail (everything after `-`). Best-effort — falls back to
  // string compare if either side isn't a valid semver triple.
  const norm = (s) =>
    String(s)
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10));
  const [aMaj, aMin, aPat] = norm(a);
  const [bMaj, bMin, bPat] = norm(b);
  if (![aMaj, aMin, aPat, bMaj, bMin, bPat].every(Number.isFinite)) {
    return String(a).localeCompare(String(b));
  }
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

function emitEmptyHookResponse() {
  // Claude Code SessionStart hooks accept an empty stdout. We write nothing
  // so we don't inject any additionalContext (that's session-start.sh's job).
  process.exit(0);
}

function logError(err) {
  if (process.env.AI_SDLC_PLUGIN_VERSION_CHECK_DEBUG !== '1') return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      ERROR_LOG,
      `${new Date().toISOString()} ${err && err.message ? err.message : String(err)}\n`,
      'utf-8',
    );
  } catch {
    // Logging is best-effort — never throw.
  }
}
