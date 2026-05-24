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

/** Fully-resolved signal ingestion configuration. */
export interface SignalIngestionConfig {
  enabled: boolean;
  tierMultipliers: TierMultipliers;
  icpResonanceWeights: IcpResonanceWeights;
  recencyHalfLifeDays: number;
  tier2SignificanceThreshold: Tier2SignificanceThreshold;
  saResonanceThresholds: SaResonanceThresholds;
  clustering: ClusteringConfig;
  adapters: string[];
  /**
   * Per-org list of accepted BCP-47 language tags. Default: `['en']`.
   * Non-English signals are dropped when their language is not in this list
   * (RFC-0030 OQ-13.2 resolution).
   */
  acceptedLanguages: string[];
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
  adapters: ['signal-source-support-ticket', 'signal-source-community-thread'],
  acceptedLanguages: ['en'],
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
    adapters: resolveStringArray(spec['adapters'], DEFAULT_SIGNAL_INGESTION_CONFIG.adapters),
    acceptedLanguages: resolveLanguageList(spec['acceptedLanguages']),
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
