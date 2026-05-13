#!/usr/bin/env node
/**
 * scripts/audit-with-ignores.mjs — AISDLC-264
 *
 * Pre-push audit gate with per-CVE time-bound exemption support.
 *
 * Usage:
 *   node scripts/audit-with-ignores.mjs [--ignores <path>] [--audit-level <level>]
 *
 * Options:
 *   --ignores <path>        Path to the audit-ignores file (default: .audit-ignores.json)
 *   --audit-level <level>   Severity threshold: info|low|moderate|high|critical (default: high)
 *   --dry-run               Print what would happen but do not exit non-zero
 *   --artifacts-dir <path>  Override ARTIFACTS_DIR for audit log location
 *
 * Environment variables:
 *   ARTIFACTS_DIR           Base directory for audit artifacts (default: .artifacts)
 *                           Audit log is written to $ARTIFACTS_DIR/_audit/audit.jsonl
 *
 * Exit codes:
 *   0  All high+ advisories are either absent or covered by non-expired ignore entries
 *   1  One or more high+ advisories are NOT covered (or have expired ignore entries)
 *   2  Unexpected error (pnpm audit unavailable, JSON parse failure, etc.)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let ignoresPath = join(REPO_ROOT, '.audit-ignores.json');
let auditLevel = 'high';
let dryRun = false;
let artifactsDirOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ignores' && args[i + 1]) {
    ignoresPath = resolve(args[++i]);
  } else if (args[i] === '--audit-level' && args[i + 1]) {
    auditLevel = args[++i];
  } else if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--artifacts-dir' && args[i + 1]) {
    artifactsDirOverride = resolve(args[++i]);
  }
}

const SEVERITY_LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
if (!SEVERITY_LEVELS.includes(auditLevel)) {
  process.stderr.write(
    `[audit-gate] ERROR: invalid --audit-level "${auditLevel}". Valid: ${SEVERITY_LEVELS.join(', ')}\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the ignores file. Returns [] if the file does not exist.
 * @param {string} path
 * @returns {Array<{cveId: string, justification: string, expiresAt: string}>}
 */
function loadIgnores(path) {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      process.stderr.write(`[audit-gate] WARN: ${path} is not a JSON array — ignoring the file.\n`);
      return [];
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`[audit-gate] ERROR: failed to parse ${path}: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * Returns true iff the ignore entry is still active (not yet expired).
 * @param {{expiresAt: string}} entry
 * @param {Date} now
 * @returns {boolean}
 */
export function isActive(entry, now = new Date()) {
  const expiry = new Date(entry.expiresAt);
  return expiry > now;
}

/**
 * Build a lookup map from cveId → ignore entry (only active entries).
 * Expired entries are surfaced in the summary but do NOT suppress the advisory.
 * @param {Array<{cveId: string, justification: string, expiresAt: string}>} ignores
 * @param {Date} now
 * @returns {{active: Map<string, object>, expired: Array<object>}}
 */
export function partitionIgnores(ignores, now = new Date()) {
  const active = new Map();
  const expired = [];
  for (const entry of ignores) {
    if (isActive(entry, now)) {
      active.set(entry.cveId, entry);
    } else {
      expired.push(entry);
    }
  }
  return { active, expired };
}

/**
 * Run `pnpm audit --json` and return the parsed output.
 * @param {string} cwd
 * @returns {object}
 */
function runPnpmAudit(cwd) {
  const result = spawnSync('pnpm', ['audit', '--json'], {
    cwd,
    encoding: 'utf-8',
    // pnpm audit exits non-zero when vulnerabilities are found — capture output anyway.
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    process.stderr.write(`[audit-gate] ERROR: failed to spawn pnpm: ${result.error.message}\n`);
    process.exit(2);
  }

  const stdout = result.stdout ?? '';
  if (!stdout.trim()) {
    // No JSON output — pnpm may not be installed or wrong cwd.
    if (result.stderr) {
      process.stderr.write(`[audit-gate] pnpm stderr: ${result.stderr}\n`);
    }
    process.stderr.write('[audit-gate] ERROR: pnpm audit produced no output.\n');
    process.exit(2);
  }

  try {
    return JSON.parse(stdout);
  } catch (err) {
    process.stderr.write(`[audit-gate] ERROR: could not parse pnpm audit JSON: ${err.message}\n`);
    process.stderr.write(`[audit-gate] Raw output (first 500 chars): ${stdout.slice(0, 500)}\n`);
    process.exit(2);
  }
}

/**
 * Extract advisories at or above the configured severity level from pnpm audit JSON.
 * pnpm audit --json shape (v7+):
 *   { advisories: { [id]: { id, title, severity, cves: string[], ghsas: string[], ... } }, ... }
 * OR the newer shape:
 *   { vulnerabilities: { [name]: { severity, via, ... } }, metadata: { vulnerabilities: {...} } }
 *
 * We support both shapes and normalise to a flat list of { id, severity, title, affectedPackage }.
 * @param {object} auditJson
 * @param {string} minSeverity
 * @returns {Array<{id: string, severity: string, title: string, affectedPackage: string}>}
 */
export function extractAdvisories(auditJson, minSeverity) {
  const minIndex = SEVERITY_LEVELS.indexOf(minSeverity);
  const findings = [];

  // Shape A: { advisories: { [id]: { ... } } }
  if (auditJson && auditJson.advisories && typeof auditJson.advisories === 'object') {
    for (const [, adv] of Object.entries(auditJson.advisories)) {
      const sevIndex = SEVERITY_LEVELS.indexOf(adv.severity);
      if (sevIndex >= minIndex) {
        // Collect all identifiers: GHSA ids, CVE ids from the advisory.
        const ids = [
          ...(adv.ghsas ?? []),
          ...(adv.cves ?? []),
          // Some pnpm versions use `id` as the primary key (numeric string like "1234")
          // and also embed ghsas in the object. Always include the GHSA from `url` if present.
        ].filter(Boolean);

        // Include the advisory's own `id` field if it looks like a CVE or GHSA.
        if (adv.id && /^(CVE-|GHSA-)/.test(String(adv.id))) {
          ids.unshift(String(adv.id));
        }

        // Deduplicate while preserving order.
        const uniqueIds = [...new Set(ids)];

        findings.push({
          ids: uniqueIds.length > 0 ? uniqueIds : [String(adv.id ?? 'UNKNOWN')],
          severity: adv.severity,
          title: adv.title ?? adv.overview ?? 'No title',
          affectedPackage: adv.module_name ?? adv.name ?? 'unknown',
        });
      }
    }
    return findings;
  }

  // Shape B: { vulnerabilities: { [pkgName]: { severity, via, ... } } }
  if (auditJson && auditJson.vulnerabilities && typeof auditJson.vulnerabilities === 'object') {
    for (const [pkgName, vuln] of Object.entries(auditJson.vulnerabilities)) {
      const sevIndex = SEVERITY_LEVELS.indexOf(vuln.severity);
      if (sevIndex >= minIndex) {
        // `via` is an array of strings (dependency chain) or objects (direct advisories).
        const advisoryVias = (vuln.via ?? []).filter((v) => typeof v === 'object' && v.url);
        for (const via of advisoryVias) {
          const ids = [];
          // Extract GHSA from the advisory URL (e.g. https://github.com/advisories/GHSA-xxxx-yyyy-zzzz)
          if (via.url) {
            const m = via.url.match(/GHSA-[a-z0-9-]+/i);
            if (m) ids.push(m[0].toUpperCase());
          }
          if (via.cve) ids.push(via.cve);
          findings.push({
            ids: ids.length > 0 ? ids : ['UNKNOWN'],
            severity: vuln.severity,
            title: via.title ?? 'No title',
            affectedPackage: pkgName,
          });
        }
        // If no advisory vias (pure transitive chain node), still record it.
        if (advisoryVias.length === 0) {
          findings.push({
            ids: ['UNKNOWN'],
            severity: vuln.severity,
            title: `Transitive vulnerability in ${pkgName}`,
            affectedPackage: pkgName,
          });
        }
      }
    }
    return findings;
  }

  // Unknown shape — return empty (gate passes; user should investigate).
  process.stderr.write(
    '[audit-gate] WARN: unrecognised pnpm audit JSON shape; no advisories extracted.\n',
  );
  return findings;
}

/**
 * Append a single JSON line to the audit log.
 * Creates the parent directory if it does not exist.
 * @param {string} logPath
 * @param {object} entry
 */
export function appendAuditLog(logPath, entry) {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Core logic — exported for hermetic testing (callers can inject mocked inputs).
 *
 * @param {object} opts
 * @param {object}   opts.auditJson      - Parsed pnpm audit JSON (or mocked equivalent)
 * @param {Array}    opts.ignores        - Raw ignore entries from .audit-ignores.json
 * @param {string}   opts.minSeverity    - Severity threshold (default: 'high')
 * @param {string}   opts.logPath        - Full path for audit.jsonl (or null to skip)
 * @param {Date}    [opts.now]           - Override "now" for expiry checks (default: new Date())
 * @param {boolean} [opts.dryRun]        - If true, never exit non-zero
 * @returns {{
 *   blockers: Array,        advisories that are NOT covered
 *   suppressed: Array,      advisories suppressed by active ignores
 *   expiredIgnores: Array,  ignore entries that are past expiresAt
 *   exitCode: number        0 = pass, 1 = fail, 2 = error
 * }}
 */
export function runAuditGate({
  auditJson,
  ignores,
  minSeverity = 'high',
  logPath = null,
  now = new Date(),
  dryRun: isDryRun = false,
}) {
  const { active, expired: expiredIgnores } = partitionIgnores(ignores, now);
  const advisories = extractAdvisories(auditJson, minSeverity);

  const blockers = [];
  const suppressed = [];

  for (const advisory of advisories) {
    // Check if ANY of the advisory's IDs matches an active ignore entry.
    const matchedIgnore = advisory.ids.map((id) => active.get(id)).find((entry) => entry != null);

    if (matchedIgnore) {
      suppressed.push({ advisory, ignore: matchedIgnore });
    } else {
      blockers.push(advisory);
    }
  }

  // Append to audit log.
  if (logPath) {
    const logEntry = {
      timestamp: now.toISOString(),
      minSeverity,
      advisoriesFound: advisories.length,
      blockers: blockers.length,
      suppressed: suppressed.length,
      expiredIgnores: expiredIgnores.length,
      details: {
        blockers: blockers.map((b) => ({
          ids: b.ids,
          severity: b.severity,
          title: b.title,
          affectedPackage: b.affectedPackage,
        })),
        suppressed: suppressed.map((s) => ({
          ids: s.advisory.ids,
          severity: s.advisory.severity,
          title: s.advisory.title,
          affectedPackage: s.advisory.affectedPackage,
          ignoredBy: s.ignore.cveId,
          ignoreExpiresAt: s.ignore.expiresAt,
          justification: s.ignore.justification,
        })),
        expiredIgnores: expiredIgnores.map((e) => ({
          cveId: e.cveId,
          expiresAt: e.expiresAt,
          justification: e.justification,
        })),
      },
    };
    try {
      appendAuditLog(logPath, logEntry);
    } catch (err) {
      // Non-fatal: log write failure should not block the gate.
      process.stderr.write(`[audit-gate] WARN: could not write audit log: ${err.message}\n`);
    }
  }

  const exitCode = isDryRun ? 0 : blockers.length > 0 || expiredIgnores.length > 0 ? 1 : 0;

  return { blockers, suppressed, expiredIgnores, exitCode };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

const isMain = process.argv[1] != null && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const artifactsDir =
    artifactsDirOverride ??
    (process.env.ARTIFACTS_DIR
      ? resolve(process.env.ARTIFACTS_DIR)
      : join(REPO_ROOT, '.artifacts'));
  const logPath = join(artifactsDir, '_audit', 'audit.jsonl');

  process.stdout.write(`[audit-gate] running pnpm audit --json (threshold: ${auditLevel}+)...\n`);

  const ignores = loadIgnores(ignoresPath);
  process.stdout.write(
    `[audit-gate] loaded ${ignores.length} ignore entr${ignores.length === 1 ? 'y' : 'ies'} from ${ignoresPath}\n`,
  );

  const auditJson = runPnpmAudit(REPO_ROOT);

  const { blockers, suppressed, expiredIgnores, exitCode } = runAuditGate({
    auditJson,
    ignores,
    minSeverity: auditLevel,
    logPath,
    dryRun,
  });

  // Print summary.
  if (suppressed.length > 0) {
    process.stdout.write(
      `\n[audit-gate] ${suppressed.length} advisory/advisories SUPPRESSED by active ignore entries:\n`,
    );
    for (const { advisory, ignore } of suppressed) {
      process.stdout.write(
        `  OK  ${advisory.ids.join('/')} (${advisory.severity}) — ${advisory.title}\n`,
      );
      process.stdout.write(`      Ignored by: ${ignore.cveId}  expires: ${ignore.expiresAt}\n`);
      process.stdout.write(`      Justification: ${ignore.justification}\n`);
    }
  }

  if (expiredIgnores.length > 0) {
    process.stderr.write(
      `\n[audit-gate] ${expiredIgnores.length} EXPIRED ignore entr${expiredIgnores.length === 1 ? 'y' : 'ies'} (treating as absent):\n`,
    );
    for (const e of expiredIgnores) {
      process.stderr.write(`  EXPIRED  ${e.cveId}  expired: ${e.expiresAt}\n`);
      process.stderr.write(`           Justification: ${e.justification}\n`);
    }
    process.stderr.write('[audit-gate] Renew expired entries or fix the underlying dependency.\n');
  }

  if (blockers.length > 0) {
    process.stderr.write(
      `\n[audit-gate] ${blockers.length} BLOCKING advisory/advisories (no active ignore entry):\n`,
    );
    for (const b of blockers) {
      process.stderr.write(
        `  FAIL  ${b.ids.join('/')} (${b.severity}) — ${b.title} [${b.affectedPackage}]\n`,
      );
    }
    process.stderr.write(
      '\n[audit-gate] To exempt an advisory, add an entry to .audit-ignores.json:\n',
    );
    process.stderr.write(
      '  { "cveId": "<CVE-or-GHSA-id>", "justification": "<reason>", "expiresAt": "<ISO8601 date>" }\n',
    );
    process.stderr.write('See docs/operations/audit-gate.md for the renewal runbook.\n');
  }

  if (exitCode === 0 && blockers.length === 0) {
    process.stdout.write(`\n[audit-gate] PASS — no unaddressed ${auditLevel}+ advisories.\n`);
    if (logPath) {
      process.stdout.write(`[audit-gate] Audit log: ${logPath}\n`);
    }
  }

  if (dryRun && (blockers.length > 0 || expiredIgnores.length > 0)) {
    process.stdout.write(
      '\n[audit-gate] DRY RUN — would have exited 1 but --dry-run suppresses.\n',
    );
  }

  process.exit(exitCode);
}
