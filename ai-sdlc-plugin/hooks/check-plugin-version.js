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
 * AISDLC-439 (DEC-0001): MCP server tarball DSSE attestation verification.
 *  - On SessionStart, verifies that the installed @ai-sdlc/plugin-mcp-server
 *    tarball's SHA-512 matches the signed DSSE envelope committed to
 *    .ai-sdlc/attestations/mcp-server-<version>.dsse.json in the plugin root.
 *  - Validates the envelope signature against .ai-sdlc/trusted-reviewers.yaml
 *    (same trust root as v6 review attestations — no new pubkey config).
 *  - On failure: prints a RED operator-actionable error to stderr (names the
 *    expected vs actual SHA, points at the trusted-reviewers entry, and hints
 *    at the recovery path). Exits 0 (soft-fail) to avoid blocking SessionStart
 *    entirely, but flags the failure prominently so operators notice.
 *  - Honors AI_SDLC_SKIP_TARBALL_VERIFY=1 — skips tarball verification
 *    entirely (useful during local development with unsigned builds).
 *  - Honors AI_SDLC_TARBALL_VERIFY_HARD_FAIL=1 — exits 1 on any verification
 *    failure (use to enforce strict mode in controlled environments).
 *
 * Zero new deps — uses node:https + node:fs + node:crypto + node:child_process only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const childProcess = require('child_process');

const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/ai-sdlc-framework/ai-sdlc/main/.claude-plugin/marketplace.json';
const CACHE_DIR = path.join(os.homedir(), '.cache', 'ai-sdlc-plugin');
const CACHE_FILE = path.join(CACHE_DIR, 'version-check.json');
const ERROR_LOG = path.join(CACHE_DIR, 'last-error.log');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 3000;

// ── AISDLC-439: MCP server tarball DSSE attestation verification ────────
//
// Predicate type URI — must match sign-mcp-tarball.mjs TARBALL_PREDICATE_TYPE.
const TARBALL_PREDICATE_TYPE = 'https://ai-sdlc.io/mcp-server-tarball/v1';
// MCP server package name as published to npm.
const MCP_SERVER_PACKAGE = '@ai-sdlc/plugin-mcp-server';

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
    // AISDLC-439: run tarball verification even on cache-hit path (signature
    // verification is local/fast — no network call).
    verifyMcpServerTarball(installed);
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
      // AISDLC-439: run tarball verification after marketplace check.
      verifyMcpServerTarball(installed);
      emitEmptyHookResponse();
    })
    .catch((err) => {
      logError(err);
      // Silent on version-check failure — never block SessionStart.
      // Still attempt tarball verification (it's independent of marketplace fetch).
      verifyMcpServerTarball(installed);
      emitEmptyHookResponse();
    });
}

// ── AISDLC-439: MCP server tarball DSSE attestation verification ─────────
//
// Verifies the installed @ai-sdlc/plugin-mcp-server tarball against the
// signed DSSE envelope committed to .ai-sdlc/attestations/. Runs on every
// SessionStart, but is fast (all local — no network call after first install).
//
// Soft-fail by default: prints a red warning to stderr but exits 0 so
// SessionStart is never blocked. Set AI_SDLC_TARBALL_VERIFY_HARD_FAIL=1 to
// exit 1 on any failure (strict / controlled environments only).

function verifyMcpServerTarball(installedVersion) {
  // Opt-out for local dev, unsigned builds, or when the operator explicitly
  // trusts the installed binary without attestation.
  if (process.env.AI_SDLC_SKIP_TARBALL_VERIFY === '1') {
    return;
  }

  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    if (!installedVersion) return;

    // Resolve the installed MCP server binary to compute its tarball SHA.
    // The MCP server is installed under CLAUDE_PLUGIN_ROOT/node_modules/.
    const mcpServerPkgPath = path.join(
      pluginRoot,
      'node_modules',
      '@ai-sdlc',
      'plugin-mcp-server',
      'package.json',
    );
    if (!fs.existsSync(mcpServerPkgPath)) {
      // MCP server not yet installed — skip verification (install-runtime-deps
      // will handle this; session-start.js surfaces the install warning).
      return;
    }

    const mcpPkg = JSON.parse(fs.readFileSync(mcpServerPkgPath, 'utf-8'));
    const mcpVersion = mcpPkg.version;
    if (!mcpVersion) return;
    // Reject anything that isn't a plain semver — `mcpVersion` flows into a
    // filesystem path below; a compromised package.json with `"version":
    // "../../trusted-reviewers"` would otherwise resolve outside `.ai-sdlc/
    // attestations/`. Pre-release / build-metadata suffixes are allowed
    // (e.g. `1.2.3-rc.1+build.42`).
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(mcpVersion)) {
      warnTarballVerification(
        `mcp-server package.json version is not valid semver: ${mcpVersion}`,
        mcpVersion,
      );
      return;
    }

    // Locate signed envelope.
    const envelopePath = path.join(
      pluginRoot,
      '.ai-sdlc',
      'attestations',
      `mcp-server-${mcpVersion}.dsse.json`,
    );
    if (!fs.existsSync(envelopePath)) {
      // Envelope missing — soft-fail with an informational message.
      const RED = '\x1b[31m';
      const RESET = '\x1b[0m';
      process.stderr.write(
        `${RED}⚠ ai-sdlc: MCP server tarball attestation missing for v${mcpVersion}.\n` +
          `  Expected: ${envelopePath}\n` +
          `  Run: git -C "$CLAUDE_PLUGIN_ROOT" pull --ff-only  to refresh.\n` +
          `  See: docs/operations/mcp-server-signing.md${RESET}\n`,
      );
      if (process.env.AI_SDLC_TARBALL_VERIFY_HARD_FAIL === '1') {
        process.exit(1);
      }
      return;
    }

    // Load trusted-reviewers.yaml for pubkey set.
    const trustedReviewersPath = path.join(pluginRoot, '.ai-sdlc', 'trusted-reviewers.yaml');
    if (!fs.existsSync(trustedReviewersPath)) {
      // No trusted-reviewers.yaml — skip; likely a non-project-tree install.
      return;
    }
    const trustedReviewers = parseTrustedReviewersYamlSync(
      fs.readFileSync(trustedReviewersPath, 'utf-8'),
    );
    if (trustedReviewers.length === 0) return;

    // Load envelope.
    let envelope;
    try {
      envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf-8'));
    } catch {
      warnTarballVerification(
        `Attestation envelope is corrupt (JSON parse error): ${envelopePath}`,
        mcpVersion,
      );
      return;
    }

    // Validate predicateType.
    if (envelope.payloadType !== TARBALL_PREDICATE_TYPE) {
      warnTarballVerification(
        `Attestation envelope has unexpected predicateType: ${envelope.payloadType}`,
        mcpVersion,
      );
      return;
    }

    // Decode predicate to get signed SHA.
    let predicate;
    try {
      predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
    } catch {
      warnTarballVerification(`Attestation envelope payload is corrupt`, mcpVersion);
      return;
    }
    const signedSha512 = predicate?.predicate?.sha512 ?? predicate?.subject?.[0]?.digest?.sha512;
    if (!signedSha512) {
      warnTarballVerification('Attestation envelope missing sha512 field', mcpVersion);
      return;
    }

    // Compute actual SHA-512 of the installed MCP server dist bundle and
    // compare it against signedSha512 from the envelope. Without this
    // comparison the hook only confirms the envelope is signed by a trusted
    // reviewer — it does NOT confirm the envelope describes the installed
    // bytes. The primary supply-chain attack DSSE protects against (attacker
    // replaces dist/bin.js while keeping the legitimate envelope) is silently
    // bypassed when this comparison is skipped.
    //
    // We hash `dist/bin.js` (the primary entry point in the tarball) plus
    // each `predicate.distFiles[]` entry the signer recorded in
    // sign-mcp-tarball.mjs. For envelopes without `distFiles` (legacy or the
    // common single-binary case), comparing the bin.js sha is the entire
    // check; the standalone scripts/verify-mcp-tarball.mjs re-packs and
    // verifies the full tarball SHA-512 for fully strict verification.
    const mcpServerDistBin = path.join(
      pluginRoot,
      'node_modules',
      '@ai-sdlc',
      'plugin-mcp-server',
      'dist',
      'bin.js',
    );
    if (!fs.existsSync(mcpServerDistBin)) {
      // dist not built — skip (install-runtime-deps handles this).
      return;
    }

    // signedSha512 may describe either the full tarball OR a per-file digest
    // map. If the predicate contains a distFiles[] manifest (sign-mcp-tarball
    // emits this for per-file integrity), compare each entry; otherwise
    // compare bin.js against the top-level signedSha512.
    const distFiles = predicate?.predicate?.distFiles;
    if (Array.isArray(distFiles) && distFiles.length > 0) {
      for (const entry of distFiles) {
        if (!entry || typeof entry.path !== 'string' || typeof entry.sha512 !== 'string') {
          warnTarballVerification(`distFiles entry malformed in envelope`, mcpVersion);
          return;
        }
        // Defense-in-depth: refuse entries that escape the dist root.
        const normalized = path.posix.normalize(entry.path);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
          warnTarballVerification(
            `distFiles entry has unsafe path: ${entry.path}`,
            mcpVersion,
          );
          return;
        }
        const entryAbs = path.join(
          pluginRoot,
          'node_modules',
          '@ai-sdlc',
          'plugin-mcp-server',
          normalized,
        );
        if (!fs.existsSync(entryAbs)) continue; // missing file — likely partial install
        const actual = crypto
          .createHash('sha512')
          .update(fs.readFileSync(entryAbs))
          .digest('hex');
        if (actual !== entry.sha512) {
          warnTarballVerification(
            `tarball SHA-512 mismatch for ${entry.path}: installed bytes differ from signed envelope`,
            mcpVersion,
          );
          return;
        }
      }
    } else {
      // Legacy envelope (pre-distFiles signer): top-level signedSha512 is the
      // FULL TARBALL hash — we cannot reconstruct that locally without
      // re-packing. A naive comparison against dist/bin.js's SHA would always
      // mismatch (different bytes, different sizes). Skip per-file byte
      // verification on this path and rely on the DSSE signature check
      // below — operator should re-sign with the post-AISDLC-439 signer to
      // get per-file verification. Soft-warn so the staleness is visible.
      warnTarballVerification(
        `envelope is legacy (no distFiles[]) — per-file byte verification skipped; ` +
          `re-sign with scripts/sign-mcp-tarball.mjs to enable.`,
        mcpVersion,
      );
    }

    // Verify DSSE signature against any-of-N trusted-reviewers pubkeys.
    const paeType = TARBALL_PREDICATE_TYPE;
    const payloadBuf = Buffer.from(envelope.payload, 'base64');
    const pae = Buffer.concat([
      Buffer.from('DSSEv1 '),
      Buffer.from(String(paeType.length) + ' '),
      Buffer.from(paeType, 'utf-8'),
      Buffer.from(' '),
      Buffer.from(String(payloadBuf.length) + ' '),
      payloadBuf,
    ]);

    let signatureValid = false;
    let matchedIdentity = null;
    const pemHeader = '-----BEGIN PUBLIC KEY-----';
    for (const reviewer of trustedReviewers) {
      if (!reviewer.pubkey) continue;
      try {
        const pem = reviewer.pubkey.includes(pemHeader)
          ? reviewer.pubkey
          : `${pemHeader}\n${reviewer.pubkey}\n-----END PUBLIC KEY-----`;
        const pubKey = crypto.createPublicKey(pem);
        for (const sig of envelope.signatures || []) {
          const sigBuf = Buffer.from(sig.sig, 'base64');
          if (crypto.verify(null, pae, pubKey, sigBuf)) {
            signatureValid = true;
            matchedIdentity = reviewer.identity;
            break;
          }
        }
        if (signatureValid) break;
      } catch {
        // Invalid pubkey format — skip this entry.
      }
    }

    if (!signatureValid) {
      const RED = '\x1b[31m';
      const RESET = '\x1b[0m';
      const msg =
        `${RED}SECURITY WARNING: ai-sdlc MCP server tarball signature INVALID for v${mcpVersion}.\n` +
        `  Envelope:          ${envelopePath}\n` +
        `  Trusted reviewers: ${trustedReviewersPath}\n` +
        `  No trusted key matched the DSSE signature.\n` +
        `  Recovery: git -C "$CLAUDE_PLUGIN_ROOT" log -- .ai-sdlc/trusted-reviewers.yaml\n` +
        `  See: docs/operations/mcp-server-signing.md${RESET}\n`;
      process.stderr.write(msg);
      if (process.env.AI_SDLC_TARBALL_VERIFY_HARD_FAIL === '1') {
        process.exit(1);
      }
      return;
    }

    // Signature is valid. Log success in debug mode.
    if (process.env.AI_SDLC_PLUGIN_VERSION_CHECK_DEBUG === '1') {
      process.stderr.write(
        `[check-plugin-version] MCP server tarball attestation OK v${mcpVersion} (signer: ${matchedIdentity})\n`,
      );
    }
  } catch (err) {
    // Unexpected error — log in debug mode, never block SessionStart.
    logError(err);
  }
}

function warnTarballVerification(msg, version) {
  const RED = '\x1b[31m';
  const RESET = '\x1b[0m';
  process.stderr.write(
    `${RED}⚠ ai-sdlc: MCP server tarball verification failed (v${version}): ${msg}${RESET}\n` +
      `  See: docs/operations/mcp-server-signing.md\n`,
  );
  if (process.env.AI_SDLC_TARBALL_VERIFY_HARD_FAIL === '1') {
    process.exit(1);
  }
}

/**
 * Synchronous hand-rolled YAML parser for trusted-reviewers.yaml.
 * Returns [{ identity, pubkey }] — only fields needed for signature verify.
 *
 * Must match parseTrustedReviewersYaml() in scripts/verify-mcp-tarball.mjs.
 * This is an intentional duplication: check-plugin-version.js is a CJS
 * CommonJS file that cannot import ESM modules. Keeping it inline avoids
 * forking the crypto dependency chain.
 */
function parseTrustedReviewersYamlSync(raw) {
  const lines = raw.split('\n');
  const entries = [];
  let current = null;
  let inPubkey = false;
  let pubkeyLines = [];

  function flush() {
    if (current) {
      if (inPubkey && pubkeyLines.length > 0) {
        current.pubkey = pubkeyLines.join('\n');
      }
      if (current.identity && current.pubkey) entries.push(current);
    }
    inPubkey = false;
    pubkeyLines = [];
  }

  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) {
      if (inPubkey) {
        // blank line ends pubkey block
        if (pubkeyLines.length > 0 && current) {
          current.pubkey = pubkeyLines.join('\n');
        }
        inPubkey = false;
        pubkeyLines = [];
      }
      continue;
    }

    const entryMatch = line.match(/^\s+-\s+identity:\s+'([^']+)'/);
    if (entryMatch) {
      flush();
      current = { identity: entryMatch[1] };
      inPubkey = false;
      pubkeyLines = [];
      continue;
    }

    if (!current) continue;

    if (/^\s+pubkey:\s*\|/.test(line)) {
      inPubkey = true;
      pubkeyLines = [];
      continue;
    }

    if (inPubkey) {
      if (/^\s{4}/.test(line)) {
        pubkeyLines.push(line.trim());
        continue;
      } else {
        if (pubkeyLines.length > 0) {
          current.pubkey = pubkeyLines.join('\n');
        }
        inPubkey = false;
        pubkeyLines = [];
      }
    }
  }

  flush();
  return entries;
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
