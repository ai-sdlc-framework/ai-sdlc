#!/usr/bin/env node
/**
 * AISDLC-580: shared version-convergence check for the plugin's `@ai-sdlc/*`
 * runtimeDependencies.
 *
 * Extracted into its own script so every caller that decides "does this
 * install need a (re)install" — `install-runtime-deps.sh`'s own idempotence
 * check, `hooks/session-start.js`'s automatic self-heal gate, and
 * `resolve-pipeline-cli.sh`'s `_deps_complete` gate — shares ONE
 * implementation instead of three independently-drifting copies. The
 * original AISDLC-580 fix only closed the gap in `install-runtime-deps.sh`
 * itself; both other callers still short-circuited on file-existence alone,
 * so a stale-but-present install (files exist, sentinel exists, but the
 * installed version no longer satisfies the pin or a newer version has
 * since published) never actually reached the fixed logic on the automatic
 * paths — only a manual `bash install-runtime-deps.sh` invocation did.
 *
 * Usage:
 *   node check-stale-runtime-deps.mjs <pluginDir> [timeoutMs]
 *
 * Output: one line per package that needs upgrading, to stdout, TAB-DELIMITED:
 *   <name>\t<installedVersion>\t<targetVersion>\t<pin>
 * e.g.
 *   @ai-sdlc/pipeline-cli\t0.20.0\t0.20.1\t^0.20.0
 *
 * Tab-delimited (not space) deliberately: a semver RANGE pin can legally
 * contain a space (e.g. a compound range like ">=1.0.0 <2.0.0"), which would
 * silently misparse a space-delimited consumer's fixed 4-field split. `name`,
 * `installedVersion`, and `targetVersion` never contain whitespace (npm
 * package names and resolved version strings are whitespace-free by spec),
 * so only the trailing `pin` field can safely absorb a compound-range space
 * — tab delimiting keeps the first three fields exact regardless.
 *
 * No output at all means "nothing detected as stale" — this is also what
 * happens when the check cannot be performed (see fail-open behavior below).
 *
 * Exit code is ALWAYS 0. This is an advisory check, never a hard failure —
 * every caller decides what "stale" means for its own context.
 *
 * Fails open (silently skips a package, never throws) when:
 *   - `pluginDir/plugin.json` is missing or invalid
 *   - the package has no local `package.json` to read an installed version
 *     from (a real `npm install` always writes one; only some hermetic test
 *     fixtures omit it)
 *   - `npm view <name>@<pin> version` errors, times out, or returns nothing
 *     (offline, registry misconfigured, npm missing from PATH, etc.)
 *
 * Speed: each `npm view` call is bounded by `timeoutMs` (default 3000ms per
 * package) via `spawnSync`'s own `timeout` option, so a caller on the
 * automatic path (session start, every `resolve-pipeline-cli.sh` invocation)
 * never blocks for longer than `3 * timeoutMs` in the worst case (all three
 * known packages present + registry unreachable) before degrading to the
 * old file-existence-only behavior.
 *
 * AISDLC-608: a genuine `npm view` TIMEOUT (registry reachable but slow) is
 * indistinguishable from "confirmed converged" on stdout alone — both
 * produce zero lines of stdout, which is exactly the masking bug this task
 * exists to close. To let callers surface a warning instead of silently
 * reading "no stdout" as "up to date", a timeout (as opposed to an ordinary
 * failure like offline/no-npm/registry-miss) additionally emits one line per
 * timed-out package to STDERR:
 *   TIMEOUT\t<name>\t<pin>\t<timeoutMs>
 * stdout semantics are UNCHANGED (still empty on timeout — this is still a
 * fail-open path, not fail-closed) so existing stdout-only consumers keep
 * working exactly as before; only a caller that additionally inspects
 * stderr for the `TIMEOUT\t` prefix gains the ability to tell "confirmed
 * converged" apart from "could not confirm — registry check timed out".
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * AISDLC-581: registry lookups (`npm view`) are cached per `name@pin` for a
 * TTL so every session start does not pay 1-3 network round-trips. Only the
 * resolved registry TARGET is cached (never the stale verdict), so the
 * installed-vs-target comparison stays fresh after an upgrade. Timeouts and
 * failures are never cached. TTL override: AI_SDLC_STALE_CHECK_TTL_MS
 * (0 disables the cache). Cache file override: AI_SDLC_STALE_CHECK_CACHE
 * (default `<pluginDir>/.stale-runtime-cache.json`). A missing, unwritable or
 * corrupt cache is treated as a miss (fail open).
 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function cacheTtlMs() {
  const raw = process.env.AI_SDLC_STALE_CHECK_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

function cachePath(pluginDir) {
  return process.env.AI_SDLC_STALE_CHECK_CACHE || join(pluginDir, '.stale-runtime-cache.json');
}

function readCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const KNOWN_PACKAGES = [
  '@ai-sdlc/pipeline-cli',
  '@ai-sdlc/plugin-mcp-server',
  '@ai-sdlc/orchestrator',
];

function main() {
  const pluginDir = process.argv[2];
  const timeoutMs = Number.parseInt(process.argv[3], 10) || 3000;

  if (!pluginDir) {
    // No plugin dir given — nothing to check, fail open silently.
    return;
  }

  const pluginJsonPath = join(pluginDir, 'plugin.json');
  if (!existsSync(pluginJsonPath)) return;

  let pluginJson;
  try {
    pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
  } catch {
    return;
  }

  const deps = pluginJson && pluginJson.runtimeDependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return;

  const ttl = cacheTtlMs();
  const cacheFile = cachePath(pluginDir);
  const cache = ttl > 0 ? readCache(cacheFile) : {};
  let cacheDirty = false;

  for (const name of KNOWN_PACKAGES) {
    const pin = deps[name];
    if (!pin || typeof pin !== 'string') continue;

    const pkgJsonPath = join(pluginDir, 'node_modules', name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue; // fail open — nothing to compare

    let installed;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      installed = typeof pkg.version === 'string' ? pkg.version : '';
    } catch {
      installed = '';
    }
    if (!installed) continue;

    const key = `${name}@${pin}`;
    const entry = cache[key];
    const fresh =
      ttl > 0 &&
      entry &&
      typeof entry.target === 'string' &&
      entry.target.length > 0 &&
      typeof entry.at === 'number' &&
      Date.now() - entry.at >= 0 &&
      Date.now() - entry.at < ttl;
    let target;
    let timedOut = false;
    if (fresh) {
      target = entry.target;
    } else {
      ({ target, timedOut } = resolveRegistryVersion(name, pin, timeoutMs));
      if (ttl > 0 && target) {
        cache[key] = { target, at: Date.now() };
        cacheDirty = true;
      }
    }
    if (timedOut) {
      // AISDLC-608: distinct from an ordinary failure — surface it on
      // stderr so a caller that cares can tell "unknown due to timeout"
      // apart from "confirmed converged". stdout stays empty either way
      // (still fail-open, never fail-closed).
      process.stderr.write(`TIMEOUT\t${name}\t${pin}\t${timeoutMs}\n`);
      continue;
    }
    if (!target) continue; // fail open — offline / registry unreachable / npm missing

    if (target !== installed) {
      process.stdout.write(`${name}\t${installed}\t${target}\t${pin}\n`);
    }
  }

  if (cacheDirty) {
    try {
      writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {
      // fail open — an unwritable cache just means the next run re-queries
    }
  }
}

/**
 * Compare two bare semver strings (`major.minor.patch[-prerelease]`).
 * Returns a positive number if `a` > `b`, negative if `a` < `b`, 0 if equal.
 * Dependency-free (no `semver` package is reachable from this script) —
 * intentionally small: numeric major/minor/patch compare, with any
 * pre-release/build-metadata suffix compared lexically as a tiebreaker only
 * after the numeric core is equal. This is sufficient for choosing the
 * highest of a small set of published, mostly-non-prerelease versions; it is
 * not a full semver-precedence implementation.
 */
function compareSemver(a, b) {
  const parse = (v) => {
    const [core, ...rest] = String(v).split('-');
    const prerelease = rest.join('-');
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { parts, prerelease };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  // Numeric core is equal — a version with NO pre-release suffix outranks
  // one that has one (per semver precedence rules), then fall back to a
  // lexical compare of the suffixes as a tiebreaker.
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease < pb.prerelease) return -1;
  if (pa.prerelease > pb.prerelease) return 1;
  return 0;
}

/**
 * Resolve the version npm would actually install for `name@pin` via
 * `npm view name@pin version --json`. Returns `{ target: '' }` on any
 * failure (missing npm, non-zero exit, empty/unparseable output) — callers
 * treat an empty `target` as "cannot determine, fail open". Returns
 * `{ target: '', timedOut: true }` specifically when the `spawnSync` timeout
 * budget was exceeded, so callers CAN distinguish "npm view genuinely timed
 * out" from "npm view ran to completion and failed/returned nothing"
 * (AISDLC-608) — the two were previously conflated into the same
 * empty-string result.
 *
 * AISDLC-624: `npm view <spec> version` WITHOUT `--json` prints a DECORATED
 * multi-line form (`@scope/name@x.y.z 'x.y.z'`, one line per match) whenever
 * a RANGE pin (e.g. `>=0.25.0 <1.0.0`) resolves to more than one published
 * version. Taking the last line as a bare version string was wrong — it's
 * the whole decorated line, not a version — causing a permanent false-
 * positive stale warning for every multi-match range pin. `--json` always
 * returns machine-parseable output: a JSON string for a single match, or a
 * JSON array of bare version strings for multiple matches, so the target can
 * be resolved unambiguously (semver-max of the array = what npm would
 * actually install for that range).
 */
function resolveRegistryVersion(name, pin, timeoutMs) {
  try {
    const result = spawnSync('npm', ['view', `${name}@${pin}`, 'version', '--json'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    // Node's spawnSync sets `result.error.code === 'ETIMEDOUT'` (and kills
    // the child via `result.signal`) when the process exceeds the `timeout`
    // option. That is the ONLY case treated as a timeout here — every other
    // failure shape (non-zero exit, no npm on PATH, empty stdout) keeps the
    // pre-existing silent fail-open behavior.
    if (result.error && result.error.code === 'ETIMEDOUT') {
      return { target: '', timedOut: true };
    }
    if (result.error || result.status !== 0) return { target: '' };
    const raw = (result.stdout || '').trim();
    if (!raw) return { target: '' };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { target: '' };
    }

    if (typeof parsed === 'string') {
      return { target: parsed };
    }
    if (Array.isArray(parsed)) {
      const versions = parsed.filter((v) => typeof v === 'string' && v.length > 0);
      if (versions.length === 0) return { target: '' };
      const max = versions.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
      return { target: max };
    }
    return { target: '' };
  } catch {
    return { target: '' };
  }
}

main();
