/**
 * `.ai-sdlc/adopter-authoring.yaml` reader — `import.*` slice only.
 *
 * RFC-0036 §14.1 codifies the per-org schema. Phase 4 (AISDLC-329)
 * consumes the `import:` keys; later phases (5 + 6) consume drift /
 * speckit-bridge / cross-tool keys.
 *
 * Intentional scope: this is a thin reader. Missing files / missing
 * keys fall back to the §14.1 defaults so a freshly bootstrapped repo
 * runs `cli-import-spec` against the v1 contract with zero config.
 *
 * @module import-spec/config
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export type ArtifactGranularity = 'tasks-md-only';
export type DorStrictness = 'strict' | 'warn';
export type DorRejection = 'refuse-emit-clarification';

/**
 * RFC-0036 §14.1 `rfc-scaffold:` slice — adopter RFC location convention
 * (OQ-4 — per-org-configurable). Phase 2 (AISDLC-327) writes the scaffold;
 * Phase 9 (AISDLC-334) consumes the same setting to drive `cli-rfc index`.
 *
 * Field is exposed early so Phase 9 can ship before Phase 2 lands its
 * writer surface — both phases agree on the same key, so there is no
 * cross-phase drift risk.
 */
export interface RfcScaffoldConfig {
  /**
   * Adopter RFC directory, relative to `workDir`. Default `rfcs/` per
   * RFC-0036 §14.1. Multi-repo adopters override to a central path
   * (e.g. `../company-rfcs/`).
   */
  rfcDir: string;
}

/**
 * OQ-2 / RFC §14.1 drift-handling severity policies. Per-severity action.
 *
 * - `auto-sync`: the catalog auto-applies the upstream change to the
 *   imported task body (low-severity tier — typo / cosmetic).
 * - `defer-24h-window`: emit `Decision: spec-drift-detected` with a 24h
 *   operator-override window per RFC-0024 §15.1 default-on-silence; the
 *   in-progress task continues against its dispatched version (high-
 *   severity tier — semantic / scope).
 */
export type DriftSeverityAction = 'auto-sync' | 'defer-24h-window';

export interface ImportConfig {
  /** OQ-1 — tasks.md only (no fallback). */
  artifactGranularity: ArtifactGranularity;
  /**
   * OQ-3 — strict by default. Phase 5 wires the actual DoR run; Phase 4
   * already records the value so the eventual switch is a single line.
   */
  dorStrictness: DorStrictness;
  /** OQ-10 — refuse-and-emit on rejection. Phase 5 honours this. */
  dorRejection: DorRejection;
}

/**
 * Per-org overrides for the spec-drift severity policy (RFC-0036 OQ-2 /
 * Phase 6 / AISDLC-331). The classifier maps a parsed drift between an
 * in-progress task's snapshot and the current upstream `tasks.md` entry
 * to a tier; the tier maps to one of these actions.
 */
export interface DriftHandlingConfig {
  /** Low-severity tier action (typo / cosmetic changes). */
  typoCosmetic: DriftSeverityAction;
  /** High-severity tier action (semantic / scope changes). */
  semanticScope: DriftSeverityAction;
}

export interface AdopterAuthoringConfig {
  import: ImportConfig;
  driftHandling: DriftHandlingConfig;
  rfcScaffold: RfcScaffoldConfig;
}

const DEFAULTS: AdopterAuthoringConfig = {
  import: {
    artifactGranularity: 'tasks-md-only',
    dorStrictness: 'strict',
    dorRejection: 'refuse-emit-clarification',
  },
  driftHandling: {
    typoCosmetic: 'auto-sync',
    semanticScope: 'defer-24h-window',
  },
  rfcScaffold: {
    rfcDir: 'rfcs/',
  },
};

export interface LoadAdopterAuthoringOpts {
  workDir?: string;
  /** Override the resolved file path entirely (tests). */
  filePath?: string;
}

/**
 * Resolve `<workDir>/.ai-sdlc/adopter-authoring.yaml`. Pure function — does
 * not check existence.
 */
export function resolveAdopterAuthoringPath(workDir: string = process.cwd()): string {
  return join(workDir, '.ai-sdlc', 'adopter-authoring.yaml');
}

/**
 * Load + validate the `adopter-authoring.yaml` import slice. Missing file
 * or missing keys fall back to §14.1 defaults. Malformed YAML throws —
 * silent fall-through on a corrupted config would mask operator error.
 */
export function loadAdopterAuthoringConfig(
  opts: LoadAdopterAuthoringOpts = {},
): AdopterAuthoringConfig {
  const path = opts.filePath ?? resolveAdopterAuthoringPath(opts.workDir);
  if (!existsSync(path)) return cloneDefaults();

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[adopter-authoring] failed to parse ${path}: ${msg}`);
  }

  if (raw === null || typeof raw !== 'object') return cloneDefaults();

  const root = raw as Record<string, unknown>;
  // The schema nests under `adopter-authoring:` per RFC §14.1; accept both
  // the nested form and a flat top-level form so tests + simple adopter
  // setups don't need the extra indent.
  const nested = root['adopter-authoring'];
  const source = (nested && typeof nested === 'object' ? nested : root) as Record<string, unknown>;

  const importSlice = source.import;
  const driftSlice = source['drift-handling'];
  const rfcScaffoldSlice = source['rfc-scaffold'];

  const importCfg =
    importSlice && typeof importSlice === 'object'
      ? mergeImport(importSlice as Record<string, unknown>)
      : { ...DEFAULTS.import };
  const driftCfg =
    driftSlice && typeof driftSlice === 'object'
      ? mergeDriftHandling(driftSlice as Record<string, unknown>)
      : { ...DEFAULTS.driftHandling };
  const rfcCfg =
    rfcScaffoldSlice && typeof rfcScaffoldSlice === 'object'
      ? mergeRfcScaffold(rfcScaffoldSlice as Record<string, unknown>)
      : { ...DEFAULTS.rfcScaffold };

  return { import: importCfg, driftHandling: driftCfg, rfcScaffold: rfcCfg };
}

function cloneDefaults(): AdopterAuthoringConfig {
  return {
    import: { ...DEFAULTS.import },
    driftHandling: { ...DEFAULTS.driftHandling },
    rfcScaffold: { ...DEFAULTS.rfcScaffold },
  };
}

function mergeImport(slice: Record<string, unknown>): ImportConfig {
  const artifact = slice.artifactGranularity;
  const strictness = slice.dorStrictness;
  const rejection = slice.dorRejection;
  return {
    artifactGranularity:
      artifact === 'tasks-md-only' ? 'tasks-md-only' : DEFAULTS.import.artifactGranularity,
    dorStrictness:
      strictness === 'strict' || strictness === 'warn'
        ? (strictness as DorStrictness)
        : DEFAULTS.import.dorStrictness,
    dorRejection:
      rejection === 'refuse-emit-clarification'
        ? 'refuse-emit-clarification'
        : DEFAULTS.import.dorRejection,
  };
}

function mergeDriftHandling(slice: Record<string, unknown>): DriftHandlingConfig {
  // RFC §14.1 nests these under `severityThresholds:` — accept that nested
  // form AND a flat form so simple adopter setups don't need the extra
  // indent (mirrors the import: convention above).
  const thresholds =
    slice.severityThresholds && typeof slice.severityThresholds === 'object'
      ? (slice.severityThresholds as Record<string, unknown>)
      : slice;
  return {
    typoCosmetic: parseDriftAction(thresholds.typoCosmetic, DEFAULTS.driftHandling.typoCosmetic),
    semanticScope: parseDriftAction(thresholds.semanticScope, DEFAULTS.driftHandling.semanticScope),
  };
}

function parseDriftAction(value: unknown, fallback: DriftSeverityAction): DriftSeverityAction {
  return value === 'auto-sync' || value === 'defer-24h-window'
    ? (value as DriftSeverityAction)
    : fallback;
}

function mergeRfcScaffold(slice: Record<string, unknown>): RfcScaffoldConfig {
  const raw = slice.rfcDir;
  const rfcDir =
    typeof raw === 'string' && raw.trim().length > 0 ? raw : DEFAULTS.rfcScaffold.rfcDir;
  return { rfcDir };
}
