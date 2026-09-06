/**
 * `ai-sdlc doctor` check registry (AISDLC-578).
 *
 * Extends the single attestation-governance check shipped in AISDLC-560
 * (`checkAttestationGovernance` in `doctor.ts`) into a REGISTRY of
 * independent checks. Each check is a pure function of `{ projectDir,
 * adapters }` that returns one or more typed `DoctorCheckResult`s — no
 * console output, no `process.exit`, so every check is hermetically
 * testable with `mkdtemp` fixtures and stubbed adapters.
 *
 * ## Adding a check (the documented extension point)
 *
 * 1. Write a `run(ctx: DoctorRunContext): DoctorCheckResult | DoctorCheckResult[]`
 *    function. Use `ctx.adapters` for every filesystem/subprocess touch —
 *    never import `node:fs`/`node:child_process` directly in a check body,
 *    or it can't be driven hermetically in tests.
 * 2. Optionally write a `fix(ctx): { applied: boolean; detail: string }`
 *    for the SAFE/MECHANICAL subset only (re-syncing a pin, writing a
 *    missing snippet). Never force anything, never touch `.ai-sdlc/**`
 *    content the check didn't itself flag, and make it idempotent —
 *    running `--fix` twice in a row must be a no-op the second time.
 * 3. Append a `{ id, description, run, fix? }` object to `DOCTOR_CHECKS`
 *    below. `id` must be unique and stable — it's the join key for
 *    `--json` consumers and for a future `--report-upstream` (RFC-0045,
 *    NOT built here — this registry's typed result shape is the seam).
 *
 * ## Reuse contract (do NOT reimplement — see AISDLC-578 task body)
 *
 * - Check `plugin-version` shells out to the EXISTING
 *   `ai-sdlc-plugin/hooks/check-plugin-version.js --print` and parses its
 *   own printed status line — it does not re-fetch or re-compare versions
 *   itself. Do not add a third version checker (see also
 *   `mcp-advisor/src/version-check.ts`, which serves a different purpose —
 *   scanning `package.json` dependency versions, not the plugin install).
 * - Check `runtime-deps-pins` shells out to the EXISTING
 *   `ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs` (AISDLC-580) for
 *   the "does the pin still resolve to what's installed" half of its
 *   answer; the caret-trap detection (`^0.x.y` excludes the next minor,
 *   AISDLC-574) is a few lines of regex, not a parallel resolver.
 * - Check `attestation-governance` wraps `checkAttestationGovernance`
 *   (AISDLC-560) verbatim — it does not re-derive the three-state
 *   classification.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildProductionDoctorAdapters,
  checkAttestationGovernance,
  type DoctorAdapters,
} from './doctor.js';

// ── Types ────────────────────────────────────────────────────────────────

export type CheckSeverity = 'pass' | 'warn' | 'fail';

/**
 * One finding. `anonymizableEvidence` is the extension seam for a future
 * `--report-upstream` (separate RFC extending RFC-0025's anonymized
 * pre-filled-issue flow, NOT implemented here) — it must never contain
 * operator-identifying data (paths under the user's home dir, repo slugs,
 * tokens), only shape/version/count facts safe to share verbatim.
 */
export interface DoctorCheckResult {
  id: string;
  severity: CheckSeverity;
  title: string;
  remediation?: string;
  anonymizableEvidence?: Record<string, unknown>;
}

export interface DoctorCheckAdapters extends DoctorAdapters {
  /** Read a file as utf-8; `null` on any failure (missing, unreadable, etc). Never throws. */
  readFile: (path: string) => string | null;
  /**
   * Write a file (creating parent dirs as needed). Only ever called by a
   * check's `fix()` — never by `run()`. Silently swallows failures (the
   * caller reports `applied: false` via its own try/catch if it needs to
   * surface the error).
   */
  writeFile: (path: string, content: string) => void;
  /** List immediate subdirectory names of `path`; `[]` if missing/unreadable. Never throws. */
  listDir: (path: string) => string[];
  /** Production = `node:os.homedir()`. Injectable for hermetic tests. */
  homeDir: () => string;
  /** Production = `process.env`. Injectable so tests don't depend on the real environment. */
  env: NodeJS.ProcessEnv;
}

export function buildProductionCheckAdapters(): DoctorCheckAdapters {
  return {
    ...buildProductionDoctorAdapters(),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf-8');
    },
    listDir: (p) => {
      try {
        return readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    homeDir: () => homedir(),
    env: process.env,
  };
}

export interface DoctorRunContext {
  projectDir: string;
  adapters: DoctorCheckAdapters;
}

export interface DoctorFixResult {
  id: string;
  applied: boolean;
  detail: string;
}

export interface DoctorCheck {
  id: string;
  description: string;
  run: (ctx: DoctorRunContext) => DoctorCheckResult | DoctorCheckResult[];
  /** Present only for checks with a safe, mechanical, idempotent auto-fix. */
  fix?: (ctx: DoctorRunContext) => DoctorFixResult;
}

// ── Shared helpers ──────────────────────────────────────────────────────

/** Minimal semver-triple comparator. Returns >0 if a>b, <0 if a<b, 0 if equal or unparseable. */
function compareSemver(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const [aMaj, aMin, aPat] = norm(a);
  const [bMaj, bMin, bPat] = norm(b);
  if (![aMaj, aMin, aPat, bMaj, bMin, bPat].every(Number.isFinite)) return 0;
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}

function readJson(ctx: DoctorRunContext, path: string): unknown {
  const raw = ctx.adapters.readFile(path);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readPluginVersion(ctx: DoctorRunContext, pluginDir: string): string | undefined {
  const manifest = readJson(ctx, join(pluginDir, 'plugin.json')) as
    | { version?: string }
    | undefined;
  return manifest?.version;
}

/** Which resolution branch produced a `ResolvedPluginInstall`. */
export type PluginInstallSource = 'env' | 'marketplace' | 'node_modules' | 'repo-local';

export interface ResolvedPluginInstall {
  path: string;
  version?: string;
  source: PluginInstallSource;
}

/**
 * Scan `~/.claude/plugins/cache/*&#47;ai-sdlc/*` for the marketplace-installed
 * cache, picking the SEMVER-highest version directory (AISDLC-586: a lexical
 * string sort previously picked "0.9.0" over "0.18.0" because `9 > 1` as
 * characters — this cost an adopter a doctor run that audited a plugin
 * version 9 releases stale). Returns `undefined` when the cache root doesn't
 * exist or no version directory has a `plugin.json`.
 */
function findMarketplaceInstall(ctx: DoctorRunContext): ResolvedPluginInstall | undefined {
  const { adapters } = ctx;
  const cacheRoot = join(adapters.homeDir(), '.claude', 'plugins', 'cache');
  const marketplaceDirs = adapters.listDir(cacheRoot);

  let best: { version: string; dir: string } | undefined;
  for (const marketplace of marketplaceDirs) {
    const aiSdlcRoot = join(cacheRoot, marketplace, 'ai-sdlc');
    const versionDirs = adapters.listDir(aiSdlcRoot);
    for (const version of versionDirs) {
      const candidate = join(aiSdlcRoot, version);
      if (!adapters.exists(join(candidate, 'plugin.json'))) continue;
      if (!best || compareSemver(version, best.version) > 0) {
        best = { version, dir: candidate };
      }
    }
  }
  if (!best) return undefined;
  return { path: best.dir, version: best.version, source: 'marketplace' };
}

/**
 * Resolve the installed `ai-sdlc-plugin` package tree (the directory
 * containing `plugin.json`, `.claude-plugin/plugin.json`, and `hooks/`),
 * along with which resolution branch produced it and its declared version.
 *
 * Resolution order (AISDLC-586 — reordered to audit the plugin Claude Code
 * actually LOADED instead of a stale dev checkout that happens to share a
 * project root):
 *
 *   1. `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DIR` env var — set by Claude
 *      Code when running inside a plugin context, or exported manually.
 *      This is the harness's own signal for "this is what got loaded" and
 *      always wins when present.
 *   2. The marketplace cache (`~/.claude/plugins/cache/*&#47;ai-sdlc/*`),
 *      SEMVER-highest version directory. This is the real install for the
 *      overwhelming majority of operators and adopters.
 *   3. `<projectDir>/node_modules/ai-sdlc-plugin` — an adopter that vendored
 *      the plugin as an npm dependency.
 *   4. `<projectDir>/ai-sdlc-plugin` — the ai-sdlc monorepo itself, or an
 *      adopter using a `directory`-source marketplace pointed at a checked-
 *      out copy. Demoted to LAST resort: previously this ranked #2, so
 *      running `ai-sdlc doctor` from (or near) a monorepo checkout silently
 *      shadowed the marketplace install Claude Code had actually loaded.
 *
 * Returns `undefined` when none of the candidates look like a real plugin
 * install (checked via presence of `plugin.json`).
 */
export function resolvePluginInstall(ctx: DoctorRunContext): ResolvedPluginInstall | undefined {
  const { adapters, projectDir } = ctx;

  const envRoot = adapters.env.CLAUDE_PLUGIN_ROOT || adapters.env.CLAUDE_PLUGIN_DIR;
  if (envRoot && adapters.exists(join(envRoot, 'plugin.json'))) {
    return { path: envRoot, version: readPluginVersion(ctx, envRoot), source: 'env' };
  }

  const marketplace = findMarketplaceInstall(ctx);
  if (marketplace) return marketplace;

  const nodeModulesDir = join(projectDir, 'node_modules', 'ai-sdlc-plugin');
  if (adapters.exists(join(nodeModulesDir, 'plugin.json'))) {
    return {
      path: nodeModulesDir,
      version: readPluginVersion(ctx, nodeModulesDir),
      source: 'node_modules',
    };
  }

  const repoLocalDir = join(projectDir, 'ai-sdlc-plugin');
  if (adapters.exists(join(repoLocalDir, 'plugin.json'))) {
    return {
      path: repoLocalDir,
      version: readPluginVersion(ctx, repoLocalDir),
      source: 'repo-local',
    };
  }

  return undefined;
}

/** Backward-compat convenience wrapper — every existing check only needs the path. */
export function resolvePluginDir(ctx: DoctorRunContext): string | undefined {
  return resolvePluginInstall(ctx)?.path;
}

// ── Check 1: plugin version ─────────────────────────────────────────────

export function checkPluginVersion(ctx: DoctorRunContext): DoctorCheckResult {
  const pluginDir = resolvePluginDir(ctx);
  if (!pluginDir) {
    return {
      id: 'plugin-version',
      severity: 'warn',
      title: 'ai-sdlc plugin install not detected on this machine',
      remediation: '/plugin marketplace add ai-sdlc-framework/ai-sdlc && /plugin install ai-sdlc',
    };
  }

  const scriptPath = join(pluginDir, 'hooks', 'check-plugin-version.js');
  if (!ctx.adapters.exists(scriptPath)) {
    return {
      id: 'plugin-version',
      severity: 'warn',
      title: `plugin found at ${pluginDir} but hooks/check-plugin-version.js is missing — install looks incomplete`,
      remediation: 'Reinstall: /plugin uninstall ai-sdlc && /plugin install ai-sdlc',
    };
  }

  const result = ctx.adapters.runCommand('node', [scriptPath, '--print']);
  const output = result.stdout || '';
  const installed = output.match(/Installed:\s*v?(\S+)/i)?.[1];
  const latestRaw = output.match(/Latest:\s*v?(\S+)/i)?.[1];
  const latest = latestRaw && latestRaw !== 'unknown' ? latestRaw : undefined;

  if (/✓ up to date/.test(output)) {
    return {
      id: 'plugin-version',
      severity: 'pass',
      title: `ai-sdlc plugin up to date (v${installed ?? 'unknown'})`,
      anonymizableEvidence: { installed, latest },
    };
  }
  if (/⚠ stale/.test(output)) {
    return {
      id: 'plugin-version',
      severity: 'warn',
      title: `ai-sdlc plugin v${installed ?? 'unknown'} installed, v${latest ?? 'unknown'} available`,
      remediation: '/plugin update ai-sdlc && /reload-plugins',
      anonymizableEvidence: { installed, latest },
    };
  }
  return {
    id: 'plugin-version',
    severity: 'warn',
    title:
      'could not determine plugin version staleness (marketplace unreachable or version unknown)',
    remediation: 'Check network connectivity, then re-run `ai-sdlc doctor`',
    anonymizableEvidence: { installed, latest },
  };
}

// ── Check 2: runtimeDependencies pins ────────────────────────────────────

const CARET_ZERO_TRAP = /^\^0\.\d+\.\d+/;

export function checkRuntimeDepsPins(ctx: DoctorRunContext): DoctorCheckResult[] {
  const pluginDir = resolvePluginDir(ctx);
  if (!pluginDir) {
    return [
      {
        id: 'runtime-deps-pins',
        severity: 'warn',
        title: 'plugin install not found — skipped runtimeDependencies pin check',
      },
    ];
  }

  const manifest = readJson(ctx, join(pluginDir, 'plugin.json')) as
    | { runtimeDependencies?: Record<string, string> }
    | undefined;
  if (!manifest) {
    return [
      {
        id: 'runtime-deps-pins',
        severity: 'fail',
        title: `${join(pluginDir, 'plugin.json')} missing or invalid JSON`,
        remediation: 'Reinstall the plugin',
      },
    ];
  }

  const results: DoctorCheckResult[] = [];
  const deps = manifest.runtimeDependencies ?? {};

  for (const [name, pin] of Object.entries(deps)) {
    if (typeof pin === 'string' && CARET_ZERO_TRAP.test(pin)) {
      // Caret semantics differ within 0.x: `^0.m.p` (m>0) locks to the
      // minor and excludes the next minor (^0.19.0 excludes 0.20.0),
      // whereas `^0.0.p` locks to the exact patch and excludes the next
      // patch too. Render an accurate example for each subset.
      const caretDetail = /^\^0\.0\./.test(pin)
        ? 'a caret-0.0.x range — locks to the exact patch (e.g. ^0.0.5 excludes 0.0.6)'
        : 'a caret-0.x range — excludes the next minor (e.g. ^0.19.0 excludes 0.20.0)';
      results.push({
        id: `runtime-deps-caret-trap:${name}`,
        severity: 'warn',
        title: `${name} pin "${pin}" is ${caretDetail}`,
        remediation: `Verify compatibility, then widen the pin for ${name} (AISDLC-574)`,
        anonymizableEvidence: { package: name, pin },
      });
    }
  }

  const staleScript = join(pluginDir, 'scripts', 'check-stale-runtime-deps.mjs');
  if (ctx.adapters.exists(staleScript)) {
    const out = ctx.adapters.runCommand('node', [staleScript, pluginDir]);
    const lines = out.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const [name, installed, target, pin] = line.split('\t');
      if (!name) continue;
      results.push({
        id: `runtime-deps-stale:${name}`,
        severity: 'warn',
        title: `${name} installed v${installed}, but pin ${pin} now resolves to v${target}`,
        remediation: `bash "${join(pluginDir, 'scripts', 'install-runtime-deps.sh')}"`,
        anonymizableEvidence: { package: name, installed, target, pin },
      });
    }
  }

  if (results.length === 0) {
    results.push({
      id: 'runtime-deps-pins',
      severity: 'pass',
      title: 'runtimeDependencies pins resolve and no caret-0.x traps detected',
    });
  }
  return results;
}

export function fixRuntimeDepsPins(ctx: DoctorRunContext): DoctorFixResult {
  const pluginDir = resolvePluginDir(ctx);
  if (!pluginDir) {
    return { id: 'runtime-deps-pins', applied: false, detail: 'plugin install not found' };
  }
  const installScript = join(pluginDir, 'scripts', 'install-runtime-deps.sh');
  if (!ctx.adapters.exists(installScript)) {
    return {
      id: 'runtime-deps-pins',
      applied: false,
      detail: `${installScript} not found — nothing to run`,
    };
  }
  const result = ctx.adapters.runCommand('bash', [installScript]);
  return {
    id: 'runtime-deps-pins',
    applied: result.exitCode === 0,
    detail:
      result.exitCode === 0
        ? `re-ran ${installScript} to re-sync runtime dep pins`
        : `install-runtime-deps.sh exited ${result.exitCode}`,
  };
}

// ── Check 3: manifest agreement ───────────────────────────────────────────

export function checkManifestsAgree(ctx: DoctorRunContext): DoctorCheckResult {
  const pluginDir = resolvePluginDir(ctx);
  if (!pluginDir) {
    return {
      id: 'manifests-agree',
      severity: 'warn',
      title: 'plugin install not found — skipped manifest-agreement check',
    };
  }

  const rootPath = join(pluginDir, 'plugin.json');
  const nestedPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  const root = readJson(ctx, rootPath) as
    | { version?: string; runtimeDependencies?: Record<string, string> }
    | undefined;
  const nested = readJson(ctx, nestedPath) as
    | { version?: string; runtimeDependencies?: Record<string, string> }
    | undefined;

  if (!root || !nested) {
    return {
      id: 'manifests-agree',
      severity: 'fail',
      title: `one or both plugin manifests missing/invalid: ${rootPath}, ${nestedPath}`,
      remediation: 'Reinstall the plugin',
    };
  }

  const diffs: string[] = [];
  if (root.version !== nested.version) {
    diffs.push(`version (${root.version ?? 'unset'} vs ${nested.version ?? 'unset'})`);
  }
  if (
    JSON.stringify(root.runtimeDependencies ?? {}) !==
    JSON.stringify(nested.runtimeDependencies ?? {})
  ) {
    diffs.push('runtimeDependencies');
  }

  if (diffs.length > 0) {
    return {
      id: 'manifests-agree',
      severity: 'fail',
      title: `plugin.json and .claude-plugin/plugin.json disagree on: ${diffs.join(', ')}`,
      remediation:
        '`ai-sdlc doctor --fix` copies plugin.json → .claude-plugin/plugin.json (AISDLC-558)',
      anonymizableEvidence: { diffs },
    };
  }

  return {
    id: 'manifests-agree',
    severity: 'pass',
    title: 'plugin.json and .claude-plugin/plugin.json agree',
  };
}

export function fixManifestsAgree(ctx: DoctorRunContext): DoctorFixResult {
  const pluginDir = resolvePluginDir(ctx);
  if (!pluginDir) {
    return { id: 'manifests-agree', applied: false, detail: 'plugin install not found' };
  }
  const rootPath = join(pluginDir, 'plugin.json');
  const nestedPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  const rootRaw = ctx.adapters.readFile(rootPath);
  if (rootRaw == null) {
    return { id: 'manifests-agree', applied: false, detail: `${rootPath} missing — cannot sync` };
  }
  // Root `plugin.json` is treated as the source of truth: it's the one
  // release-please's `extra-files` config bumps directly (AISDLC-574).
  // Idempotent — re-running with already-synced manifests is a no-op write.
  ctx.adapters.writeFile(nestedPath, rootRaw);
  return {
    id: 'manifests-agree',
    applied: true,
    detail: `copied ${rootPath} → ${nestedPath}`,
  };
}

// ── Check 7: attestation governance (reuse of AISDLC-560) ────────────────

export function checkAttestationGovernanceCheck(ctx: DoctorRunContext): DoctorCheckResult {
  const gov = checkAttestationGovernance(ctx.projectDir, ctx.adapters);

  if (gov.state === 'fully-configured') {
    return {
      id: 'attestation-governance',
      severity: 'pass',
      title:
        'Attestation artifacts installed and branch protection enforces ai-sdlc/pr-ready + approving review',
    };
  }

  const evidence: Record<string, unknown> = {
    state: gov.state,
    artifactsPresent: gov.artifactsPresent,
    branchProtectionChecked: gov.branchProtection.checked,
  };

  if (gov.branchProtection.requiresAttestationDirectly) {
    return {
      id: 'attestation-governance',
      severity: 'fail',
      title:
        'branch protection requires `ai-sdlc/attestation` directly — it is audit-only by design (AISDLC-388) and should not gate merges on its own',
      remediation:
        'Require `ai-sdlc/pr-ready` (+ `Backlog Drift`) instead of `ai-sdlc/attestation` directly',
      anonymizableEvidence: evidence,
    };
  }

  return {
    id: 'attestation-governance',
    severity: 'warn',
    title:
      gov.state === 'neither'
        ? 'No attestation infrastructure installed'
        : 'Attestation artifacts present but not enforced (audit-only)',
    remediation: gov.closingCommand,
    anonymizableEvidence: evidence,
  };
}

// ── Check: multi-install ambiguity (AISDLC-586) ───────────────────────────

/**
 * Detects the exact situation that motivated AISDLC-586: a repo-local dev
 * checkout (`<projectDir>/ai-sdlc-plugin`) coexisting with a marketplace
 * cache install that disagree on version. `resolvePluginInstall` now audits
 * the marketplace install in that case (see its docstring), but a silent
 * "wrong one used to be audited" bug deserves a visible signal, not just a
 * quiet behavior change.
 */
export function checkPluginInstallAmbiguity(ctx: DoctorRunContext): DoctorCheckResult {
  const { adapters, projectDir } = ctx;
  const repoLocalDir = join(projectDir, 'ai-sdlc-plugin');
  const repoLocalPresent = adapters.exists(join(repoLocalDir, 'plugin.json'));
  const marketplace = findMarketplaceInstall(ctx);

  if (!repoLocalPresent || !marketplace) {
    return {
      id: 'plugin-install-ambiguity',
      severity: 'pass',
      title: 'no ambiguous multi-install situation detected',
    };
  }

  const repoLocalVersion = readPluginVersion(ctx, repoLocalDir);
  if (repoLocalVersion === marketplace.version) {
    return {
      id: 'plugin-install-ambiguity',
      severity: 'pass',
      title: `repo-local dev checkout and marketplace install agree (v${marketplace.version ?? 'unknown'})`,
    };
  }

  return {
    id: 'plugin-install-ambiguity',
    severity: 'warn',
    title:
      `multiple plugin installs detected and disagree on version — ` +
      `repo-local ${repoLocalDir} (v${repoLocalVersion ?? 'unknown'}) vs. ` +
      `marketplace ${marketplace.path} (v${marketplace.version ?? 'unknown'}); ` +
      'doctor audits the marketplace install (the one Claude Code actually loaded)',
    remediation:
      'Reconcile the dev checkout with the marketplace version, or remove it if it is stale',
    anonymizableEvidence: {
      repoLocalVersion,
      marketplaceVersion: marketplace.version,
    },
  };
}

// ── Check 11: marketplace-catalog-vs-source version drift ────────────────

function deepFindNamedVersion(node: unknown, name: string, depth = 0): string | undefined {
  if (node == null || depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = deepFindNamedVersion(item, name, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.name === name && typeof obj.version === 'string') return obj.version;
    for (const value of Object.values(obj)) {
      const found = deepFindNamedVersion(value, name, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function checkMarketplaceCatalogDrift(ctx: DoctorRunContext): DoctorCheckResult {
  const catalogPath = join(
    ctx.adapters.homeDir(),
    '.claude',
    'plugins',
    'plugin-catalog-cache.json',
  );
  const catalog = readJson(ctx, catalogPath);
  if (catalog === undefined) {
    return {
      id: 'marketplace-catalog-drift',
      severity: 'pass',
      title: 'no marketplace catalog cache found — nothing to compare',
    };
  }

  const catalogVersion = deepFindNamedVersion(catalog, 'ai-sdlc');
  const pluginDir = resolvePluginDir(ctx);
  const scriptPath = pluginDir && join(pluginDir, 'hooks', 'check-plugin-version.js');

  if (!catalogVersion || !scriptPath || !ctx.adapters.exists(scriptPath)) {
    return {
      id: 'marketplace-catalog-drift',
      severity: 'warn',
      title: 'insufficient data to compare marketplace catalog cache vs. source-of-truth version',
    };
  }

  const result = ctx.adapters.runCommand('node', [scriptPath, '--print']);
  const latestRaw = result.stdout.match(/Latest:\s*v?(\S+)/i)?.[1];
  const sourceLatest = latestRaw && latestRaw !== 'unknown' ? latestRaw : undefined;

  if (!sourceLatest) {
    return {
      id: 'marketplace-catalog-drift',
      severity: 'warn',
      title:
        'could not resolve source-of-truth latest version to compare against the catalog cache',
    };
  }

  if (compareSemver(sourceLatest, catalogVersion) > 0) {
    return {
      id: 'marketplace-catalog-drift',
      severity: 'fail',
      title: `marketplace catalog cache reports v${catalogVersion} but the source serves v${sourceLatest} — /plugin will misreport "already at latest"`,
      remediation:
        '/plugin marketplace update <name>, then /plugin update ai-sdlc && /reload-plugins',
      anonymizableEvidence: { catalogVersion, sourceLatest },
    };
  }

  return {
    id: 'marketplace-catalog-drift',
    severity: 'pass',
    title: 'marketplace catalog cache matches source-of-truth version',
    anonymizableEvidence: { catalogVersion, sourceLatest },
  };
}

// ── Check 12: npm dist-tag vs. plugin-pin reachability ────────────────────

export function checkNpmDistTagReachability(ctx: DoctorRunContext): DoctorCheckResult[] {
  const pluginDir = resolvePluginDir(ctx);
  if (!pluginDir) {
    return [
      {
        id: 'npm-dist-tag-reachability',
        severity: 'warn',
        title: 'plugin install not found — skipped npm dist-tag reachability check',
      },
    ];
  }

  const manifest = readJson(ctx, join(pluginDir, 'plugin.json')) as
    | { runtimeDependencies?: Record<string, string> }
    | undefined;
  if (!manifest) {
    return [
      {
        id: 'npm-dist-tag-reachability',
        severity: 'fail',
        title: `${join(pluginDir, 'plugin.json')} missing or invalid JSON`,
      },
    ];
  }

  const results: DoctorCheckResult[] = [];
  const deps = manifest.runtimeDependencies ?? {};

  for (const [name, pin] of Object.entries(deps)) {
    if (typeof pin !== 'string') continue;
    // `--` stops npm option parsing so a name/pin that begins with '-'
    // (from a hand-edited manifest) is never mistaken for a flag.
    const out = ctx.adapters.runCommand('npm', ['view', '--', `${name}@${pin}`, 'version']);
    const resolved = out.stdout.trim().split('\n').filter(Boolean).pop();
    if (out.exitCode !== 0 || !resolved) {
      // Distinguish a genuine "the registry replied and this version does
      // not exist" (E404 → a real pin bug, `fail`) from "npm could not
      // reach the registry at all" (offline / DNS / timeout / rate-limit →
      // a transient environment condition, `warn`). Failing closed on the
      // latter would flip doctor's default exit code to 1 on an air-gapped
      // CI runner or during a brief npm outage — a false positive unrelated
      // to repo config. This mirrors the fail-open stance of the other
      // network-touching checks (plugin-version, marketplace-catalog-drift).
      const stderr = out.stderr ?? '';
      const notFound = /\bE404\b|404 Not Found|is not in this registry|no such package/i.test(
        stderr,
      );
      if (out.exitCode !== 0 && !notFound) {
        results.push({
          id: `npm-dist-tag:${name}`,
          severity: 'warn',
          title: `${name}@${pin} could not be checked — npm registry unreachable (offline, DNS failure, timeout, or rate-limited)`,
          remediation: `Re-run with network access: npm view ${name}@${pin} version`,
          anonymizableEvidence: { package: name, pin },
        });
        continue;
      }
      results.push({
        id: `npm-dist-tag:${name}`,
        severity: 'fail',
        title: `${name}@${pin} did not resolve on the npm registry — pin references an unpublished/non-existent version`,
        remediation: `npm view ${name}@${pin} version`,
        anonymizableEvidence: { package: name, pin },
      });
      continue;
    }
    results.push({
      id: `npm-dist-tag:${name}`,
      severity: 'pass',
      title: `${name}@${pin} resolves to v${resolved}`,
      anonymizableEvidence: { package: name, pin, resolved },
    });
  }

  if (results.length === 0) {
    results.push({
      id: 'npm-dist-tag-reachability',
      severity: 'pass',
      title: 'no runtimeDependencies pins to check',
    });
  }
  return results;
}

// ── Registry ──────────────────────────────────────────────────────────────

/**
 * The check registry. See the module docstring for the extension
 * contract. Order here is also render order.
 */
export const DOCTOR_CHECKS: DoctorCheck[] = [
  {
    id: 'plugin-version',
    description: 'Plugin installed version vs. latest published (reuses check-plugin-version.js).',
    run: checkPluginVersion,
  },
  {
    id: 'runtime-deps-pins',
    description:
      'runtimeDependencies pins resolve to the installed version; flags ^0.x caret traps (AISDLC-574).',
    run: checkRuntimeDepsPins,
    fix: fixRuntimeDepsPins,
  },
  {
    id: 'manifests-agree',
    description: 'plugin.json and .claude-plugin/plugin.json agree (AISDLC-558).',
    run: checkManifestsAgree,
    fix: fixManifestsAgree,
  },
  {
    id: 'plugin-install-ambiguity',
    description:
      'WARNs when a repo-local dev checkout and a marketplace install coexist and disagree on version (AISDLC-586).',
    run: checkPluginInstallAmbiguity,
  },
  {
    id: 'attestation-governance',
    description: 'Attestation required-but-unconfigured detection (reuses AISDLC-560).',
    run: checkAttestationGovernanceCheck,
  },
  {
    id: 'marketplace-catalog-drift',
    description:
      'Marketplace catalog cache vs. source-of-truth version drift — the "/plugin already at latest" false negative.',
    run: checkMarketplaceCatalogDrift,
  },
  {
    id: 'npm-dist-tag-reachability',
    description: 'Every runtimeDependencies pin actually resolves on the configured npm registry.',
    run: checkNpmDistTagReachability,
  },
];

// ── Runner ────────────────────────────────────────────────────────────────

export function runDoctorChecks(
  ctx: DoctorRunContext,
  checks: DoctorCheck[] = DOCTOR_CHECKS,
): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];
  for (const check of checks) {
    const outcome = check.run(ctx);
    if (Array.isArray(outcome)) results.push(...outcome);
    else results.push(outcome);
  }
  return results;
}

export function runDoctorFixes(
  ctx: DoctorRunContext,
  checks: DoctorCheck[] = DOCTOR_CHECKS,
): DoctorFixResult[] {
  return checks.filter((c) => c.fix).map((c) => c.fix!(ctx));
}

export interface DoctorSummary {
  pass: number;
  warn: number;
  fail: number;
  total: number;
}

export function summarizeDoctorResults(results: DoctorCheckResult[]): DoctorSummary {
  const summary: DoctorSummary = { pass: 0, warn: 0, fail: 0, total: results.length };
  for (const r of results) summary[r.severity]++;
  return summary;
}

// ── Rendering ─────────────────────────────────────────────────────────────

const SEVERITY_GLYPH: Record<CheckSeverity, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
};

const INSTALL_SOURCE_LABEL: Record<PluginInstallSource, string> = {
  env: 'CLAUDE_PLUGIN_ROOT/DIR',
  marketplace: 'marketplace',
  node_modules: 'adopter node_modules',
  'repo-local': 'dev checkout',
};

/** One-line description of which plugin install doctor audited (AISDLC-586). */
export function describeResolvedPluginInstall(install: ResolvedPluginInstall | undefined): string {
  if (!install) return 'Auditing: no plugin install detected';
  const versionSuffix = install.version ? ` v${install.version}` : '';
  return `Auditing: ${install.path} (${INSTALL_SOURCE_LABEL[install.source]}${versionSuffix})`;
}

export function renderFullDoctorReport(
  results: DoctorCheckResult[],
  install?: ResolvedPluginInstall,
): string[] {
  const lines: string[] = [];
  lines.push('AI-SDLC Doctor');
  lines.push('─'.repeat(50));
  lines.push(describeResolvedPluginInstall(install));
  lines.push('');

  for (const r of results) {
    lines.push(`[${SEVERITY_GLYPH[r.severity]} ${r.severity.toUpperCase()}] ${r.id}: ${r.title}`);
    if (r.remediation) lines.push(`    → ${r.remediation}`);
  }

  const summary = summarizeDoctorResults(results);
  lines.push('');
  lines.push(
    `${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail (${summary.total} checks)`,
  );

  return lines;
}
