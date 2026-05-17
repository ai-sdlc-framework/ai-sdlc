/**
 * Regime → DerivedGates composer (RFC-0022 §9 Phase 2).
 *
 * Reads the CompliancePosture's declared regime list, looks up each regime's
 * DerivedGates values from spec/compliance/regime-mappings.yaml, composes
 * them using "tightest-wins" semantics (RFC-0022 §6), applies adopter
 * regimeOverrides per-regime (OQ-1), and finally applies operator-level
 * derivedGates overrides last.
 *
 * Key design decisions:
 *  - YAML mapping file is read at call time (not module load) so tests can
 *    supply a custom mappings path without patching module state.
 *  - Tightest-wins is axis-specific: ordinal enums max, boolean OR, numeric max.
 *  - UnknownRegime is thrown when a declared regime ID has no entry in the
 *    mapping table (Phase 2 activation of the placeholder from Phase 1 errors.ts).
 *  - Adopter regimeOverrides (OQ-1) let per-regime control values be adjusted
 *    before the operator-override pass, enabling bespoke auditor interpretations
 *    without changing the canonical mapping table.
 *  - Operator derivedGates overrides (validated by the loader) always win last.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CompliancePosture, DerivedGates, PartialDerivedGatesOverrides } from './types.js';
import { BASELINE_DERIVED_GATES } from './types.js';
import { UnknownRegime } from './errors.js';

// ── Mapping types ─────────────────────────────────────────────────────────

/**
 * Shape of one entry in spec/compliance/regime-mappings.yaml.
 * Each regime key maps to a full DerivedGates object.
 */
interface RegimeMappingEntry {
  databaseBranchPool: 'shared-with-rls' | 'per-shard';
  secretScanStrictness: 'minimal' | 'standard' | 'strict';
  attestationRequired: boolean;
  auditRetentionDays: number;
  reviewerAuthorityModel: 'open' | 'allowlist' | 'allowlist+role';
}

/**
 * Top-level shape of regime-mappings.yaml.
 */
interface RegimeMappingsFile {
  regimes: Record<string, RegimeMappingEntry>;
}

/**
 * Partial per-regime override supplied by the adopter via
 * `compliance.yaml regimeOverrides.<regimeId>`.
 *
 * Per OQ-1: each overridden control requires a sibling `_notes` entry
 * for audit traceability. Keys are DerivedGates field names (or
 * regime-specific control names that map to DerivedGates fields).
 */
type RegimeOverrideEntry = Partial<Omit<DerivedGates, never>> & {
  _notes?: Record<string, string>;
};

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Path to the canonical regime-mappings.yaml, relative to the package root.
 * The composer resolves this against the nearest ancestor directory containing
 * the file (walking up from the orchestrator package).
 *
 * Tests may override via `ComposerOptions.mappingsPath`.
 */
const DEFAULT_MAPPINGS_PATH = 'spec/compliance/regime-mappings.yaml';

// ── Ordinal helpers ───────────────────────────────────────────────────────

const SECRET_SCAN_ORDINAL: Record<DerivedGates['secretScanStrictness'], number> = {
  minimal: 0,
  standard: 1,
  strict: 2,
};

const REVIEWER_AUTHORITY_ORDINAL: Record<DerivedGates['reviewerAuthorityModel'], number> = {
  open: 0,
  allowlist: 1,
  'allowlist+role': 2,
};

// ── Options ───────────────────────────────────────────────────────────────

/**
 * Options for `composePostureDerivedGates`.
 */
export interface ComposerOptions {
  /**
   * Absolute path to the regime-mappings.yaml file.
   * Defaults to resolving `spec/compliance/regime-mappings.yaml` from the
   * repository root (detected by walking up from __dirname).
   *
   * Override in tests to supply fixture mapping files.
   */
  mappingsPath?: string;

  /**
   * Root directory for finding the default mappings file.
   * Defaults to walking up from the module file location.
   */
  repoRoot?: string;
}

// ── Mapping loader ────────────────────────────────────────────────────────

/**
 * Load and parse the regime-mappings.yaml file.
 */
function loadMappingsFile(mappingsPath: string): RegimeMappingsFile {
  if (!existsSync(mappingsPath)) {
    throw new Error(
      `Regime mappings file not found at '${mappingsPath}'. ` +
        `Expected spec/compliance/regime-mappings.yaml in the repository root.`,
    );
  }
  const content = readFileSync(mappingsPath, 'utf-8');
  const parsed = parseYaml(content) as RegimeMappingsFile;
  if (!parsed?.regimes || typeof parsed.regimes !== 'object') {
    throw new Error(
      `Invalid regime-mappings.yaml: expected a top-level 'regimes' map at '${mappingsPath}'.`,
    );
  }
  return parsed;
}

// ── Tightest-wins logic ───────────────────────────────────────────────────

/**
 * Merge a single regime's DerivedGates into the accumulator using
 * "tightest-wins" semantics per axis (RFC-0022 §6).
 */
function mergeRegimeGates(accumulator: DerivedGates, incoming: RegimeMappingEntry): DerivedGates {
  // databaseBranchPool: per-shard beats shared-with-rls
  const databaseBranchPool: DerivedGates['databaseBranchPool'] =
    accumulator.databaseBranchPool === 'per-shard' || incoming.databaseBranchPool === 'per-shard'
      ? 'per-shard'
      : 'shared-with-rls';

  // secretScanStrictness: ordinal max
  const incomingOrdinal = SECRET_SCAN_ORDINAL[incoming.secretScanStrictness];
  const accOrdinal = SECRET_SCAN_ORDINAL[accumulator.secretScanStrictness];
  const secretScanStrictness: DerivedGates['secretScanStrictness'] =
    incomingOrdinal > accOrdinal ? incoming.secretScanStrictness : accumulator.secretScanStrictness;

  // attestationRequired: boolean OR
  const attestationRequired = accumulator.attestationRequired || incoming.attestationRequired;

  // auditRetentionDays: numeric max
  const auditRetentionDays = Math.max(accumulator.auditRetentionDays, incoming.auditRetentionDays);

  // reviewerAuthorityModel: ordinal max
  const incomingReviewerOrdinal = REVIEWER_AUTHORITY_ORDINAL[incoming.reviewerAuthorityModel];
  const accReviewerOrdinal = REVIEWER_AUTHORITY_ORDINAL[accumulator.reviewerAuthorityModel];
  const reviewerAuthorityModel: DerivedGates['reviewerAuthorityModel'] =
    incomingReviewerOrdinal > accReviewerOrdinal
      ? incoming.reviewerAuthorityModel
      : accumulator.reviewerAuthorityModel;

  return {
    databaseBranchPool,
    secretScanStrictness,
    attestationRequired,
    auditRetentionDays,
    reviewerAuthorityModel,
  };
}

// ── Adopter regimeOverrides application ──────────────────────────────────

/**
 * Apply adopter-supplied per-regime overrides to a regime's base DerivedGates.
 *
 * Per OQ-1: adopters may supply `compliance.yaml regimeOverrides.<regimeId>`
 * to adjust per-regime control values before the tightest-wins composition
 * pass. This lets adopters document bespoke auditor interpretations
 * (e.g., "our HIPAA auditor accepts shared-with-rls with X controls evidence").
 *
 * The override entry uses the same field names as DerivedGates; `_notes` is
 * carried for audit traceability but not validated here (the loader handles
 * that for operator-level overrides; adopter regimeOverrides are advisory).
 */
function applyRegimeOverrides(
  base: RegimeMappingEntry,
  override: RegimeOverrideEntry,
): RegimeMappingEntry {
  return {
    databaseBranchPool: override.databaseBranchPool ?? base.databaseBranchPool,
    secretScanStrictness: override.secretScanStrictness ?? base.secretScanStrictness,
    attestationRequired: override.attestationRequired ?? base.attestationRequired,
    auditRetentionDays: override.auditRetentionDays ?? base.auditRetentionDays,
    reviewerAuthorityModel: override.reviewerAuthorityModel ?? base.reviewerAuthorityModel,
  };
}

// ── Operator override application ────────────────────────────────────────

/**
 * Apply operator-level derivedGates overrides as the final pass.
 *
 * Per RFC-0022 §6: operator overrides always win. The loader already validated
 * that each overridden field has a non-empty `_notes` entry; here we just
 * apply the values.
 */
function applyOperatorOverrides(
  composed: DerivedGates,
  overrides: PartialDerivedGatesOverrides,
): DerivedGates {
  return {
    databaseBranchPool: overrides.databaseBranchPool ?? composed.databaseBranchPool,
    secretScanStrictness: overrides.secretScanStrictness ?? composed.secretScanStrictness,
    attestationRequired: overrides.attestationRequired ?? composed.attestationRequired,
    auditRetentionDays: overrides.auditRetentionDays ?? composed.auditRetentionDays,
    reviewerAuthorityModel: overrides.reviewerAuthorityModel ?? composed.reviewerAuthorityModel,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * The result of composing a CompliancePosture's regimes into DerivedGates.
 */
export interface CompositionResult {
  /**
   * The composed DerivedGates after regime composition + overrides.
   */
  derivedGates: DerivedGates;

  /**
   * List of regime IDs that were composed.
   * Empty means baseline was used (no regimes declared).
   */
  composedRegimes: string[];

  /**
   * Regime IDs that had adopter regimeOverrides applied.
   */
  regimesWithAdopterOverrides: string[];

  /**
   * Gate fields that were overridden by the operator-level derivedGates.
   */
  operatorOverriddenFields: string[];
}

/**
 * Compose a loaded CompliancePosture into a concrete DerivedGates value.
 *
 * Algorithm (RFC-0022 §6):
 *  1. Start from BASELINE_DERIVED_GATES.
 *  2. For each declared regime, look up its entry in regime-mappings.yaml.
 *     Throw UnknownRegime if not found.
 *  3. Apply adopter regimeOverrides (per-regime) before composition (OQ-1).
 *  4. Merge each regime's gates into the accumulator via tightest-wins.
 *  5. Apply operator derivedGates overrides last — they always win.
 *
 * @param posture - A single CompliancePosture (element from the loader's list).
 * @param options - Optional override for the mappings file path.
 * @returns CompositionResult with the resolved DerivedGates.
 * @throws UnknownRegime if any declared regime ID is not in the mapping table.
 */
export function composePostureDerivedGates(
  posture: CompliancePosture,
  options: ComposerOptions = {},
): CompositionResult {
  // Resolve mappings file path
  let mappingsPath: string;
  if (options.mappingsPath) {
    mappingsPath = options.mappingsPath;
  } else {
    const repoRoot = options.repoRoot ?? findRepoRoot();
    mappingsPath = resolve(repoRoot, DEFAULT_MAPPINGS_PATH);
  }

  const mappingsFile = loadMappingsFile(mappingsPath);
  const regimes = posture.spec.regimes;

  // Baseline: no regimes declared → return baseline
  if (regimes.length === 0) {
    return {
      derivedGates: { ...BASELINE_DERIVED_GATES },
      composedRegimes: [],
      regimesWithAdopterOverrides: [],
      operatorOverriddenFields: [],
    };
  }

  // Extract adopter regimeOverrides if present (OQ-1)
  // The CompliancePosture spec does not currently have a `regimeOverrides` field
  // at the TypeScript type level (it's an OQ-1 addition); we read it via type
  // assertion since the loader passes through unknown fields from YAML.
  const regimeOverrides = ((posture.spec as Record<string, unknown>)['regimeOverrides'] ??
    {}) as Record<string, RegimeOverrideEntry>;

  let accumulator: DerivedGates = { ...BASELINE_DERIVED_GATES };
  const composedRegimes: string[] = [];
  const regimesWithAdopterOverrides: string[] = [];

  for (const regime of regimes) {
    const regimeId = regime.id;
    const mappingEntry = mappingsFile.regimes[regimeId];

    if (!mappingEntry) {
      throw new UnknownRegime(regimeId);
    }

    // Apply adopter per-regime override before tightest-wins composition (OQ-1)
    let effectiveEntry = mappingEntry;
    if (regimeOverrides[regimeId]) {
      effectiveEntry = applyRegimeOverrides(mappingEntry, regimeOverrides[regimeId]);
      regimesWithAdopterOverrides.push(regimeId);
    }

    accumulator = mergeRegimeGates(accumulator, effectiveEntry);
    composedRegimes.push(regimeId);
  }

  // Apply operator-level derivedGates overrides last (always win)
  const operatorOverrides = posture.spec.derivedGates;
  let finalGates = accumulator;
  const operatorOverriddenFields: string[] = [];

  if (operatorOverrides) {
    const overrideKeys: Array<keyof DerivedGates> = [
      'databaseBranchPool',
      'secretScanStrictness',
      'attestationRequired',
      'auditRetentionDays',
      'reviewerAuthorityModel',
    ];
    for (const key of overrideKeys) {
      if (key in operatorOverrides && operatorOverrides[key] !== undefined) {
        operatorOverriddenFields.push(key);
      }
    }
    finalGates = applyOperatorOverrides(accumulator, operatorOverrides);
  }

  return {
    derivedGates: finalGates,
    composedRegimes,
    regimesWithAdopterOverrides,
    operatorOverriddenFields,
  };
}

// ── Repo root detection ───────────────────────────────────────────────────

/**
 * Walk up from the current file's directory to find the repository root.
 * Detected by the presence of spec/compliance/regime-mappings.yaml or package.json
 * with a workspace marker.
 *
 * Falls back to `process.cwd()` if the walk exhausts without finding the root.
 */
function findRepoRoot(): string {
  // Walk up from the orchestrator package directory
  try {
    return findMappingsFileDir(new URL('.', import.meta.url).pathname);
  } catch {
    // Fallback: walk up from cwd
    return findMappingsFileDir(process.cwd());
  }
}

/**
 * Walk up from baseDir to find a directory containing
 * `spec/compliance/regime-mappings.yaml`.
 */
function findMappingsFileDir(baseDir: string): string {
  let dir = baseDir;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, DEFAULT_MAPPINGS_PATH);
    if (existsSync(candidate)) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Return current directory as last resort; loadMappingsFile will give a clear error
  return process.cwd();
}
