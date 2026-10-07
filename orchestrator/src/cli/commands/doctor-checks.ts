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
import { basename, dirname, join, resolve } from 'node:path';
import {
  createBuiltInJudgmentProvider,
  getJudgmentDefinition,
  isModelAlias,
  judgmentEnforceDowngradeReason,
  loadJudgmentConfig,
} from '@ai-sdlc/reference';
import {
  ARTIFACTS_GITIGNORE_ENTRY,
  gitCheckIgnoreArgs,
  gitignoreCovers,
  interpretCheckIgnoreExit,
} from '../../runtime-gitignore.js';
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

// ── Check: reviewer-attribution resolver reachability (AISDLC-623) ───────

/**
 * Verifies `resolve-transcript-task-id.sh` — the reviewer-attribution
 * resolver the Bash-capable reviewer subagents (code-reviewer, test-
 * reviewer, correctness-reviewer, and their -codex variants) invoke at
 * Step 0 — is actually bundled into the resolved plugin install's
 * `scripts/` directory.
 *
 * This is read-only / advisory (WARN, never FAIL): AISDLC-623 made the
 * resolver fail-SOFT when it's missing entirely (each reviewer synthesizes
 * its own unique unattributed id inline rather than refusing), so a broken
 * bundle no longer bricks review — but an operator should still know their
 * plugin install is missing this file, since it means every review from
 * this install runs unattributed until the bundle is repaired.
 */
export function checkReviewerAttributionResolver(ctx: DoctorRunContext): DoctorCheckResult {
  const install = resolvePluginInstall(ctx);
  if (!install) {
    return {
      id: 'reviewer-attribution-resolver',
      severity: 'pass',
      title: 'no plugin install detected — reviewer-attribution resolver check skipped',
    };
  }

  const resolverPath = join(install.path, 'scripts', 'resolve-transcript-task-id.sh');
  if (ctx.adapters.exists(resolverPath)) {
    return {
      id: 'reviewer-attribution-resolver',
      severity: 'pass',
      title:
        'reviewer-attribution resolver (resolve-transcript-task-id.sh) is bundled with the plugin install',
    };
  }

  return {
    id: 'reviewer-attribution-resolver',
    severity: 'warn',
    title: `resolve-transcript-task-id.sh not found under ${resolverPath} — reviewer subagents will run with unattributed transcripts`,
    remediation:
      'Reinstall or update the plugin: /plugin uninstall ai-sdlc && /plugin install ai-sdlc',
    anonymizableEvidence: { installSource: install.source, resolverPath },
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

// ── Check: usage ingest liveness (RFC-0050) ───────────────────────────────

interface UsageIngestRecord {
  lastOutcome?: string;
  lastLiveAt?: string;
  lastDegradedReason?: string;
}

/**
 * Reports the time of the last successful usage ingest, read from the
 * capability state file the ingester writes (`_capabilities/state.json`). A
 * degraded last outcome warns; a repo that has never ingested passes with a
 * hint, since ingestion is additive and optional.
 */
export function checkUsageIngest(ctx: DoctorRunContext): DoctorCheckResult {
  const { env } = ctx.adapters;
  // The ingester reports into $ARTIFACTS_DIR when set, else into the
  // machine-level usage directory (it often runs detached with no repo cwd).
  const usageDir = env.AI_SDLC_USAGE_DIR ?? join(ctx.adapters.homeDir(), '.ai-sdlc', 'usage');
  const candidates = [
    ...(env.ARTIFACTS_DIR ? [env.ARTIFACTS_DIR] : []),
    join(ctx.projectDir, '.ai-sdlc', 'artifacts'),
    usageDir,
  ];
  let rec: UsageIngestRecord | undefined;
  for (const dir of candidates) {
    const raw = ctx.adapters.readFile(join(dir, '_capabilities', 'state.json'));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { capabilities?: Record<string, UsageIngestRecord> };
      const caps = parsed.capabilities;
      rec = caps && Object.hasOwn(caps, 'usage.ingest') ? caps['usage.ingest'] : undefined;
    } catch {
      rec = undefined;
    }
    if (rec) break;
  }
  const last = rec?.lastLiveAt ? `last successful ingest ${rec.lastLiveAt}` : undefined;
  if (rec?.lastOutcome === 'degraded') {
    const reason = rec.lastDegradedReason ? ` (${rec.lastDegradedReason})` : '';
    return {
      id: 'usage-ingest',
      severity: 'warn',
      title: `usage ingest degraded${reason}${last ? `; ${last}` : '; no successful ingest recorded'}`,
      remediation: 'Run `cli-usage ingest` and check the reason above.',
      anonymizableEvidence: { lastOutcome: 'degraded', lastLiveAt: rec.lastLiveAt ?? null },
    };
  }
  if (last) {
    return { id: 'usage-ingest', severity: 'pass', title: `usage ingest live; ${last}` };
  }
  return {
    id: 'usage-ingest',
    severity: 'pass',
    title: 'usage ingest has not run yet (run `cli-usage ingest` to build the usage ledger)',
  };
}

// ── Orphaned vitest workers (AISDLC-681) ─────────────────────────────────

/** Parse `ps` etime (`[[dd-]hh:]mm:ss`) to seconds; `undefined` if unparseable. */
export function parseEtimeSeconds(etime: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return undefined;
  const [, d, h, mi, se] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(se);
}

const ORPHAN_MIN_AGE_SECONDS = 120;
/**
 * vitest sets its process title to `node (vitest N)` / `node (vitest)` on both
 * macOS and Linux; forks workers can also show their `vitest/dist/workers/`
 * entrypoint. Anything else merely mentioning "vitest" (vitest.config.ts args,
 * launchd jobs) is NOT matched.
 */
const VITEST_WORKER_COMMAND = /\(vitest(?: \d+)?\)|[\\/]vitest[\\/]dist[\\/]workers[\\/]/;

/**
 * Warns on vitest pool workers whose parent is pid 1 (orphaned by a killed
 * test run) older than two minutes, and prints the kill command. Returns NO
 * result when there are none, so a healthy machine sees nothing.
 */
export function checkOrphanedVitestWorkers(ctx: DoctorRunContext): DoctorCheckResult[] {
  const ps = ctx.adapters.runCommand('ps', ['-axo', 'pid=,ppid=,etime=,command=']);
  if (ps.exitCode !== 0) return [];
  const orphans: number[] = [];
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, etime, command] = m;
    if (ppid !== '1' || !VITEST_WORKER_COMMAND.test(command)) continue;
    const age = parseEtimeSeconds(etime);
    if (age !== undefined && age > ORPHAN_MIN_AGE_SECONDS) orphans.push(Number(pid));
  }
  if (orphans.length === 0) return [];
  return [
    {
      id: 'orphaned-vitest-workers',
      severity: 'warn',
      title: `${orphans.length} orphaned vitest worker process(es) (parent pid 1, older than 2 minutes)`,
      remediation: `Verify these pids are orphaned vitest workers (ps -p <pid>), then kill them: kill ${orphans.join(' ')}`,
      anonymizableEvidence: { orphanCount: orphans.length },
    },
  ];
}

// ── Runtime artifacts ignore entry ──────────────────────────────────────

/**
 * `.ai-sdlc/artifacts/` holds the evidence files, assignment logs and replay
 * results the routing commands write (RFC-0050, AISDLC-657.3). A repository whose
 * .gitignore lacks the entry would commit them. Warns, not fails: nothing is
 * broken until someone stages the directory.
 */
export function checkRuntimeGitignore(ctx: DoctorRunContext): DoctorCheckResult {
  const gitignore = ctx.adapters.readFile(join(ctx.projectDir, '.gitignore'));
  // git is the authority (it sees `artifacts/`, `.ai-sdlc/*` with a later `!`, nested
  // .gitignore files); the text reading is the fallback when git cannot be asked.
  const git = interpretCheckIgnoreExit(
    ctx.adapters.runCommand('git', gitCheckIgnoreArgs(ctx.projectDir, ARTIFACTS_GITIGNORE_ENTRY))
      .exitCode,
  );
  const ignored =
    git ?? (gitignore !== null && gitignoreCovers(gitignore, ARTIFACTS_GITIGNORE_ENTRY));
  if (ignored) {
    return {
      id: 'runtime-gitignore',
      severity: 'pass',
      title: `.gitignore ignores ${ARTIFACTS_GITIGNORE_ENTRY}`,
    };
  }
  return {
    id: 'runtime-gitignore',
    severity: 'warn',
    title:
      gitignore === null
        ? `no .gitignore found: ${ARTIFACTS_GITIGNORE_ENTRY} (usage evidence, assignment logs, replay results) would be committed`
        : `.gitignore does not ignore ${ARTIFACTS_GITIGNORE_ENTRY} (usage evidence, assignment logs, replay results would be committed)`,
    remediation: `Add \`${ARTIFACTS_GITIGNORE_ENTRY}\` to .gitignore (running \`ai-sdlc execute\` appends it to the runtime block), and remove any later \`!\` line that re-includes it.`,
    anonymizableEvidence: { gitignorePresent: gitignore !== null },
  };
}

// ── Worktree git hooks (AISDLC-693) ─────────────────────────────────────

interface HooksState {
  dir: string | null;
  hasPrePush: boolean;
}

/**
 * Ask git where hooks live for the checkout at `checkout` (never assuming
 * `.husky`) and whether that directory holds an executable `pre-push`.
 */
function readHooksState(ctx: DoctorRunContext, checkout: string): HooksState {
  const r = ctx.adapters.runCommand('git', ['-C', checkout, 'rev-parse', '--git-path', 'hooks']);
  const out = r.stdout.trim();
  if (r.exitCode !== 0 || out === '') return { dir: null, hasPrePush: false };
  const dir = resolve(checkout, out);
  const exec = ctx.adapters.runCommand('test', ['-x', join(dir, 'pre-push')]);
  return { dir, hasPrePush: exec.exitCode === 0 };
}

/** Worktrees under `<project>/.worktrees/` whose hooks directory has no executable pre-push. */
function findWorktreesWithoutHooks(ctx: DoctorRunContext): string[] {
  const root = join(ctx.projectDir, '.worktrees');
  return ctx.adapters
    .listDir(root)
    .map((name) => join(root, name))
    .filter((wt) => !readHooksState(ctx, wt).hasPrePush);
}

/**
 * A worktree whose hooks directory is missing runs no pre-commit, commit-msg or
 * pre-push hook, silently (husky's `.husky/_` is generated by `prepare`). Reports
 * the affected worktrees when the main checkout HAS a pre-push hook; quiet when it
 * has none (no hook expected, e.g. an adopter without husky) or when every
 * worktree is fine. Severity is `warn`, like the other local-state findings with a
 * mechanical fix: nothing is broken until someone commits from such a worktree.
 */
export function checkWorktreeHooks(ctx: DoctorRunContext): DoctorCheckResult[] {
  const main = readHooksState(ctx, ctx.projectDir);
  if (!main.hasPrePush) return [];
  const affected = findWorktreesWithoutHooks(ctx);
  if (affected.length === 0) return [];
  const names = affected.map((wt) => basename(wt));
  return [
    {
      id: 'worktree-hooks',
      severity: 'warn',
      title: `${affected.length} worktree(s) have no executable pre-push hook (main checkout has one at ${main.dir}): ${names.join(', ')}`,
      remediation:
        'Run `ai-sdlc doctor --fix` (runs `pnpm run prepare` in each affected worktree that has node_modules), or run `pnpm run prepare` in the worktree yourself. A worktree with no hooks directory runs no gate at all.',
      anonymizableEvidence: { affectedCount: affected.length },
    },
  ];
}

/**
 * `--fix`: run `pnpm run prepare` in each affected worktree that has
 * `node_modules`; report those without one as skipped (an install is a heavier
 * action than a doctor fix should take). Idempotent: a repaired worktree is no
 * longer affected.
 */
export function fixWorktreeHooks(ctx: DoctorRunContext): DoctorFixResult {
  if (!readHooksState(ctx, ctx.projectDir).hasPrePush) {
    return { id: 'worktree-hooks', applied: false, detail: 'no pre-push hook expected' };
  }
  const fixed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const wt of findWorktreesWithoutHooks(ctx)) {
    const name = basename(wt);
    if (!ctx.adapters.exists(join(wt, 'node_modules'))) {
      skipped.push(name);
      continue;
    }
    ctx.adapters.runCommand('pnpm', ['--dir', wt, 'run', 'prepare']);
    (readHooksState(ctx, wt).hasPrePush ? fixed : failed).push(name);
  }
  const parts = [
    fixed.length ? `prepared: ${fixed.join(', ')}` : '',
    failed.length ? `prepare did not create hooks: ${failed.join(', ')}` : '',
    skipped.length ? `skipped (no node_modules, install first): ${skipped.join(', ')}` : '',
  ].filter(Boolean);
  return {
    id: 'worktree-hooks',
    applied: fixed.length > 0,
    detail: parts.length ? parts.join('; ') : 'no affected worktrees',
  };
}

/** AISDLC-750: marker the post-rewrite guard fix (and the proxy shim) carries. */
const POST_REWRITE_FIX_MARKER = 'AISDLC-750';

/** Worktrees whose post-rewrite hook (tracked copy and husky shim) predates the AISDLC-750 fix. */
function findWorktreesWithStaleRewriteHook(ctx: DoctorRunContext): string[] {
  const root = join(ctx.projectDir, '.worktrees');
  return ctx.adapters
    .listDir(root)
    .map((name) => join(root, name))
    .filter((wt) => {
      const copy = ctx.adapters.readFile(join(wt, '.husky', 'post-rewrite'));
      if (copy === null) return false; // no hook in this worktree: nothing runs
      const shim = ctx.adapters.readFile(join(wt, '.husky', '_', 'post-rewrite')) ?? '';
      return !copy.includes(POST_REWRITE_FIX_MARKER) && !shim.includes(POST_REWRITE_FIX_MARKER);
    });
}

/**
 * Git runs `post-rewrite` from the worktree doing the rebase, so a worktree whose copy
 * predates the AISDLC-750 fix can still move the parent's `refs/heads/main` alone.
 * `check-orchestrator-state.sh` (Step 0) repoints each worktree's generated husky shim
 * at the main checkout's hook; this reports the ones not yet repointed.
 */
export function checkWorktreeRewriteHooks(ctx: DoctorRunContext): DoctorCheckResult[] {
  const affected = findWorktreesWithStaleRewriteHook(ctx);
  if (affected.length === 0) return [];
  return [
    {
      id: 'worktree-rewrite-hooks',
      severity: 'warn',
      title: `${affected.length} worktree(s) carry a post-rewrite hook that predates the parent-guard fix: ${affected.map((wt) => basename(wt)).join(', ')}`,
      remediation: `bash ${join(ctx.projectDir, 'scripts', 'check-orchestrator-state.sh')} (repoints every worktree's .husky/_/post-rewrite at the main checkout's hook)`,
      anonymizableEvidence: { affectedCount: affected.length },
    },
  ];
}

// ── Parent checkout state (AISDLC-708) ──────────────────────────────────

/** Tracked paths whose index or working-tree content differs from HEAD, unique and sorted. */
function readDivergedPaths(ctx: DoctorRunContext): string[] {
  const paths = new Set<string>();
  for (const extra of [[], ['--cached']]) {
    const r = ctx.adapters.runCommand('git', [
      '-C',
      ctx.projectDir,
      'diff',
      '--name-only',
      ...extra,
      'HEAD',
    ]);
    if (r.exitCode !== 0) continue;
    for (const line of r.stdout.split('\n')) if (line.trim() !== '') paths.add(line.trim());
  }
  return [...paths].sort();
}

/**
 * AISDLC-750: the provable stale-index state. The index tree equals the tree of an
 * ancestor of HEAD within the last 200 commits and nothing is unstaged, so the
 * "changes" are only HEAD having moved alone (a bare `update-ref`). Returns that
 * ancestor so the recovery is exact; `null` when the state is not provable.
 */
function findProvableStaleIndexCommit(ctx: DoctorRunContext): string | null {
  const unstaged = ctx.adapters.runCommand('git', ['-C', ctx.projectDir, 'diff', '--name-only']);
  if (unstaged.exitCode !== 0 || unstaged.stdout.trim() !== '') return null;
  const tree = ctx.adapters.runCommand('git', ['-C', ctx.projectDir, 'write-tree']);
  const indexTree = tree.stdout.trim();
  if (tree.exitCode !== 0 || indexTree === '') return null;
  const log = ctx.adapters.runCommand('git', [
    '-C',
    ctx.projectDir,
    'log',
    '-n',
    '200',
    '--format=%H %T',
    'HEAD',
  ]);
  if (log.exitCode !== 0) return null;
  for (const line of log.stdout.split('\n')) {
    const [commit, commitTree] = line.trim().split(' ');
    if (commit && commitTree === indexTree) return commit;
  }
  return null;
}

/**
 * The orchestrator parent checkout sits on `main` and is read-only by contract, so
 * its index and working tree should equal HEAD. A divergence means something moved
 * HEAD without moving the index/tree (the AISDLC-708 symptom: every path between the
 * old and new main shows as a staged change) and consumers of the local checkout read
 * mismatched files. Report-only: resetting could discard changes the pipeline did not
 * make, so the remediation names the manual command. Quiet when the checkout is not on
 * `main` (a feature worktree legitimately has local changes) or is clean.
 */
export function checkParentCheckoutState(ctx: DoctorRunContext): DoctorCheckResult[] {
  const branch = ctx.adapters.runCommand('git', [
    '-C',
    ctx.projectDir,
    'symbolic-ref',
    '--short',
    'HEAD',
  ]);
  if (branch.exitCode !== 0 || branch.stdout.trim() !== 'main') return [];
  const paths = readDivergedPaths(ctx);
  if (paths.length === 0) return [];
  const shown = paths.slice(0, 5).join(', ');
  const staleCommit = findProvableStaleIndexCommit(ctx);
  if (staleCommit !== null) {
    return [
      {
        id: 'parent-checkout-state',
        severity: 'fail',
        title: `parent checkout is stale: HEAD moved alone and the index/working tree still hold the tree of ${staleCommit.slice(0, 8)} (${paths.length} path(s) show as changed: ${shown}${paths.length > 5 ? ', ...' : ''})`,
        remediation: `git -C ${ctx.projectDir} read-tree -u -m ${staleCommit} HEAD`,
        anonymizableEvidence: { divergedPathCount: paths.length, provableStaleIndex: true },
      },
    ];
  }
  return [
    {
      id: 'parent-checkout-state',
      severity: 'warn',
      title: `parent checkout index/working tree differs from HEAD in ${paths.length} path(s): ${shown}${paths.length > 5 ? ', ...' : ''}`,
      remediation: `Inspect with \`git -C ${ctx.projectDir} status\`. If the changes are not yours, run \`git -C ${ctx.projectDir} reset --hard origin/main\` (the parent is read-only by contract). Stale pipeline-cli/dist may need \`pnpm --filter @ai-sdlc/pipeline-cli build\` afterwards.`,
      anonymizableEvidence: { divergedPathCount: paths.length },
    },
  ];
}

// ── Force-push policy (AISDLC-710) ──────────────────────────────────────

export type ForcePushPolicySource = 'default' | 'explicit' | 'malformed';

export interface ForcePushPolicyReading {
  mode: 'leaseOnOwnBranch' | 'never';
  source: ForcePushPolicySource;
  /** The raw value as written (undefined when unset). */
  raw?: string;
}

/**
 * Reads `spec.governance.allowForcePush` out of agent-role.yaml text, mirroring
 * the plugin hook's resolver (`ai-sdlc-plugin/hooks/lib/governance-resolver.js`,
 * `describeForcePushPolicy`): unset is the `leaseOnOwnBranch` default, an explicit
 * `leaseOnOwnBranch`/`true` or `never`/`false` wins, anything else present is
 * malformed and fails closed to `never`. The orchestrator package cannot import the
 * plugin's CommonJS file (it is not shipped with it), so the few lines of parsing are
 * duplicated here on purpose; keep the two in step.
 */
export function readForcePushPolicy(yamlText: string | null): ForcePushPolicyReading {
  if (yamlText === null) return { mode: 'leaseOnOwnBranch', source: 'default' };
  let govIndent: number | null = null;
  let raw: string | undefined;
  for (const line of yamlText.split('\n')) {
    if (govIndent === null) {
      const m = line.match(/^(\s*)governance:(.*)$/);
      if (m) {
        govIndent = m[1].length;
        // Inline value (`governance: {..}`, `*anchor`) is unparseable here: fail closed.
        if (m[2].replace(/^\s*(#.*)?$/, '') !== '') {
          return { mode: 'never', source: 'malformed', raw: '<unparseable governance block>' };
        }
      }
      continue;
    }
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
    if (indent <= govIndent) break;
    const kv = line.match(/^\s*allowForcePush:\s*(.*)$/);
    if (kv) {
      raw = kv[1]
        .replace(/\s+#.*$/, '')
        .trim()
        .replace(/^['"]/, '')
        .replace(/['"]$/, '');
    }
  }
  if (raw === undefined) return { mode: 'leaseOnOwnBranch', source: 'default' };
  if (raw === 'true' || raw === 'leaseOnOwnBranch') {
    return { mode: 'leaseOnOwnBranch', source: 'explicit', raw };
  }
  if (raw === 'false' || raw === 'never') return { mode: 'never', source: 'explicit', raw };
  return { mode: 'never', source: 'malformed', raw };
}

/**
 * Reports the EFFECTIVE `allowForcePush` value and where it came from, so an
 * adopter can see why a lease push is (or is not) allowed without reading source.
 * Reads the working-tree copy; the PreToolUse hook enforces the copy in the main
 * checkout (a worktree copy can only tighten it).
 */
export function checkForcePushPolicy(ctx: DoctorRunContext): DoctorCheckResult {
  const rolePath = join(ctx.projectDir, '.ai-sdlc', 'agent-role.yaml');
  const text = ctx.adapters.readFile(rolePath);
  const reading = readForcePushPolicy(text);
  const where =
    reading.source === 'default'
      ? text === null
        ? 'default; no .ai-sdlc/agent-role.yaml found'
        : 'default; spec.governance.allowForcePush is not set in .ai-sdlc/agent-role.yaml'
      : reading.source === 'explicit'
        ? `set explicitly in .ai-sdlc/agent-role.yaml (allowForcePush: ${reading.raw})`
        : `malformed value in .ai-sdlc/agent-role.yaml (allowForcePush: ${reading.raw || '<empty>'}), failing closed`;
  const evidence = { effective: reading.mode, source: reading.source };
  if (reading.source === 'malformed') {
    return {
      id: 'force-push-policy',
      severity: 'warn',
      title: `allowForcePush effective value: never (${where})`,
      remediation:
        "Set spec.governance.allowForcePush in .ai-sdlc/agent-role.yaml to `leaseOnOwnBranch` (the default; lease push of a task's own branch after a rebase) or `never`.",
      anonymizableEvidence: evidence,
    };
  }
  return {
    id: 'force-push-policy',
    severity: 'pass',
    title: `allowForcePush effective value: ${reading.mode} (${where})`,
    ...(reading.mode === 'never'
      ? {
          remediation:
            "Agents are asked to authorize every lease push after a rebase. Remove spec.governance.allowForcePush (or set it to `leaseOnOwnBranch`) in .ai-sdlc/agent-role.yaml to allow a lease push of a task's own branch without a prompt.",
        }
      : {}),
    anonymizableEvidence: evidence,
  };
}

// ── Judgment layer ──────────────────────────────────────────────────────

/**
 * Audits the judgment layer configuration (`.ai-sdlc/judgment-config.yaml`,
 * or the file named by `AI_SDLC_JUDGMENT_CONFIG_PATH`). Reads the file in the
 * working tree, so it reports what you are about to commit; the runtime itself
 * reads the committed copy on the base branch.
 *
 * Conditions: layer disabled (informational), provider key missing, model not
 * pinned while any judgment is `enforce`, and each `enforce` judgment the
 * runtime would run as `shadow` (with the reason).
 */
/** Remove control characters (C0, DEL, C1, including ESC) from config-derived text. */
function cleanText(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x1f && (c < 0x7f || c > 0x9f)) out += ch;
  }
  return out;
}

export function checkJudgmentLayer(ctx: DoctorRunContext): DoctorCheckResult[] {
  const { env } = ctx.adapters;
  const config = loadJudgmentConfig({
    workDir: ctx.projectDir,
    env,
    readLocalFile: (p) => ctx.adapters.readFile(p),
    readBaseConfig: (dir) => ctx.adapters.readFile(join(dir, '.ai-sdlc', 'judgment-config.yaml')),
  });
  if (!config.provider) {
    return [
      {
        id: 'judgment-layer',
        severity: 'pass',
        title: 'judgment layer is disabled (no provider configured); every judgment abstains',
        anonymizableEvidence: { enabled: false },
      },
    ];
  }

  const results: DoctorCheckResult[] = [];
  const provider = createBuiltInJudgmentProvider(config.provider, { model: config.model });
  if (!provider) {
    return [
      {
        id: 'judgment-layer',
        severity: 'warn',
        title: `judgment provider '${cleanText(config.provider)}' is not built in; every judgment abstains`,
        remediation: 'Set `spec.provider` to a built-in provider (jev) in the judgment config.',
        anonymizableEvidence: { providerBuiltIn: false },
      },
    ];
  }

  if (!env[provider.requires.envVar]) {
    results.push({
      id: 'judgment-provider-key',
      severity: 'warn',
      title: `judgment provider '${cleanText(provider.name)}' is configured but ${provider.requires.envVar} is not set; every judgment abstains`,
      remediation: `Export ${provider.requires.envVar} in the environment that runs the pipeline.`,
      anonymizableEvidence: { provider: provider.name, keyPresent: false },
    });
  }

  const enforced = Object.entries(config.judgments).filter(
    ([, j]) => (j.mode ?? config.defaults.mode) === 'enforce',
  );
  if (config.defaults.mode === 'enforce' || enforced.length > 0) {
    if (!config.model || isModelAlias(config.model)) {
      results.push({
        id: 'judgment-model-pin',
        severity: 'warn',
        title: `judgment model is ${config.model ? `the alias '${cleanText(config.model)}'` : 'not pinned'} while judgments are configured to enforce; they run as shadow`,
        remediation: 'Set `spec.model` to an exact version such as jev-1.13.0.',
        anonymizableEvidence: { pinned: false, enforceCount: enforced.length },
      });
    }
  }

  for (const [id] of enforced) {
    const definition = getJudgmentDefinition(id);
    const reason = definition
      ? judgmentEnforceDowngradeReason(definition, config, provider)
      : 'unknown-judgment';
    if (reason) {
      results.push({
        id: 'judgment-enforce-downgrade',
        severity: 'warn',
        title: `judgment '${cleanText(id)}' is configured enforce but the runtime runs it as shadow (${reason})`,
        remediation:
          'Add thresholds and a promotion record for this provider and model, or set the judgment to shadow.',
        anonymizableEvidence: { reason },
      });
    }
  }

  if (results.length === 0) {
    results.push({
      id: 'judgment-layer',
      severity: 'pass',
      title: `judgment layer enabled (provider ${cleanText(provider.name)}, model ${cleanText(config.model ?? provider.modelId)})`,
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
    id: 'reviewer-attribution-resolver',
    description:
      'Reviewer-attribution resolver (resolve-transcript-task-id.sh) is bundled with the plugin install (AISDLC-623).',
    run: checkReviewerAttributionResolver,
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
  {
    id: 'usage-ingest',
    description: 'Time of the last successful usage ingest (RFC-0050).',
    run: checkUsageIngest,
  },
  {
    id: 'orphaned-vitest-workers',
    description:
      'Orphaned vitest workers (parent pid 1, older than 2 minutes) left by killed test runs (AISDLC-681).',
    run: checkOrphanedVitestWorkers,
  },
  {
    id: 'runtime-gitignore',
    description: '.gitignore ignores the .ai-sdlc/artifacts/ runtime output directory (RFC-0050).',
    run: checkRuntimeGitignore,
  },
  {
    id: 'worktree-hooks',
    description:
      'Worktrees under .worktrees/ whose git hooks directory has no executable pre-push while the main checkout has one (AISDLC-693).',
    run: checkWorktreeHooks,
    fix: fixWorktreeHooks,
  },
  {
    id: 'parent-checkout-state',
    description:
      'Orchestrator parent checkout on main whose index or working tree differs from HEAD, with the path count (AISDLC-708).',
    run: checkParentCheckoutState,
  },
  {
    id: 'worktree-rewrite-hooks',
    description:
      'Worktrees whose post-rewrite hook predates the parent-on-main guard fix and can desync the parent checkout (AISDLC-750).',
    run: checkWorktreeRewriteHooks,
  },
  {
    id: 'force-push-policy',
    description:
      'Effective spec.governance.allowForcePush value and whether it is the default or set in agent-role.yaml (AISDLC-710).',
    run: checkForcePushPolicy,
  },
  {
    id: 'judgment-layer',
    description:
      'Judgment layer: disabled state, provider key, model pinning, and enforce judgments the runtime would run as shadow (RFC-0049).',
    run: checkJudgmentLayer,
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
