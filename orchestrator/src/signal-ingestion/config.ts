/**
 * Signal ingestion configuration loader for RFC-0030 Phase 2.
 *
 * Reads `.ai-sdlc/signal-ingestion.yaml`, validates its shape, and returns a
 * fully-resolved `SignalIngestionConfig` with all defaults applied.
 *
 * Design decisions:
 *  - Missing file → returns the default config (pipeline is disabled by default).
 *  - Invalid YAML or schema mismatch → throws `SignalIngestionConfigError`.
 *  - All numeric fields are validated to be non-negative finite numbers.
 *  - `acceptedLanguages` defaults to `['en']` per RFC-0030 OQ-13.2 resolution.
 *  - Tier multipliers and ICP resonance weights are read from the config; the
 *    defaults match RFC-0030 §11.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Default config path ─────────────────────────────────────────────────────

export const DEFAULT_SIGNAL_INGESTION_CONFIG_PATH = '.ai-sdlc/signal-ingestion.yaml';

// ── Type definitions ────────────────────────────────────────────────────────

/** Tier multipliers keyed by CustomerTier. All values must be non-negative. */
export interface TierMultipliers {
  enterprise: number;
  mid: number;
  smb: number;
  free: number;
  churned: number;
}

/** ICP resonance weights keyed by ICPResonance level. All values must be non-negative. */
export interface IcpResonanceWeights {
  strong: number;
  partial: number;
  weak: number;
}

/** Tier 2 significance threshold parameters. */
export interface Tier2SignificanceThreshold {
  /** Minimum number of signals in the cluster to qualify. */
  minSignalCount: number;
  /** Minimum number of distinct sources in the cluster. */
  minUniqueSources: number;
  /** Minimum number of Tier 1 signals required in the cluster. */
  minTier1SignalCount: number;
  /** Minimum cluster age in days. */
  minClusterAgeDays: number;
}

/** SA resonance threshold configuration for D1 weight bands. */
export interface SaResonanceThresholds {
  /** Clusters at or above this score receive full weight. */
  fullWeight: number;
  /** Clusters at or above this score (but below fullWeight) receive discounted weight. */
  discounted: number;
  /** Clusters at or above this score (but below discounted) are flagged for review. */
  excluded: number;
}

/** Clustering algorithm and parameters. */
export interface ClusteringConfig {
  algorithm: 'bm25' | 'embedding';
  similarityThreshold: number;
}

/**
 * Phase 5 — non-replacement weighting between signal-pipeline-derived demand
 * and human-authored backlog-item demand when both feed D1 (RFC-0030 §10).
 *
 * **Backward compat (AC #4)**: when `enabled: false` at the top level, only
 * `backlogItemWeight` is in effect — `signalPipelineWeight` is irrelevant
 * because no pipeline-derived demand exists. When `enabled: true`, both
 * weights blend the two demand streams; default 50/50 keeps neither stream
 * dominant out of the box.
 *
 * The weights are normalised to sum to 1 inside `composeD1Inputs()` so any
 * positive pair is meaningful (e.g. `{1, 3}` becomes `{0.25, 0.75}`).
 */
export interface D1CompositionWeights {
  /**
   * Weight applied to the signal-pipeline-derived (cluster-aggregate) D1
   * input. Default 0.5 — even blend with backlog-derived demand.
   */
  signalPipelineWeight: number;
  /**
   * Weight applied to the human-authored backlog-item demand input.
   * Default 0.5 — even blend with signal-pipeline demand.
   */
  backlogItemWeight: number;
}

/**
 * Per-stage residency enforcement toggles per RFC-0030 v0.3 OQ-13.3
 * re-walkthrough. Each flag corresponds to an enforcement point in the
 * pipeline:
 *
 *   - `fetchSignals`: adapter-level signal tag check against allowed regions
 *     (already implemented via `checkSignalResidency`).
 *   - `clustering`: partition signals by residencyRegion before similarity
 *     computation; cross-region cluster merge is structurally impossible.
 *   - `storage`: persist `residencyRegion` field on every stored record;
 *     cross-region reads emit elevated audit-log entries.
 *   - `unifiedCostReport`: group cost attribution rows by region so per-region
 *     totals are visible in the unified cost report.
 *
 * `multiPostureBehavior` controls how the pipeline composes multiple regimes
 * declared by the adopter. `'union'` is the v0.3 default — UNION of regime
 * constraints, strictest applies (when an adopter declares HIPAA AND GDPR,
 * a signal must satisfy BOTH regimes' allowed-region constraints).
 *
 * Defaults match RFC-0030 §11 v0.3 (all enforcement points ON; multi-posture
 * = UNION).
 */
export interface ResidencyEnforcementConfig {
  sourceFromCompliancePosture: boolean;
  enforcementPoints: {
    fetchSignals: boolean;
    clustering: boolean;
    storage: boolean;
    unifiedCostReport: boolean;
  };
  multiPostureBehavior: 'union';
}

/** Fully-resolved signal ingestion configuration. */
export interface SignalIngestionConfig {
  enabled: boolean;
  tierMultipliers: TierMultipliers;
  icpResonanceWeights: IcpResonanceWeights;
  recencyHalfLifeDays: number;
  tier2SignificanceThreshold: Tier2SignificanceThreshold;
  saResonanceThresholds: SaResonanceThresholds;
  clustering: ClusteringConfig;
  d1Composition: D1CompositionWeights;
  adapters: string[];
  /**
   * Per-org list of accepted BCP-47 language tags. Default: `['en']`.
   * Non-English signals are dropped when their language is not in this list
   * (RFC-0030 OQ-13.2 resolution).
   */
  acceptedLanguages: string[];
  /**
   * Per-stage residency enforcement configuration per RFC-0030 OQ-13.3
   * re-walkthrough (v0.3). Defaults to all enforcement points ON with
   * `multiPostureBehavior: 'union'`.
   */
  residencyEnforcement: ResidencyEnforcementConfig;
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SIGNAL_INGESTION_CONFIG: SignalIngestionConfig = {
  enabled: false,
  tierMultipliers: {
    enterprise: 3.0,
    mid: 1.5,
    smb: 1.0,
    free: 0.5,
    churned: 2.0,
  },
  icpResonanceWeights: {
    strong: 1.5,
    partial: 1.0,
    weak: 0.5,
  },
  recencyHalfLifeDays: 30,
  tier2SignificanceThreshold: {
    minSignalCount: 5,
    minUniqueSources: 3,
    minTier1SignalCount: 1,
    minClusterAgeDays: 7,
  },
  saResonanceThresholds: {
    fullWeight: 0.7,
    discounted: 0.4,
    excluded: 0.0,
  },
  clustering: {
    algorithm: 'bm25',
    similarityThreshold: 0.6,
  },
  d1Composition: {
    signalPipelineWeight: 0.5,
    backlogItemWeight: 0.5,
  },
  adapters: ['signal-source-support-ticket', 'signal-source-community-thread'],
  acceptedLanguages: ['en'],
  residencyEnforcement: {
    sourceFromCompliancePosture: true,
    enforcementPoints: {
      fetchSignals: true,
      clustering: true,
      storage: true,
      unifiedCostReport: true,
    },
    multiPostureBehavior: 'union',
  },
};

// ── Error ───────────────────────────────────────────────────────────────────

export class SignalIngestionConfigError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SignalIngestionConfigError';
  }
}

// ── Loader ──────────────────────────────────────────────────────────────────

export interface LoadSignalIngestionConfigOptions {
  /** Absolute path to the project root. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Explicit path to the config file. Overrides the default location. */
  configPath?: string;
}

/**
 * Load and resolve the signal ingestion configuration from
 * `.ai-sdlc/signal-ingestion.yaml`.
 *
 * Returns `DEFAULT_SIGNAL_INGESTION_CONFIG` when the file is absent.
 * Throws `SignalIngestionConfigError` on parse or validation failure.
 */
export function loadSignalIngestionConfig(
  options: LoadSignalIngestionConfigOptions = {},
): SignalIngestionConfig {
  const projectRoot = options.projectRoot ?? process.cwd();
  const configPath =
    options.configPath ?? resolve(projectRoot, DEFAULT_SIGNAL_INGESTION_CONFIG_PATH);

  if (!existsSync(configPath)) {
    return { ...DEFAULT_SIGNAL_INGESTION_CONFIG };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    throw new SignalIngestionConfigError(
      `Failed to read signal ingestion config at ${configPath}`,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new SignalIngestionConfigError(
      `Failed to parse signal ingestion YAML at ${configPath}`,
      err,
    );
  }

  return resolveConfig(parsed, configPath);
}

// ── Internal resolver ───────────────────────────────────────────────────────

function resolveConfig(raw: unknown, filePath: string): SignalIngestionConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SignalIngestionConfigError(
      `Signal ingestion config at ${filePath} must be a YAML object`,
    );
  }

  const obj = raw as Record<string, unknown>;

  // Validate top-level apiVersion / kind when present (advisory, not enforced)
  const spec = (obj['spec'] as Record<string, unknown> | undefined) ?? obj;

  return {
    enabled: resolveBoolean(spec['enabled'], DEFAULT_SIGNAL_INGESTION_CONFIG.enabled),
    tierMultipliers: resolveTierMultipliers(spec['tierMultipliers']),
    icpResonanceWeights: resolveIcpResonanceWeights(spec['icpResonanceWeights']),
    recencyHalfLifeDays: resolvePositiveNumber(
      spec['recencyHalfLifeDays'],
      DEFAULT_SIGNAL_INGESTION_CONFIG.recencyHalfLifeDays,
      'recencyHalfLifeDays',
    ),
    tier2SignificanceThreshold: resolveTier2Threshold(spec['tier2SignificanceThreshold']),
    saResonanceThresholds: resolveSaThresholds(spec['saResonanceThresholds']),
    clustering: resolveClusteringConfig(spec['clustering']),
    d1Composition: resolveD1Composition(spec['d1Composition']),
    adapters: resolveStringArray(spec['adapters'], DEFAULT_SIGNAL_INGESTION_CONFIG.adapters),
    acceptedLanguages: resolveLanguageList(spec['acceptedLanguages']),
    residencyEnforcement: resolveResidencyEnforcement(spec['residencyEnforcement']),
  };
}

function resolveBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  throw new SignalIngestionConfigError(`Expected boolean, got ${JSON.stringify(value)}`);
}

function resolvePositiveNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new SignalIngestionConfigError(
      `Field ${field} must be a non-negative finite number, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function resolveNonNegativeNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new SignalIngestionConfigError(
      `Field ${field} must be a non-negative finite number, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function resolveTierMultipliers(value: unknown): TierMultipliers {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.tierMultipliers;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('tierMultipliers must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    enterprise: resolveNonNegativeNumber(obj['enterprise'], defaults.enterprise, 'enterprise'),
    mid: resolveNonNegativeNumber(obj['mid'], defaults.mid, 'mid'),
    smb: resolveNonNegativeNumber(obj['smb'], defaults.smb, 'smb'),
    free: resolveNonNegativeNumber(obj['free'], defaults.free, 'free'),
    churned: resolveNonNegativeNumber(obj['churned'], defaults.churned, 'churned'),
  };
}

function resolveIcpResonanceWeights(value: unknown): IcpResonanceWeights {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.icpResonanceWeights;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('icpResonanceWeights must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    strong: resolveNonNegativeNumber(obj['strong'], defaults.strong, 'strong'),
    partial: resolveNonNegativeNumber(obj['partial'], defaults.partial, 'partial'),
    weak: resolveNonNegativeNumber(obj['weak'], defaults.weak, 'weak'),
  };
}

function resolveTier2Threshold(value: unknown): Tier2SignificanceThreshold {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.tier2SignificanceThreshold;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('tier2SignificanceThreshold must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    minSignalCount: resolvePositiveNumber(
      obj['minSignalCount'],
      defaults.minSignalCount,
      'minSignalCount',
    ),
    minUniqueSources: resolvePositiveNumber(
      obj['minUniqueSources'],
      defaults.minUniqueSources,
      'minUniqueSources',
    ),
    minTier1SignalCount: resolvePositiveNumber(
      obj['minTier1SignalCount'],
      defaults.minTier1SignalCount,
      'minTier1SignalCount',
    ),
    minClusterAgeDays: resolvePositiveNumber(
      obj['minClusterAgeDays'],
      defaults.minClusterAgeDays,
      'minClusterAgeDays',
    ),
  };
}

function resolveSaThresholds(value: unknown): SaResonanceThresholds {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.saResonanceThresholds;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('saResonanceThresholds must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    fullWeight: resolveNonNegativeNumber(obj['fullWeight'], defaults.fullWeight, 'fullWeight'),
    discounted: resolveNonNegativeNumber(obj['discounted'], defaults.discounted, 'discounted'),
    excluded: resolveNonNegativeNumber(obj['excluded'], defaults.excluded, 'excluded'),
  };
}

function resolveD1Composition(value: unknown): D1CompositionWeights {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.d1Composition;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('d1Composition must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    signalPipelineWeight: resolveNonNegativeNumber(
      obj['signalPipelineWeight'],
      defaults.signalPipelineWeight,
      'signalPipelineWeight',
    ),
    backlogItemWeight: resolveNonNegativeNumber(
      obj['backlogItemWeight'],
      defaults.backlogItemWeight,
      'backlogItemWeight',
    ),
  };
}

function resolveClusteringConfig(value: unknown): ClusteringConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.clustering;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('clustering must be an object');
  }
  const obj = value as Record<string, unknown>;
  const algorithm = obj['algorithm'];
  if (algorithm !== undefined && algorithm !== 'bm25' && algorithm !== 'embedding') {
    throw new SignalIngestionConfigError(
      `clustering.algorithm must be 'bm25' or 'embedding', got ${JSON.stringify(algorithm)}`,
    );
  }
  return {
    algorithm: (algorithm as ClusteringConfig['algorithm']) ?? defaults.algorithm,
    similarityThreshold: resolveNonNegativeNumber(
      obj['similarityThreshold'],
      defaults.similarityThreshold,
      'similarityThreshold',
    ),
  };
}

function resolveStringArray(value: unknown, defaultValue: string[]): string[] {
  if (value === undefined || value === null) return [...defaultValue];
  if (!Array.isArray(value)) throw new SignalIngestionConfigError('adapters must be an array');
  if (!value.every((v) => typeof v === 'string')) {
    throw new SignalIngestionConfigError('adapters entries must be strings');
  }
  return value as string[];
}

function resolveResidencyEnforcement(value: unknown): ResidencyEnforcementConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.residencyEnforcement;
  if (value === undefined || value === null) {
    return {
      sourceFromCompliancePosture: defaults.sourceFromCompliancePosture,
      enforcementPoints: { ...defaults.enforcementPoints },
      multiPostureBehavior: defaults.multiPostureBehavior,
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('residencyEnforcement must be an object');
  }
  const obj = value as Record<string, unknown>;
  const points = obj['enforcementPoints'];
  let enforcementPoints = { ...defaults.enforcementPoints };
  if (points !== undefined && points !== null) {
    if (typeof points !== 'object' || Array.isArray(points)) {
      throw new SignalIngestionConfigError(
        'residencyEnforcement.enforcementPoints must be an object',
      );
    }
    const p = points as Record<string, unknown>;
    enforcementPoints = {
      fetchSignals: resolveBoolean(p['fetchSignals'], defaults.enforcementPoints.fetchSignals),
      clustering: resolveBoolean(p['clustering'], defaults.enforcementPoints.clustering),
      storage: resolveBoolean(p['storage'], defaults.enforcementPoints.storage),
      unifiedCostReport: resolveBoolean(
        p['unifiedCostReport'],
        defaults.enforcementPoints.unifiedCostReport,
      ),
    };
  }
  const multi = obj['multiPostureBehavior'];
  if (multi !== undefined && multi !== null && multi !== 'union') {
    throw new SignalIngestionConfigError(
      `residencyEnforcement.multiPostureBehavior must be 'union' (v1 only), got ${JSON.stringify(multi)}`,
    );
  }
  return {
    sourceFromCompliancePosture: resolveBoolean(
      obj['sourceFromCompliancePosture'],
      defaults.sourceFromCompliancePosture,
    ),
    enforcementPoints,
    multiPostureBehavior: 'union',
  };
}

function resolveLanguageList(value: unknown): string[] {
  if (value === undefined || value === null)
    return [...DEFAULT_SIGNAL_INGESTION_CONFIG.acceptedLanguages];
  if (!Array.isArray(value))
    throw new SignalIngestionConfigError('acceptedLanguages must be an array');
  if (!value.every((v) => typeof v === 'string')) {
    throw new SignalIngestionConfigError('acceptedLanguages entries must be strings');
  }
  // Normalize to lowercase BCP-47 language tags
  return (value as string[]).map((lang) => lang.toLowerCase());
}
