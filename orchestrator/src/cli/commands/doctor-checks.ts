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

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { CLIENT_SIDE_ONLY_MESSAGE } from './branch-protection-shared.js';
import { homedir } from 'node:os';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
  createBuiltInJudgmentProvider,
  getJudgmentDefinition,
  isModelAlias,
  judgmentEnforceDowngradeReason,
  loadJudgmentConfig,
  resolveJudgmentProvider,
  SCHEMAS,
} from '@ai-sdlc/reference';
import { now as clockNow } from '../../clock.js';
import {
  ARTIFACTS_GITIGNORE_ENTRY,
  gitCheckIgnoreArgs,
  gitignoreCovers,
  interpretCheckIgnoreExit,
} from '../../runtime-gitignore.js';
import { HUSKY_PREPUSH_SIGN_SNIPPET } from './init-templates.js';
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
  /** Delete a file; only ever called by a check's `fix()`. Optional so existing fixtures stay valid. */
  removeFile?: (path: string) => void;
  /** List immediate subdirectory names of `path`; `[]` if missing/unreadable. Never throws. */
  listDir: (path: string) => string[];
  /**
   * Paths of Claude Code transcripts modified since `sinceMs`, newest first
   * (idle-sessions check). Optional so existing adapter fixtures stay valid;
   * absent means the check passes with nothing to inspect.
   */
  recentTranscripts?: (homeDir: string, sinceMs: number) => string[];
  /** List immediate file names of `path`; `[]` if missing/unreadable. Never throws. Optional so older fixtures compile. */
  listFiles?: (path: string) => string[];
  /** Modification time of a file in milliseconds; `null` if missing. Optional so older fixtures compile. */
  fileMtimeMs?: (path: string) => number | null;
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
    removeFile: (p) => unlinkSync(p),
    listDir: (p) => {
      try {
        return readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    recentTranscripts: listRecentTranscripts,
    listFiles: (p) => {
      try {
        return readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
    fileMtimeMs: (p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
    homeDir: () => homedir(),
    env: process.env,
  };
}

/** Transcripts under `<home>/.claude/projects` touched since `sinceMs`, newest first. */
function listRecentTranscripts(home: string, sinceMs: number): string[] {
  const found: { p: string; m: number }[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const m = statSync(p).mtimeMs;
          if (m > sinceMs) found.push({ p, m });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(join(home, '.claude', 'projects'));
  return found.sort((a, b) => b.m - a.m).map((f) => f.p);
}

export interface DoctorRunContext {
  projectDir: string;
  adapters: DoctorCheckAdapters;
  /** Task id for task-scoped checks such as `lease-push-preflight` (`doctor --task <id>`). */
  taskId?: string;
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

  if (
    gov.state === 'fully-configured' &&
    gov.branchProtection.requiresBacklogDrift === false &&
    ctx.adapters.exists(join(ctx.projectDir, 'backlog'))
  ) {
    return {
      id: 'attestation-governance',
      severity: 'warn',
      title:
        'branch protection requires `ai-sdlc/pr-ready` but not the `Backlog Drift` context — the AISDLC-388 contract needs both',
      remediation:
        'Add `Backlog Drift` to the required status checks on main (Settings > Branches), or re-run `ai-sdlc init --add branch-protection`',
      anonymizableEvidence: { state: gov.state, requiresBacklogDrift: false },
    };
  }

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

  if (gov.artifactsPresent && gov.branchProtection.apiUnavailable) {
    return {
      id: 'attestation-governance',
      severity: 'fail',
      title: CLIENT_SIDE_ONLY_MESSAGE,
      remediation:
        'Branch protection is unavailable (HTTP 403, GitHub Free private repo). Merge only through cli-merge-if-eligible, or make the repo public / upgrade the plan and run `ai-sdlc init --add branch-protection`.',
      anonymizableEvidence: { ...evidence, enforcement: 'client-side' },
    };
  }

  if (gov.branchProtection.requiresAttestationDirectly) {
    return {
      id: 'attestation-governance',
      severity: 'fail',
      title:
        'branch protection requires `ai-sdlc/attestation` directly — it is audit-only by design (AISDLC-388) and should not gate merges on its own',
      remediation: 'Require `ai-sdlc/pr-ready` instead of `ai-sdlc/attestation` directly',
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

// ── Idle polling sessions (AISDLC-765) ───────────────────────────────────

export const IDLE_POLL_WARN_MINUTES = 30;
const IDLE_POLL_MAX_CALLS = 4;

/**
 * Minutes a transcript has been polling empty: the trailing run of turns that
 * each end in a noop `ScheduleWakeup` within a few model calls. 0 when the
 * session's last turn did real work. Only timestamps and tool names are read.
 */
export function idlePollingMinutes(transcript: string): number {
  let runStart: number | undefined;
  let last = 0;
  let calls = 0;
  let noop = false;
  const closeTurn = (): void => {
    if (calls === 0) return;
    if (noop && calls <= IDLE_POLL_MAX_CALLS) runStart ??= firstTs;
    else runStart = undefined;
  };
  let firstTs = 0;
  for (const line of transcript.split('\n')) {
    if (!line) continue;
    let j: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'user') {
      const raw = j.message?.content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      if (!/tool_result/.test(text.slice(0, 200))) {
        closeTurn();
        calls = 0;
        noop = false;
      }
      continue;
    }
    if (j.type !== 'assistant' || !j.message?.usage) continue;
    const t = Date.parse(j.timestamp);
    if (!Number.isFinite(t)) continue;
    if (calls === 0) firstTs = t;
    calls++;
    last = t;
    if (
      (Array.isArray(j.message.content) ? j.message.content : []).some(
        (b: any) => b?.type === 'tool_use' && b.name === 'ScheduleWakeup' && !!b.input?.noop, // eslint-disable-line @typescript-eslint/no-explicit-any
      )
    )
      noop = true;
  }
  closeTurn();
  return runStart === undefined ? 0 : Math.round((last - runStart) / 60_000);
}

/**
 * Warns when a recently active session has polled empty (noop wakeups with no
 * real work) for over 30 minutes. A session counts as live when its transcript
 * changed in the last hour. Passes silently-worded when none is found.
 */
export function checkIdleSessions(ctx: DoctorRunContext): DoctorCheckResult {
  const list = ctx.adapters.recentTranscripts;
  const now = clockNow().getTime();
  const paths = list ? list(ctx.adapters.homeDir(), now - 60 * 60_000) : [];
  const idle: number[] = [];
  for (const p of paths.slice(0, 20)) {
    const text = ctx.adapters.readFile(p);
    if (text === null) continue;
    const mins = idlePollingMinutes(text);
    if (mins > IDLE_POLL_WARN_MINUTES) idle.push(mins);
  }
  if (idle.length === 0) {
    return { id: 'idle-sessions', severity: 'pass', title: 'no session is polling empty' };
  }
  return {
    id: 'idle-sessions',
    severity: 'warn',
    title: `${idle.length} session(s) polling empty for over ${IDLE_POLL_WARN_MINUTES} minutes (longest ${Math.max(...idle)} min)`,
    remediation:
      'Stop the idle loop or lengthen its interval; run `cli-usage audit --days 7` to see what idle polling costs.',
    anonymizableEvidence: { idleSessionCount: idle.length, longestIdleMinutes: Math.max(...idle) },
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

/** AISDLC-799: GitHub Actions queue pressure thresholds for the `ci-queue` check. */
export const CI_QUEUE_MAX_QUEUED = 40;
export const CI_QUEUE_MAX_OLDEST_MINUTES = 15;

/**
 * AISDLC-799: warns when the Actions job queue is saturated (queued runs above
 * {@link CI_QUEUE_MAX_QUEUED} or the oldest queued run older than
 * {@link CI_QUEUE_MAX_OLDEST_MINUTES} minutes). The 2026-10-10 incident showed
 * saturation only as missing merges. Read-only; quiet when `gh` is unavailable,
 * unauthenticated or returns something unparseable.
 */
export function checkCiQueue(ctx: DoctorRunContext): DoctorCheckResult[] {
  const r = ctx.adapters.runCommand('gh', [
    'run',
    'list',
    '--status',
    'queued',
    '--json',
    'createdAt',
    '--limit',
    '500',
  ]);
  if (r.exitCode !== 0) return [];
  let runs: unknown;
  try {
    runs = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(runs)) return [];
  const times = (runs as Array<{ createdAt?: unknown }>)
    .map((x) => (typeof x.createdAt === 'string' ? Date.parse(x.createdAt) : NaN))
    .filter((t) => !Number.isNaN(t));
  const oldestMin =
    times.length === 0
      ? 0
      : Math.max(0, Math.floor((clockNow().getTime() - Math.min(...times)) / 60_000));
  const tooMany = runs.length > CI_QUEUE_MAX_QUEUED;
  const tooOld = oldestMin > CI_QUEUE_MAX_OLDEST_MINUTES;
  if (!tooMany && !tooOld) return [];
  return [
    {
      id: 'ci-queue',
      severity: 'warn',
      title: `GitHub Actions queue is saturated: ${runs.length} queued (limit ${CI_QUEUE_MAX_QUEUED}), oldest queued ${oldestMin} min (limit ${CI_QUEUE_MAX_OLDEST_MINUTES})`,
      remediation:
        'Run `node pipeline-cli/bin/cli-ci.mjs queue` to see the per-workflow breakdown, then `node pipeline-cli/bin/cli-ci.mjs sweep --dry-run` (drop `--dry-run` to cancel stale-head and duplicate queued runs).',
      anonymizableEvidence: { queued: runs.length, oldestQueuedMinutes: oldestMin },
    },
  ];
}

/**
 * AISDLC-791: a running hierarchy session must have been launched with
 * `AI_SDLC_HIERARCHY_SESSION=<name>` and `AI_SDLC_HIERARCHY_ROLE=<role>`: the
 * lease-push hook binds an executor by them, and a bare launch (an older build's
 * `up`) is refused at push time with `not-task-worktree`. Reads the roster and each
 * pane's `#{pane_start_command}`; quiet when there is no roster or tmux cannot say.
 */
export function checkHierarchyLaunchEnv(ctx: DoctorRunContext): DoctorCheckResult[] {
  const raw = ctx.adapters.readFile(join(ctx.projectDir, '.ai-sdlc', 'dispatch', 'hierarchy.json'));
  if (raw === null) return [];
  let sessions: unknown;
  try {
    sessions = (JSON.parse(raw) as { sessions?: unknown }).sessions;
  } catch {
    return [];
  }
  if (!Array.isArray(sessions)) return [];
  const bare: string[] = [];
  for (const e of sessions as Array<Record<string, unknown>>) {
    const { name, role, tmuxSession, tmuxWindow } = e;
    if (e.status !== 'running') continue;
    if (![name, role, tmuxSession, tmuxWindow].every((v) => typeof v === 'string')) continue;
    const r = ctx.adapters.runCommand('tmux', [
      'display-message',
      '-p',
      '-t',
      `=${tmuxSession as string}:${tmuxWindow as string}`,
      '#{pane_start_command}',
    ]);
    const command = r.exitCode === 0 ? r.stdout.trim() : '';
    if (command === '') continue;
    const has = (key: string, value: string): boolean =>
      new RegExp(
        `(?:^|\\s)${key}=(['"]?)${(value as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1(?:\\s|$)`,
      ).test(command);
    if (
      !has('AI_SDLC_HIERARCHY_SESSION', name as string) ||
      !has('AI_SDLC_HIERARCHY_ROLE', role as string)
    ) {
      bare.push(`${name as string} (${role as string})`);
    }
  }
  if (bare.length === 0) return [];
  return [
    {
      id: 'hierarchy-launch-env',
      severity: 'warn',
      title: `${bare.length} hierarchy session(s) were launched without AI_SDLC_HIERARCHY_SESSION/AI_SDLC_HIERARCHY_ROLE (env: missing): ${bare.join(', ')}`,
      remediation:
        "Relaunch with `cli-hierarchy down --role <role>` then `up` from the main checkout's build; `cli-hierarchy clear` never relaunches a process. Without the env the lease push is refused with `not-task-worktree` (DEC-0079, DEC-0080).",
      anonymizableEvidence: { affectedCount: bare.length },
    },
  ];
}

/**
 * AISDLC-988: inside the monorepo, a pipeline-cli build that is missing or older than
 * its sources makes dispatch run old code. Asks the resolve script's single freshness
 * check (`--strict`, which exits 1 on a stale repo build); quiet in repos without the
 * script and when the build is fresh.
 */
export function checkStaleRepoBuild(ctx: DoctorRunContext): DoctorCheckResult[] {
  const script = join(ctx.projectDir, 'ai-sdlc-plugin', 'scripts', 'resolve-pipeline-cli.sh');
  if (!ctx.adapters.exists(script)) return [];
  const r = ctx.adapters.runCommand('bash', [
    '-c',
    'cd "$1" && bash "$2" --strict',
    '_',
    ctx.projectDir,
    script,
  ]);
  if (r.exitCode === 0) return [];
  return [
    {
      id: 'stale-repo-build',
      severity: 'warn',
      title: "this repo's pipeline-cli build is missing or older than its sources (build: stale)",
      remediation:
        'Run `pnpm --filter @ai-sdlc/pipeline-cli build` (or `cli-hierarchy up --rebuild`); until then dispatch runs old code.',
    },
  ];
}

/** Prints the plugin's own `evaluateLeasePush` result as JSON (args: module, projectDir, cwd, branch). */
const LEASE_PREFLIGHT_SCRIPT =
  'const m=require(process.argv[1]);const r=m.evaluateLeasePush({projectDir:process.argv[2],cwd:process.argv[3],env:process.env,...(process.argv[4]?{branch:process.argv[4]}:{})});console.log(JSON.stringify({allowed:r.allowed,failing:r.failing}));';

/**
 * AISDLC-798: for `doctor --task <id>`, evaluates the lease-push hook's own
 * predicate (the plugin's `evaluateLeasePush`) for that task's worktree and prints
 * each unmet condition with its sanctioned fix, the same table the pipeline prints
 * before Step 10.5. Quiet without `--task`.
 */
export function checkLeasePushPreflight(ctx: DoctorRunContext): DoctorCheckResult[] {
  const taskId = ctx.taskId;
  if (!taskId) return [];
  const id = 'lease-push-preflight';
  const worktree = join(ctx.projectDir, '.worktrees', taskId.toLowerCase());
  const module = join(ctx.projectDir, 'ai-sdlc-plugin', 'hooks', 'lib', 'trusted-policy.js');
  if (!ctx.adapters.exists(worktree)) {
    return [
      {
        id,
        severity: 'fail',
        title: `no worktree at ${worktree} for ${taskId}`,
        remediation:
          'Run `/ai-sdlc execute` for the task (Step 3 creates the worktree), then re-run.',
      },
    ];
  }
  if (!ctx.adapters.exists(module)) {
    return [
      {
        id,
        severity: 'warn',
        title: `lease-push preflight skipped: ${module} not found`,
        remediation: 'Run from the repository that carries ai-sdlc-plugin/.',
      },
    ];
  }
  const branch = ctx.adapters.runCommand('git', [
    '-C',
    worktree,
    'symbolic-ref',
    '--short',
    'HEAD',
  ]);
  const run = ctx.adapters.runCommand('node', [
    '-e',
    LEASE_PREFLIGHT_SCRIPT,
    module,
    ctx.projectDir,
    worktree,
    branch.exitCode === 0 ? branch.stdout.trim() : '',
  ]);
  let parsed: { allowed: boolean; failing: Array<Record<string, string>> };
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return [
      { id, severity: 'warn', title: `lease-push preflight could not be evaluated for ${taskId}` },
    ];
  }
  if (parsed.allowed) {
    return [{ id, severity: 'pass', title: `lease push allowed for ${taskId} from ${worktree}` }];
  }
  const table = parsed.failing
    .map(
      (f) => `${f['condition']}: found ${f['found']}; expected ${f['expected']}; fix: ${f['fix']}`,
    )
    .join('\n');
  return [
    {
      id,
      severity: 'fail',
      title: `lease push for ${taskId} would be refused (not-task-worktree):\n${table}`,
      remediation: parsed.failing.map((f) => f['fix']).join('\n'),
      anonymizableEvidence: { conditions: parsed.failing.map((f) => f['condition']) },
    },
  ];
}

/** AISDLC-800: an inflight claim whose heartbeat is older than this is stale (matches the board's reaper). */
const DISPATCH_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
/** AISDLC-800: a `done/` iterate-needed verdict older than this must have a released or continued claim. */
const DISPATCH_VERDICT_GRACE_MS = 10 * 60 * 1000;

/**
 * AISDLC-800: the dispatch board invariants the protocol states in prose and the
 * CLI now enforces: (1) one claim per worker, (2) every inflight claim has a
 * heartbeat younger than the stale window, (3) no resume manifest carries a
 * `wave`, (4) no `done/` iterate-needed verdict older than 10 minutes without a
 * released claim. One result per invariant; quiet when there is no board.
 */
export function checkDispatchBoard(ctx: DoctorRunContext): DoctorCheckResult[] {
  const board = join(ctx.projectDir, '.ai-sdlc', 'dispatch');
  const { listFiles, fileMtimeMs } = ctx.adapters;
  if (!ctx.adapters.exists(board) || !listFiles) return [];
  const nowMs = clockNow().getTime();
  const readManifests = (sub: string): Array<{ file: string; m: Record<string, unknown> }> =>
    listFiles(join(board, sub))
      .filter((f) => f.endsWith('.dispatch.json'))
      .flatMap((file) => {
        const m = readJson(ctx, join(board, sub, file));
        return m && typeof m === 'object' ? [{ file, m: m as Record<string, unknown> }] : [];
      });
  const inflight = readManifests('inflight');
  const queued = readManifests('queue');

  const byWorker = new Map<string, string[]>();
  for (const { file, m } of inflight) {
    const w = typeof m.workerId === 'string' ? m.workerId : undefined;
    if (!w) continue;
    byWorker.set(w, [...(byWorker.get(w) ?? []), String(m.taskId ?? file)]);
  }
  const multi = [...byWorker.entries()].filter(([, ids]) => ids.length > 1);

  const noBeat: string[] = [];
  for (const { file, m } of inflight) {
    const id = String(m.taskId ?? file.replace(/\.dispatch\.json$/, ''));
    const state = readJson(ctx, join(board, 'inflight', `${id}.state.json`)) as
      | { lastHeartbeat?: string }
      | undefined;
    const beat = state?.lastHeartbeat ? Date.parse(state.lastHeartbeat) : Number.NaN;
    if (!Number.isFinite(beat)) noBeat.push(`${id} (no heartbeat)`);
    else if (nowMs - beat > DISPATCH_HEARTBEAT_STALE_MS) noBeat.push(`${id} (stale heartbeat)`);
  }

  const waved = [...queued, ...inflight]
    .filter(({ m }) => m.resume !== undefined && m.wave !== undefined)
    .map(({ m, file }) => String(m.taskId ?? file));

  const unhandled: string[] = [];
  const held = new Set(inflight.map(({ m }) => String(m.taskId)));
  for (const file of listFiles(join(board, 'done'))) {
    if (!file.endsWith('.verdict.json')) continue;
    const verdict = readJson(ctx, join(board, 'done', file)) as
      | { taskId?: string; outcome?: string; completedAt?: string }
      | undefined;
    if (verdict?.outcome !== 'iterate-needed') continue;
    const id = verdict.taskId ?? file.replace(/\.verdict\.json$/, '');
    const at = verdict.completedAt
      ? Date.parse(verdict.completedAt)
      : (fileMtimeMs?.(join(board, 'done', file)) ?? Number.NaN);
    if (!Number.isFinite(at) || nowMs - at <= DISPATCH_VERDICT_GRACE_MS) continue;
    if (held.has(id) || !queued.some(({ m }) => m.taskId === id)) unhandled.push(id);
  }

  const result = (
    id: string,
    bad: string[],
    ok: string,
    problem: string,
    remediation: string,
    severity: CheckSeverity = 'fail',
  ): DoctorCheckResult =>
    bad.length === 0
      ? { id, severity: 'pass', title: ok }
      : {
          id,
          severity,
          title: `${problem}: ${bad.join(', ')}`,
          remediation,
          anonymizableEvidence: { affectedCount: bad.length },
        };
  return [
    result(
      'dispatch-board-one-claim-per-worker',
      multi.map(([w, ids]) => `${w} holds ${ids.join(' and ')}`),
      'every worker holds at most one inflight claim',
      'a worker holds more than one inflight claim',
      'Finish or release all but one (`cli-dispatch release --task-id <id>`).',
    ),
    result(
      'dispatch-board-heartbeat',
      noBeat,
      `every inflight claim has a heartbeat younger than ${DISPATCH_HEARTBEAT_STALE_MS / 60000} minutes`,
      'inflight claims without a fresh heartbeat',
      'Run `cli-dispatch reap`, or have the executor write its heartbeat (`cli-dispatch heartbeat`).',
      'warn',
    ),
    result(
      'dispatch-board-resume-wave',
      waved,
      'no resume manifest carries a wave',
      'resume manifests carrying a wave',
      'Re-run `cli-dispatch reenter <pr>` for the task; a resume sorts by priority and has no wave.',
    ),
    result(
      'dispatch-board-stale-verdict',
      unhandled,
      'every iterate-needed verdict in done/ has a released or continued claim',
      'iterate-needed verdicts older than 10 minutes with no released claim',
      'Release the claim (`cli-dispatch release --task-id <id>`) then `cli-dispatch reenter <pr>`.',
      'warn',
    ),
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
        "Set spec.governance.allowForcePush in .ai-sdlc/agent-role.yaml to `leaseOnOwnBranch` (the default; lease push of a task's own branch after a rebase), `lease` (lease push to any non-protected branch, DEC-0264) or `never`.",
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
  let resolved: ReturnType<typeof resolveJudgmentProvider>;
  try {
    resolved = resolveJudgmentProvider(config.provider, config.providerOptions, config.model);
  } catch {
    resolved = undefined;
  }
  if (resolved?.rejectedReason) {
    return [
      {
        id: 'judgment-provider-options',
        severity: 'warn',
        title: `judgment provider '${cleanText(config.provider)}' options were rejected, so the layer is disabled: ${cleanText(resolved.rejectedReason)}`,
        remediation:
          'Fix `spec.providerOptions` in the judgment config; see docs/operations/judgment-layer.md.',
        anonymizableEvidence: { provider: config.provider, optionsRejected: true },
      },
    ];
  }
  const provider =
    resolved ?? createBuiltInJudgmentProvider(config.provider, { model: config.model });
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

  if (provider.requires.envVar && !env[provider.requires.envVar]) {
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

// ── Untracked review ledgers (AISDLC-793) ───────────────────────────────

function strandedTitle(stranded: string[]): string {
  return `${stranded.length} completed-task review ledger(s) in worktrees have rows missing from main: ${stranded.join(', ')}`;
}

/**
 * Ledgers inside `.worktrees/<wt>/.ai-sdlc/reviews/` whose task is in
 * `backlog/completed/` and whose rows are not all on main (AISDLC-966). Main's copy
 * must start with the worktree copy; otherwise a worktree sweep would lose rows.
 */
function findStrandedWorktreeLedgers(ctx: DoctorRunContext): string[] {
  const { listDir, listFiles, readFile, runCommand } = ctx.adapters;
  if (!listFiles) return [];
  const completed = listFiles(join(ctx.projectDir, 'backlog', 'completed')).map((f) =>
    f.toLowerCase(),
  );
  const out: string[] = [];
  for (const wt of listDir(join(ctx.projectDir, '.worktrees'))) {
    const dir = join(ctx.projectDir, '.worktrees', wt, '.ai-sdlc', 'reviews');
    for (const f of listFiles(dir).filter((n) => n.endsWith('.jsonl'))) {
      const task = basename(f, '.jsonl').toLowerCase();
      const isCompleted = completed.some(
        (c) => c.startsWith(`${task} - `) || c.startsWith(`${task}.md`),
      );
      if (!isCompleted) continue;
      const local = readFile(join(dir, f));
      if (!local) continue;
      const main = runCommand('git', ['-C', ctx.projectDir, 'show', `HEAD:.ai-sdlc/reviews/${f}`]);
      const onMain = main.exitCode === 0 ? main.stdout : '';
      if (!onMain.startsWith(local)) out.push(`${wt}/${f}`);
    }
  }
  return out;
}

/**
 * The reviews ledger (`.ai-sdlc/reviews/<task-id>.jsonl`) is a committed artifact
 * that belongs in the task's PR. An untracked one in the main checkout is residue
 * from a writer that ran with the parent as its repo root; it blocks fast-forward
 * pulls when the same file later lands on main. Warns with the files and task ids.
 */
export function checkUntrackedReviewLedgers(ctx: DoctorRunContext): DoctorCheckResult {
  const r = ctx.adapters.runCommand('git', [
    '-C',
    ctx.projectDir,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    '.ai-sdlc/reviews/',
  ]);
  const files =
    r.exitCode === 0
      ? r.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.endsWith('.jsonl'))
      : [];
  const stranded = findStrandedWorktreeLedgers(ctx);
  if (files.length === 0 && stranded.length === 0) {
    return {
      id: 'untracked-review-ledgers',
      severity: 'pass',
      title: 'no untracked review ledgers in the main checkout',
    };
  }
  if (files.length === 0) {
    return {
      id: 'untracked-review-ledgers',
      severity: 'warn',
      title: strandedTitle(stranded),
      remediation:
        'Copy each listed worktree ledger into .ai-sdlc/reviews/ on a chore PR before any worktree sweep; `/ai-sdlc:cleanup` deletes them otherwise.',
      anonymizableEvidence: { strandedCount: stranded.length },
    };
  }
  const taskIds = files.map((f) => basename(f, '.jsonl'));
  return {
    id: 'untracked-review-ledgers',
    severity: 'warn',
    title:
      `${files.length} untracked review ledger(s) in the main checkout: ${files.join(', ')} (tasks: ${taskIds.join(', ')})` +
      (stranded.length > 0 ? `; ${strandedTitle(stranded)}` : ''),
    remediation:
      'Untracked ledgers are residue; `ai-sdlc doctor --fix` deletes them (tracked ledgers are never touched). See "Untracked ledgers in the main checkout" in docs/operations/transcript-management.md.',
    anonymizableEvidence: { untrackedCount: files.length },
  };
}

/**
 * `--fix` deletes the untracked ledgers. `git ls-files --others` lists only files git
 * does not track, so a committed ledger can never be selected (AISDLC-811).
 */
export function fixUntrackedReviewLedgers(ctx: DoctorRunContext): DoctorFixResult {
  const found = checkUntrackedReviewLedgers(ctx);
  if (found.severity === 'pass') {
    return {
      id: 'untracked-review-ledgers',
      applied: false,
      detail: 'no untracked review ledgers',
    };
  }
  const r = ctx.adapters.runCommand('git', [
    '-C',
    ctx.projectDir,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    '.ai-sdlc/reviews/',
  ]);
  const files = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.jsonl'));
  const remove = ctx.adapters.removeFile;
  if (!remove) {
    return {
      id: 'untracked-review-ledgers',
      applied: false,
      detail: 'no removeFile adapter; delete the untracked review ledgers by hand',
    };
  }
  const removed: string[] = [];
  for (const f of files) {
    try {
      remove(join(ctx.projectDir, f));
      removed.push(f);
    } catch {
      // leave it; the next check run reports it again
    }
  }
  return {
    id: 'untracked-review-ledgers',
    applied: removed.length > 0,
    detail: `deleted ${removed.length} untracked review ledger(s): ${removed.join(', ')}`,
  };
}

// ── Backlog drift warnings (AISDLC-797) ─────────────────────────────────

/** Drift warnings above this count get a doctor warning; the report size follows the count. */
export const BACKLOG_DRIFT_WARNING_THRESHOLD = 150;

/**
 * The backlog-drift report grows with unattended warnings; at 190 warnings it crossed the
 * 64 KiB pipe buffer and broke the required Backlog Drift check for every PR (AISDLC-796).
 * Warns once the warning count passes the threshold so the backlog is cleaned first. The
 * report is redirected to a temp file inside `sh` (never captured from the tool's own
 * stdout) for the same reason the workflow step is.
 */
export function checkBacklogDriftWarnings(ctx: DoctorRunContext): DoctorCheckResult {
  const id = 'backlog-drift-warnings';
  if (!ctx.adapters.exists(join(ctx.projectDir, 'backlog'))) {
    return { id, severity: 'pass', title: 'no backlog directory; drift check not applicable' };
  }
  const r = ctx.adapters.runCommand('sh', [
    '-c',
    'cd "$1" && f="$(mktemp)" && { npx backlog-drift@0.1.3 check --json > "$f" 2>/dev/null; cat "$f"; rm -f "$f"; }',
    'sh',
    ctx.projectDir,
  ]);
  let report: unknown;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    report = undefined;
  }
  if (!Array.isArray(report)) {
    return {
      id,
      severity: 'pass',
      title: 'backlog drift report unavailable; warning count not checked',
    };
  }
  const warnings = report.filter(
    (e) => (e as { severity?: string } | null)?.severity === 'warning',
  ).length;
  const bytes = Buffer.byteLength(r.stdout, 'utf-8');
  if (warnings <= BACKLOG_DRIFT_WARNING_THRESHOLD) {
    return {
      id,
      severity: 'pass',
      title: `backlog drift: ${warnings} warning(s), report ${bytes} bytes`,
      anonymizableEvidence: { warnings, reportBytes: bytes },
    };
  }
  return {
    id,
    severity: 'warn',
    title: `backlog drift: ${warnings} warnings exceed ${BACKLOG_DRIFT_WARNING_THRESHOLD} (report ${bytes} bytes)`,
    remediation:
      'Clean up drift warnings before the report grows large: `npx backlog-drift check`, then `npx backlog-drift fix --task <id>`.',
    anonymizableEvidence: { warnings, reportBytes: bytes },
  };
}

// ── Check: required consumer config manifest (AISDLC-910) ───────────────

/** Locate `cli-init.mjs` (the manifest owner) in the project, its node_modules, or the plugin install. */
function resolveCliInit(ctx: DoctorRunContext): string | undefined {
  const pluginDir = resolvePluginDir(ctx);
  const candidates = [
    join(ctx.projectDir, 'pipeline-cli', 'bin', 'cli-init.mjs'),
    join(ctx.projectDir, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin', 'cli-init.mjs'),
    ...(pluginDir
      ? [join(pluginDir, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin', 'cli-init.mjs')]
      : []),
  ];
  return candidates.find((c) => ctx.adapters.exists(c));
}

interface ManifestCheckReport {
  missing: { id: string; path: string; since: string; operatorInput: boolean; title: string }[];
  remediation: string;
}

/**
 * Reports the same missing entries, with the same wording, as the `/ai-sdlc
 * execute` Step 1 preflight: both come from `cli-init --check`, which reads the
 * one manifest in pipeline-cli.
 */
export function checkConfigManifest(ctx: DoctorRunContext): DoctorCheckResult[] {
  const cli = resolveCliInit(ctx);
  if (!cli) {
    return [
      {
        id: 'config-manifest',
        severity: 'warn',
        title: 'could not locate pipeline-cli cli-init; required config was not checked',
        remediation: 'Run `ai-sdlc-plugin/scripts/install-runtime-deps.sh` and re-run doctor',
      },
    ];
  }
  const res = ctx.adapters.runCommand('node', [
    cli,
    '--check',
    '--format',
    'json',
    '--project-dir',
    ctx.projectDir,
  ]);
  let report: ManifestCheckReport;
  try {
    report = JSON.parse(res.stdout) as ManifestCheckReport;
  } catch {
    return [
      {
        id: 'config-manifest',
        severity: 'warn',
        title: 'cli-init --check produced no readable report',
        remediation: res.stderr?.trim() || undefined,
      },
    ];
  }
  if (report.missing.length === 0) {
    return [
      { id: 'config-manifest', severity: 'pass', title: 'all required config entries present' },
    ];
  }
  return report.missing.map((m) => ({
    id: `config-manifest:${m.id}`,
    severity: 'fail' as const,
    title: m.title,
    remediation: report.remediation,
    anonymizableEvidence: { path: m.path, since: m.since, operatorInput: m.operatorInput },
  }));
}

/** `doctor --fix`: scaffold the entries that need no operator input. */
export function fixConfigManifest(ctx: DoctorRunContext): DoctorFixResult {
  const cli = resolveCliInit(ctx);
  if (!cli) return { id: 'config-manifest', applied: false, detail: 'cli-init not found' };
  const res = ctx.adapters.runCommand('node', [cli, '--fix', '--project-dir', ctx.projectDir]);
  const created = res.stdout.split('\n').filter((l) => l.startsWith('created '));
  return {
    id: 'config-manifest',
    applied: res.exitCode === 0 && created.length > 0,
    detail: created.length > 0 ? created.join('; ') : 'nothing to scaffold without operator input',
  };
}

// ── Checks 4, 5, 6: config files validated against their JSON schema (AISDLC-582) ──

type SchemaValidator = ReturnType<InstanceType<typeof Ajv2020>['compile']>;
let schemaAjv: InstanceType<typeof Ajv2020> | undefined;
const schemaValidators = new Map<string, SchemaValidator>();

/** Compile (and cache) the validator for a `spec/schemas/<file>` schema. */
function getSchemaValidator(schemaFile: string): SchemaValidator {
  let validator = schemaValidators.get(schemaFile);
  if (validator) return validator;
  if (!schemaAjv) {
    schemaAjv = new Ajv2020({ allErrors: true, strict: false });
    for (const schema of Object.values(SCHEMAS)) schemaAjv.addSchema(schema);
  }
  const id = (SCHEMAS[schemaFile] as { $id: string }).$id;
  validator = schemaAjv.getSchema(id) as SchemaValidator;
  schemaValidators.set(schemaFile, validator);
  return validator;
}

type ParsedConfig =
  | { state: 'missing' }
  | { state: 'unparseable'; error: string }
  | { state: 'invalid'; errors: string[]; doc: unknown }
  | { state: 'valid'; doc: unknown };

/** Read a YAML config and validate it against a schema; never throws. */
function loadAndValidateYaml(
  ctx: DoctorRunContext,
  path: string,
  schemaFile: string,
): ParsedConfig {
  const raw = ctx.adapters.readFile(path);
  if (raw == null) return { state: 'missing' };
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { state: 'unparseable', error: (err as Error).message.split('\n')[0] };
  }
  const validate = getSchemaValidator(schemaFile);
  if (validate(doc)) return { state: 'valid', doc };
  const errors = (validate.errors ?? []).slice(0, 5).map((e) => {
    return `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`;
  });
  return { state: 'invalid', errors, doc };
}

function configFindings(
  id: string,
  label: string,
  parsed: Exclude<ParsedConfig, { state: 'missing' } | { state: 'valid' }>,
  remediation: string,
): DoctorCheckResult {
  if (parsed.state === 'unparseable') {
    return {
      id,
      severity: 'fail',
      title: `${label} is not parseable YAML: ${parsed.error}`,
      remediation,
      anonymizableEvidence: { state: 'unparseable' },
    };
  }
  return {
    id,
    severity: 'fail',
    title: `${label} fails schema validation: ${parsed.errors.join('; ')}`,
    remediation,
    anonymizableEvidence: { state: 'invalid', errorCount: parsed.errors.length },
  };
}

// Check 4: agent-role.yaml

export function checkAgentRoleConfig(ctx: DoctorRunContext): DoctorCheckResult {
  const id = 'agent-role-config';
  const path = join(ctx.projectDir, '.ai-sdlc', 'agent-role.yaml');
  const parsed = loadAndValidateYaml(ctx, path, 'agent-role.schema.json');
  if (parsed.state === 'missing') {
    return {
      id,
      severity: 'warn',
      title: '.ai-sdlc/agent-role.yaml is missing — governance hooks fall back to defaults',
      remediation: 'Run `ai-sdlc init` to scaffold .ai-sdlc/agent-role.yaml',
    };
  }
  if (parsed.state !== 'valid') {
    return configFindings(
      id,
      '.ai-sdlc/agent-role.yaml',
      parsed,
      'Fix the listed fields against spec/schemas/agent-role.schema.json (SessionStart swallows this silently, so the hooks run on defaults until it is fixed)',
    );
  }
  return { id, severity: 'pass', title: '.ai-sdlc/agent-role.yaml is present and schema-valid' };
}

// Check 5: dor-config.yaml (only when the DoR feature is enabled)

export function checkDorConfig(ctx: DoctorRunContext): DoctorCheckResult {
  const id = 'dor-config';
  const path = join(ctx.projectDir, '.ai-sdlc', 'dor-config.yaml');
  const workflow = join(ctx.projectDir, '.github', 'workflows', 'dor-ingress.yml');
  const configExists = ctx.adapters.exists(path);
  if (!configExists && !ctx.adapters.exists(workflow)) {
    return { id, severity: 'pass', title: 'DoR gate not enabled — dor-config.yaml not required' };
  }
  const parsed = loadAndValidateYaml(ctx, path, 'dor-config.v1.schema.json');
  if (parsed.state === 'missing') {
    return {
      id,
      severity: 'warn',
      title: 'DoR ingress workflow is installed but .ai-sdlc/dor-config.yaml is missing',
      remediation: 'Run `ai-sdlc init --add dor` to scaffold .ai-sdlc/dor-config.yaml',
    };
  }
  if (parsed.state !== 'valid') {
    return configFindings(
      id,
      '.ai-sdlc/dor-config.yaml',
      parsed,
      'Fix the listed fields against spec/schemas/dor-config.v1.schema.json',
    );
  }
  return { id, severity: 'pass', title: '.ai-sdlc/dor-config.yaml is present and schema-valid' };
}

// Check 6: trusted-reviewers.yaml + operator signing key

function normalizePem(pem: string): string {
  return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
}

/** Derive the SPKI PEM public key from a private-key PEM; `undefined` when unparseable. */
function derivePublicKeyPem(privatePem: string): string | undefined {
  try {
    return createPublicKey(createPrivateKey(privatePem))
      .export({ type: 'spki', format: 'pem' })
      .toString();
  } catch {
    return undefined;
  }
}

export function checkTrustedReviewers(ctx: DoctorRunContext): DoctorCheckResult[] {
  const id = 'trusted-reviewers';
  const { adapters, projectDir } = ctx;
  const path = join(projectDir, '.ai-sdlc', 'trusted-reviewers.yaml');
  const workflowPresent = adapters.exists(
    join(projectDir, '.github', 'workflows', 'verify-attestation.yml'),
  );
  const parsed = loadAndValidateYaml(ctx, path, 'trusted-reviewers.schema.json');

  if (parsed.state === 'missing') {
    if (!workflowPresent) {
      return [{ id, severity: 'pass', title: 'attestation not enabled — no keyring required' }];
    }
    return [
      {
        id,
        severity: 'fail',
        title: 'verify-attestation.yml is installed but .ai-sdlc/trusted-reviewers.yaml is missing',
        remediation:
          'Run `ai-sdlc init --add attestation`, then register a key via `/ai-sdlc init-signing-key`',
      },
    ];
  }
  if (parsed.state !== 'valid') {
    return [
      configFindings(
        id,
        '.ai-sdlc/trusted-reviewers.yaml',
        parsed,
        'Fix the listed fields against spec/schemas/trusted-reviewers.schema.json',
      ),
    ];
  }

  const reviewers = ((parsed.doc as { reviewers?: Array<{ pubkey: string }> } | null)?.reviewers ??
    []) as Array<{ pubkey: string }>;
  if (reviewers.length === 0) {
    // Fresh `ai-sdlc init` repo: no attestations signed yet, so an empty keyring
    // is only a warning; it fails once attestations exist that CI would reject.
    const attestationsDir = join(projectDir, '.ai-sdlc', 'attestations');
    const hasAttestations = adapters.listDir(attestationsDir).some((n) => n.endsWith('.json'));
    const severity = hasAttestations ? 'fail' : 'warn';
    return [
      {
        id,
        severity,
        title:
          '.ai-sdlc/trusted-reviewers.yaml lists no public keys — CI rejects every attestation',
        remediation: 'Run `/ai-sdlc init-signing-key` and open a PR appending the printed entry',
        anonymizableEvidence: { keyCount: 0 },
      },
    ];
  }

  const results: DoctorCheckResult[] = [
    {
      id,
      severity: 'pass',
      title: `.ai-sdlc/trusted-reviewers.yaml is schema-valid with ${reviewers.length} key(s)`,
      anonymizableEvidence: { keyCount: reviewers.length },
    },
  ];

  const keyPath = join(adapters.homeDir(), '.ai-sdlc', 'signing-key.pem');
  const keyPem = adapters.readFile(keyPath);
  if (keyPem == null) {
    results.push({
      id: 'operator-signing-key',
      severity: 'warn',
      title: 'operator signing key (~/.ai-sdlc/signing-key.pem) not found on this machine',
      remediation: 'Run `/ai-sdlc init-signing-key` to generate one',
    });
    return results;
  }
  const publicPem = derivePublicKeyPem(keyPem);
  if (!publicPem) {
    results.push({
      id: 'operator-signing-key',
      severity: 'fail',
      title: '~/.ai-sdlc/signing-key.pem exists but is not a readable private key',
      remediation:
        'Regenerate it with `/ai-sdlc init-signing-key` and re-register the new public key',
    });
    return results;
  }
  const listed = reviewers.some((r) => normalizePem(r.pubkey) === normalizePem(publicPem));
  results.push(
    listed
      ? {
          id: 'operator-signing-key',
          severity: 'pass',
          title: 'operator signing key is registered in trusted-reviewers.yaml',
        }
      : {
          id: 'operator-signing-key',
          severity: 'warn',
          title: 'operator signing key public half is NOT listed in trusted-reviewers.yaml',
          remediation:
            'Open a PR appending this key (`/ai-sdlc init-signing-key` prints the YAML block); CI rejects attestations signed by an unlisted key',
          anonymizableEvidence: { listed: false },
        },
  );
  return results;
}

// ── Check 8: husky pre-push attestation-sign hook ─────────────────────────

const ATTESTATION_SIGN_MARKERS = ['ai-sdlc:attestation-sign-block', 'check-attestation-sign'];

function readPrePushHook(ctx: DoctorRunContext): { path: string; text: string } | undefined {
  for (const rel of [join('.husky', 'pre-push'), join('.git', 'hooks', 'pre-push')]) {
    const path = join(ctx.projectDir, rel);
    const text = ctx.adapters.readFile(path);
    if (text != null) return { path, text };
  }
  return undefined;
}

function attestationEnabled(ctx: DoctorRunContext): boolean {
  return ctx.adapters.exists(
    join(ctx.projectDir, '.github', 'workflows', 'verify-attestation.yml'),
  );
}

export function checkHuskyPrePushGate(ctx: DoctorRunContext): DoctorCheckResult {
  const id = 'husky-pre-push-gate';
  if (!attestationEnabled(ctx)) {
    return {
      id,
      severity: 'pass',
      title: 'attestation not enabled — no pre-push sign gate required',
    };
  }
  const hook = readPrePushHook(ctx);
  if (!hook) {
    return {
      id,
      severity: 'fail',
      title:
        'attestation is enabled but no .husky/pre-push (or .git/hooks/pre-push) exists — pushes carry no attestation',
      remediation:
        'Run `ai-sdlc doctor --fix` (writes the sign snippet) or `ai-sdlc init --add attestation`',
    };
  }
  if (!ATTESTATION_SIGN_MARKERS.some((m) => hook.text.includes(m))) {
    return {
      id,
      severity: 'fail',
      title:
        'pre-push hook does not reference the attestation sign snippet — pushes carry no attestation',
      remediation:
        'Run `ai-sdlc doctor --fix` to append the sign snippet, or `ai-sdlc init --add attestation`',
    };
  }
  return { id, severity: 'pass', title: 'pre-push hook runs the attestation sign snippet' };
}

/**
 * Mechanically safe: appends the sentinel-guarded snippet to an existing
 * `.husky/pre-push`, or creates it when `.husky/` already exists. Idempotent
 * (the sentinel makes a second run a no-op). Never edits `.git/hooks`.
 */
export function fixHuskyPrePushGate(ctx: DoctorRunContext): DoctorFixResult {
  const id = 'husky-pre-push-gate';
  if (checkHuskyPrePushGate(ctx).severity === 'pass') {
    return {
      id,
      applied: false,
      detail: 'pre-push gate already wired (or attestation not enabled)',
    };
  }
  const huskyDir = join(ctx.projectDir, '.husky');
  const hookPath = join(huskyDir, 'pre-push');
  const existing = ctx.adapters.readFile(hookPath);
  if (existing == null && !ctx.adapters.exists(huskyDir)) {
    return {
      id,
      applied: false,
      detail: 'no .husky/ directory — install husky first, then re-run',
    };
  }
  const base = existing == null ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
  ctx.adapters.writeFile(hookPath, `${base}${base ? '\n' : ''}${HUSKY_PREPUSH_SIGN_SNIPPET}`);
  return { id, applied: true, detail: `appended the attestation sign snippet to ${hookPath}` };
}

// ── Check 9: feature-flag sanity ──────────────────────────────────────────

/** Flags that are default-ON; an explicit opt-out value turns the feature off. */
const DEFAULT_ON_FLAGS = ['AI_SDLC_DEPS_COMPOSITION', 'AI_SDLC_AUTONOMOUS_ORCHESTRATOR'] as const;
const FLAG_OFF_VALUES = new Set(['off', '0', 'false', 'no']);

export function checkFeatureFlags(ctx: DoctorRunContext): DoctorCheckResult {
  const id = 'feature-flags';
  const disabled = DEFAULT_ON_FLAGS.filter((flag) => {
    const value = ctx.adapters.env[flag];
    return value != null && FLAG_OFF_VALUES.has(value.trim().toLowerCase());
  });
  if (disabled.length === 0) {
    return { id, severity: 'pass', title: 'default-on feature flags are not opted out' };
  }
  return {
    id,
    severity: 'warn',
    title: `default-on feature flag(s) explicitly disabled: ${disabled.join(', ')}`,
    remediation: `Unset ${disabled.join(' / ')} to restore the default (on) unless the opt-out is intentional`,
    anonymizableEvidence: { disabledFlags: disabled },
  };
}

// ── Check 10: workflow-file presence for enabled features ─────────────────

/** Feature → the workflow files its init template scaffolds, keyed by an "enabled" artifact. */
const FEATURE_WORKFLOWS: Array<{ feature: string; enabledBy: string; workflow: string }> = [
  {
    feature: 'attestation',
    enabledBy: '.ai-sdlc/trusted-reviewers.yaml',
    workflow: '.github/workflows/verify-attestation.yml',
  },
  {
    feature: 'dor',
    enabledBy: '.ai-sdlc/dor-config.yaml',
    workflow: '.github/workflows/dor-ingress.yml',
  },
  {
    feature: 'gate',
    enabledBy: '.ai-sdlc/agent-role.yaml',
    workflow: '.github/workflows/ai-sdlc-gate.yml',
  },
];

export function checkFeatureWorkflows(ctx: DoctorRunContext): DoctorCheckResult {
  const id = 'feature-workflows';
  const missing = FEATURE_WORKFLOWS.filter(
    (f) =>
      ctx.adapters.exists(join(ctx.projectDir, f.enabledBy)) &&
      !ctx.adapters.exists(join(ctx.projectDir, f.workflow)),
  );
  if (missing.length === 0) {
    return { id, severity: 'pass', title: 'workflow files exist for every enabled feature' };
  }
  return {
    id,
    severity: 'warn',
    title: `enabled feature(s) missing their workflow file: ${missing.map((m) => `${m.feature} (${m.workflow})`).join(', ')}`,
    remediation: 'Run `ai-sdlc init --add workflows` to scaffold the missing workflow files',
    anonymizableEvidence: { missingFeatures: missing.map((m) => m.feature) },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────

/**
 * The check registry. See the module docstring for the extension
 * contract. Order here is also render order.
 */
export const DOCTOR_CHECKS: DoctorCheck[] = [
  {
    id: 'config-manifest',
    description:
      'Required .ai-sdlc config entries from the pipeline-cli manifest; same wording as the execute preflight (AISDLC-910).',
    run: checkConfigManifest,
    fix: fixConfigManifest,
  },
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
    id: 'idle-sessions',
    description: 'A session polling empty (noop wakeups) for over 30 minutes (AISDLC-765).',
    run: checkIdleSessions,
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
    id: 'ci-queue',
    description:
      'GitHub Actions queue saturation: more than 40 queued runs or the oldest queued run older than 15 minutes (AISDLC-799).',
    run: checkCiQueue,
  },
  {
    id: 'hierarchy-launch-env',
    description:
      'Running hierarchy sessions whose tmux start command lacks the AI_SDLC_HIERARCHY_SESSION/ROLE launch env the lease-push hook binds executors by (AISDLC-791).',
    run: checkHierarchyLaunchEnv,
  },
  {
    id: 'stale-repo-build',
    description:
      "The repo's own pipeline-cli build is missing or older than its sources, so dispatch would run old code (AISDLC-988).",
    run: checkStaleRepoBuild,
  },
  {
    id: 'lease-push-preflight',
    description:
      "With --task <id>: whether the lease-push hook would allow the task worktree's push, and each unmet condition with its fix (AISDLC-798).",
    run: checkLeasePushPreflight,
  },
  {
    id: 'dispatch-board',
    description:
      'Dispatch board invariants: one claim per worker, a fresh heartbeat on every inflight claim, no wave on resume manifests, no stale iterate-needed verdict without a released claim (AISDLC-800).',
    run: checkDispatchBoard,
  },
  {
    id: 'parent-checkout-state',
    description:
      'Orchestrator parent checkout on main whose index or working tree differs from HEAD, with the path count (AISDLC-708).',
    run: checkParentCheckoutState,
  },
  {
    id: 'untracked-review-ledgers',
    description:
      'Untracked .ai-sdlc/reviews/*.jsonl ledgers left in the main checkout by a writer that ran from the parent (AISDLC-793).',
    run: checkUntrackedReviewLedgers,
    fix: fixUntrackedReviewLedgers,
  },
  {
    id: 'backlog-drift-warnings',
    description:
      'Backlog drift warning count against the 150 threshold, with report size (AISDLC-797).',
    run: checkBacklogDriftWarnings,
  },
  {
    id: 'agent-role-config',
    description:
      '.ai-sdlc/agent-role.yaml is present and valid against agent-role.schema.json (AISDLC-582).',
    run: checkAgentRoleConfig,
  },
  {
    id: 'dor-config',
    description:
      '.ai-sdlc/dor-config.yaml is valid against dor-config.v1.schema.json when DoR is enabled (AISDLC-582).',
    run: checkDorConfig,
  },
  {
    id: 'trusted-reviewers',
    description:
      'trusted-reviewers.yaml is schema-valid, lists a key, and includes the operator signing key (AISDLC-582).',
    run: checkTrustedReviewers,
  },
  {
    id: 'husky-pre-push-gate',
    description:
      'The pre-push hook runs the attestation sign snippet when attestation is enabled (AISDLC-582).',
    run: checkHuskyPrePushGate,
    fix: fixHuskyPrePushGate,
  },
  {
    id: 'feature-flags',
    description:
      'Default-on feature flags (deps composition, autonomous orchestrator) are not opted out (AISDLC-582).',
    run: checkFeatureFlags,
  },
  {
    id: 'feature-workflows',
    description: 'Workflow files exist for every enabled feature (AISDLC-582).',
    run: checkFeatureWorkflows,
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

/** Review policy page (AISDLC-746, DEC-0065); named by `ai-sdlc init` and `ai-sdlc doctor`. */
export const REVIEW_POLICY_DOC = 'docs/operations/review-policy.md';
export const REVIEW_POLICY_INIT_LINE = `Review policy (attestation-based review): ${REVIEW_POLICY_DOC}`;

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
  lines.push(`Review policy: ${REVIEW_POLICY_DOC}`);

  return lines;
}
