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
 *  - `flooding` block (RFC-0030 OQ-13.5 v0.3 re-walkthrough refinement,
 *    AISDLC-433) replaces the legacy `sourceBaselineDriftMultiplier` knob
 *    with a z-score detector on per-source rolling 7d baseline + quarantine.
 *    The legacy `flooding.detection.sourceBaselineDriftMultiplier` field at
 *    the LOADER level emits a `signal-ingestion-config-deprecated-field`
 *    Decision; the loader translates it to the closest z-score equivalent
 *    for one release window then hard-errors after the soak.
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
 * Language-detection configuration (RFC-0030 OQ-13.2 re-walkthrough v0.3).
 *
 * v0.3 adds explicit `franc` library specification + behaviour controls.
 * The previous v0.2 implementation used a script-block heuristic that
 * conflated "non-Latin script" with "non-English", causing false drops on
 * legitimate English payloads containing CJK identifiers (e.g. office names)
 * and false accepts on legitimate French / Spanish / German payloads
 * (Latin script but not English). `franc` is deterministic, MIT-licensed,
 * JS-native, runs in <10ms per signal on text >50 chars at 95%+ accuracy.
 */
export interface LanguageDetectionConfig {
  /**
   * Detection library identifier. Currently always `'franc'` — the field
   * exists as a forward-compat hook for swapping the detector (e.g. LLM-based
   * detection in v2). Configuring `'none'` disables the gate entirely,
   * useful for testing or for adopters that pre-filter signals upstream.
   */
  library: 'franc' | 'none';
  /**
   * Minimum character count below which `franc` returns 'und' (undetermined).
   * Below this length, signals are accepted without language gating to avoid
   * dropping legitimate short payloads (e.g. "Bug: crash on save" — 18 chars).
   * Default 50 — the practical lower bound for franc accuracy.
   */
  minDetectionLength: number;
  /**
   * Behaviour when franc returns 'und' (text too short OR no script matched).
   * `'accept'` (default) is conservative — pass through to the rest of the
   * pipeline since short payloads + ambiguous scripts have low false-positive
   * risk. `'drop'` is strict — drop and log as `signal-language-unsupported`.
   */
  onUndetermined: 'accept' | 'drop';
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

/**
 * RFC-0030 OQ-13.4 v0.3 re-walkthrough — manual-entry anti-gaming hardening.
 *
 * Layered on top of the shipped audit-trail pattern (RFC-0022 OQ-2: forced
 * `attestedBy` + auto-filled `attestedAt`):
 *
 *  - `dailyCapPerOperator`: per-operator UTC-day rate limit on manual entries
 *    (default 10/day). Above cap → `Decision: manual-signal-rate-limit-exceeded`.
 *  - `evidenceUrlOptional`: when `true`, manual signals MAY carry an
 *    `evidenceUrl` field (call recording URL, ticket URL, transcript link).
 *    The field is preserved through the pipeline + visible in audit export.
 *  - `qualityMetric`: rolling manual/total share metric. When the share
 *    exceeds `shareWarningThreshold` over `windowDays` → `Decision:
 *    manual-signal-share-elevated` (warning, not block — surfaces
 *    architectural anti-pattern).
 */
export interface ManualEntryQualityMetricConfig {
  enabled: boolean;
  windowDays: number;
  shareWarningThreshold: number;
}

export interface ManualEntryConfig {
  /** Per-operator UTC-day cap. Default 10. Set to `0` to disable. */
  dailyCapPerOperator: number;
  /** Whether the optional `evidenceUrl` field on manual signals is accepted. */
  evidenceUrlOptional: boolean;
  /** Rolling manual-share quality metric configuration. */
  qualityMetric: ManualEntryQualityMetricConfig;
}

/**
 * Flooding-detection block (RFC-0030 OQ-13.5 v0.3 re-walkthrough refinement).
 *
 * REPLACES the legacy fixed-multiplier detector with z-score on a rolling
 * per-source baseline. The trigger condition is
 * `volume_in_window > (baseline_mean + zScoreThreshold × baseline_stddev)
 *   AND uniqueSources_in_window < minUniqueSourcesForSuspicion`.
 *
 * Cold-start handling (per AC #4): when the rolling baseline has fewer than
 * `baselineDays` of history, the detector returns the special `calibrating`
 * status and emits NO `signal-flooding-detected` Decision — Tier 2
 * significance is the sole defense during the calibration window.
 */
export interface FloodingDetectionConfig {
  /** Z-score threshold (σ multiples) above baseline mean. Default 3.0. */
  zScoreThreshold: number;
  /** Detection window in minutes. Default 60. */
  windowMinutes: number;
  /** `uniqueSources < this` is part of the trigger condition. Default 3. */
  minUniqueSourcesForSuspicion: number;
  /** Rolling-baseline window in days. Default 7. */
  baselineDays: number;
}

/**
 * Quarantine sub-block (RFC-0030 §13.5 v0.3). Quarantined signals are NOT
 * fed to D1; quarantine auto-expires after `durationHours`. Operators can
 * unquarantine before expiry via `unquarantineFlooded()`.
 */
export interface FloodingQuarantineConfig {
  /** Master switch. When false, flooding Decisions emit but signals stay live. */
  enabled: boolean;
  /** How long quarantine lasts before auto-expiry. Default 24h. */
  durationHours: number;
}

/** Combined flooding config (detection + quarantine). */
export interface FloodingConfig {
  detection: FloodingDetectionConfig;
  quarantine: FloodingQuarantineConfig;
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
   * Per-org list of accepted BCP-47 (or ISO 639-1 / 639-3) language tags.
   * Default: `['en']`.
   *
   * Signals whose detected language is NOT in this list are dropped and logged
   * as `Decision: signal-language-unsupported` (RFC-0030 OQ-13.2 v0.3
   * resolution). Multi-language opt-in (e.g. `['en', 'fr', 'es']`) accepts
   * signals in any listed language; adopters take on documented BM25 quality
   * degradation (~15-30% precision drop without per-language stopwords /
   * stemming — Robertson & Zaragoza §3.5) in exchange for non-English signal
   * coverage.
   *
   * Tags are normalised to lowercase. The detector returns ISO 639-3
   * three-letter codes (`'eng'`, `'fra'`, `'spa'`); the config matcher
   * accepts the common forms (`'en'`, `'eng'`, `'en-US'`) and maps them
   * to the 639-3 family.
   */
  acceptedLanguages: string[];
  /**
   * Language-detection runtime config (RFC-0030 §11 v0.3). The default
   * specifies `franc` per the OQ-13.2 re-walkthrough resolution.
   */
  languageDetection: LanguageDetectionConfig;
  /**
   * Per-stage residency enforcement configuration per RFC-0030 OQ-13.3
   * re-walkthrough (v0.3). Defaults to all enforcement points ON with
   * `multiPostureBehavior: 'union'`.
   */
  residencyEnforcement: ResidencyEnforcementConfig;
  /**
   * RFC-0030 OQ-13.4 v0.3 — manual-entry anti-gaming config block.
   */
  manualEntry: ManualEntryConfig;
  /**
   * Flooding-detection + quarantine block (RFC-0030 OQ-13.5 v0.3
   * re-walkthrough refinement, AISDLC-433). REPLACES the legacy
   * multiplier-based detector path; the loader emits a
   * `signal-ingestion-config-deprecated-field` Decision when the legacy
   * `flooding.detection.sourceBaselineDriftMultiplier` key is still present
   * AND translates it to the closest z-score equivalent for one release
   * window (then hard-errors).
   */
  flooding: FloodingConfig;
}

/**
 * Decision emitted by the config loader when a deprecated field is still
 * present in `.ai-sdlc/signal-ingestion.yaml`. Translated to the closest
 * z-score equivalent for one release window; after the soak, the loader
 * hard-errors instead of translating (controlled by
 * `AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR=1`).
 *
 * Returned alongside the resolved config from
 * `loadSignalIngestionConfigWithDeprecations()` so the caller can route the
 * Decision to the catalog without coupling the loader to event emission.
 */
export interface SignalIngestionConfigDeprecatedFieldDecision {
  type: 'Decision';
  decision: 'signal-ingestion-config-deprecated-field';
  /** Deprecated field path, e.g. `flooding.detection.sourceBaselineDriftMultiplier`. */
  field: string;
  /** What the operator should switch to. */
  replacement: string;
  /** Legacy value the loader translated from (for audit). */
  legacyValue: unknown;
  /** Z-score equivalent the loader translated to (for audit). */
  translatedTo: unknown;
  message: string;
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
  // RFC-0030 OQ-13.1 v0.3 — env-var-based adapters only. OAuth-required
  // adapters (full Salesforce / HubSpot integrations, Zendesk-with-OAuth)
  // defer to the future credential-management RFC.
  adapters: [
    'signal-source-support-ticket',
    'signal-source-community-thread',
    'signal-source-in-app-feedback',
  ],
  acceptedLanguages: ['en'],
  languageDetection: {
    library: 'franc',
    minDetectionLength: 50,
    onUndetermined: 'accept',
  },
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
  manualEntry: {
    dailyCapPerOperator: 10,
    evidenceUrlOptional: true,
    qualityMetric: {
      enabled: true,
      windowDays: 7,
      shareWarningThreshold: 0.3,
    },
  },
  flooding: {
    detection: {
      zScoreThreshold: 3.0,
      windowMinutes: 60,
      minUniqueSourcesForSuspicion: 3,
      baselineDays: 7,
    },
    quarantine: {
      enabled: true,
      durationHours: 24,
    },
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
    languageDetection: resolveLanguageDetectionConfig(spec['languageDetection']),
    residencyEnforcement: resolveResidencyEnforcement(spec['residencyEnforcement']),
    manualEntry: resolveManualEntry(spec['manualEntry']),
    flooding: resolveFloodingConfig(spec['flooding']),
  };
}

function resolveFloodingConfig(value: unknown): FloodingConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.flooding;
  if (value === undefined || value === null) {
    return { detection: { ...defaults.detection }, quarantine: { ...defaults.quarantine } };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('flooding must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    detection: resolveFloodingDetection(obj['detection']),
    quarantine: resolveFloodingQuarantine(obj['quarantine']),
  };
}

function resolveFloodingDetection(value: unknown): FloodingDetectionConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.detection;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('flooding.detection must be an object');
  }
  const obj = value as Record<string, unknown>;
  // Reject the deprecated `algorithm` field iff it's not `z-score` — only the
  // z-score algorithm is supported post-AISDLC-433. (Operators with the
  // `algorithm: z-score` line from the v0.3 RFC YAML pass through silently.)
  if (
    obj['algorithm'] !== undefined &&
    obj['algorithm'] !== null &&
    obj['algorithm'] !== 'z-score'
  ) {
    throw new SignalIngestionConfigError(
      `flooding.detection.algorithm must be 'z-score' (multiplier-based detector removed in AISDLC-433), got ${JSON.stringify(obj['algorithm'])}`,
    );
  }
  return {
    zScoreThreshold: resolvePositiveNumber(
      obj['zScoreThreshold'],
      defaults.zScoreThreshold,
      'flooding.detection.zScoreThreshold',
    ),
    windowMinutes: resolvePositiveNumber(
      obj['windowMinutes'],
      defaults.windowMinutes,
      'flooding.detection.windowMinutes',
    ),
    minUniqueSourcesForSuspicion: resolvePositiveNumber(
      obj['minUniqueSourcesForSuspicion'],
      defaults.minUniqueSourcesForSuspicion,
      'flooding.detection.minUniqueSourcesForSuspicion',
    ),
    baselineDays: resolvePositiveNumber(
      obj['baselineDays'],
      defaults.baselineDays,
      'flooding.detection.baselineDays',
    ),
  };
}

function resolveFloodingQuarantine(value: unknown): FloodingQuarantineConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.quarantine;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('flooding.quarantine must be an object');
  }
  const obj = value as Record<string, unknown>;
  return {
    enabled: resolveBoolean(obj['enabled'], defaults.enabled),
    durationHours: resolvePositiveNumber(
      obj['durationHours'],
      defaults.durationHours,
      'flooding.quarantine.durationHours',
    ),
  };
}

// ── Deprecation handling (AISDLC-433) ───────────────────────────────────────

/**
 * Result of `loadSignalIngestionConfigWithDeprecations()`. `config` is the
 * fully-resolved config (with any legacy fields already translated to their
 * z-score equivalents). `deprecations` is the list of
 * `signal-ingestion-config-deprecated-field` Decisions the caller MUST route
 * to the RFC-0035 Decision Catalog so the operator sees the deprecation
 * surface and can migrate.
 */
export interface LoadSignalIngestionConfigWithDeprecationsResult {
  config: SignalIngestionConfig;
  deprecations: SignalIngestionConfigDeprecatedFieldDecision[];
}

/**
 * Env-var that flips legacy-field handling from "translate + emit Decision"
 * to "hard-error". The intent: after the one-release-window soak, set this
 * in CI so adopters who haven't migrated fail loudly. AISDLC-433 ships with
 * the var OFF — translation + Decision routing is the cutover behaviour.
 */
const LEGACY_HARD_ERROR_ENV_VAR = 'AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR';

/**
 * Load + resolve config, AND surface every deprecated-field Decision the
 * loader detected. Wraps `loadSignalIngestionConfig()` so callers that want
 * the deprecation audit trail can opt in without changing the existing
 * Pure-load callers (which keep using `loadSignalIngestionConfig`).
 *
 * Behaviour:
 *  - When the legacy `flooding.detection.sourceBaselineDriftMultiplier` key
 *    is present in the YAML AND `LEGACY_HARD_ERROR_ENV_VAR` is unset, the
 *    loader translates it to `zScoreThreshold = legacyMultiplier × 0.6` (an
 *    empirical mapping documented in the operator runbook — a 5× multiplier
 *    over a per-source baseline corresponds approximately to a 3σ spike on
 *    most production datasets) and emits one
 *    `signal-ingestion-config-deprecated-field` Decision.
 *  - When `LEGACY_HARD_ERROR_ENV_VAR=1`, the loader throws
 *    `SignalIngestionConfigError` with a migration message.
 *  - When neither legacy key nor v0.3 z-score key is present, the loader
 *    fills in defaults silently (no deprecation noise).
 */
export function loadSignalIngestionConfigWithDeprecations(
  options: LoadSignalIngestionConfigOptions = {},
): LoadSignalIngestionConfigWithDeprecationsResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  const configPath =
    options.configPath ?? resolve(projectRoot, DEFAULT_SIGNAL_INGESTION_CONFIG_PATH);

  // Read raw YAML to inspect for legacy keys BEFORE resolveConfig() strips them.
  const deprecations: SignalIngestionConfigDeprecatedFieldDecision[] = [];

  if (existsSync(configPath)) {
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

    const legacy = extractLegacyFloodingMultiplier(parsed);
    if (legacy !== undefined) {
      const hardError = isTruthyEnv(process.env[LEGACY_HARD_ERROR_ENV_VAR]);
      if (hardError) {
        throw new SignalIngestionConfigError(
          `flooding.detection.sourceBaselineDriftMultiplier is removed (AISDLC-433); ` +
            `migrate to flooding.detection.zScoreThreshold. ` +
            `See docs/operations/signal-ingestion.md §5 for the migration recipe.`,
        );
      }
      // Translate legacy multiplier → z-score equivalent.
      // Empirical mapping: a 5× multiplier ≈ 3σ on most production datasets
      // (see operator runbook §5 for the derivation). Linear scaling around
      // the default: `zScore = multiplier × 0.6` — preserves operator intent
      // while letting the v0.3 algorithm take over.
      const legacyMultiplier = Number(legacy);
      const translatedZScore = Number.isFinite(legacyMultiplier)
        ? legacyMultiplier * 0.6
        : DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.detection.zScoreThreshold;
      deprecations.push({
        type: 'Decision',
        decision: 'signal-ingestion-config-deprecated-field',
        field: 'flooding.detection.sourceBaselineDriftMultiplier',
        replacement: 'flooding.detection.zScoreThreshold',
        legacyValue: legacy,
        translatedTo: translatedZScore,
        message:
          `flooding.detection.sourceBaselineDriftMultiplier (legacy value ${JSON.stringify(legacy)}) ` +
          `is deprecated and will be removed after the one-release-window soak. ` +
          `Translated to flooding.detection.zScoreThreshold = ${translatedZScore} for this release. ` +
          `Migrate by setting flooding.detection.zScoreThreshold explicitly in ` +
          `.ai-sdlc/signal-ingestion.yaml (recommended default 3.0). ` +
          `See docs/operations/signal-ingestion.md §5 for the full migration recipe.`,
      });

      // Mutate the parsed object so resolveConfig sees a translated value (the
      // operator's intent is preserved through the legacy-to-z-score mapping).
      injectTranslatedZScore(parsed, translatedZScore);
    }

    const config = resolveConfig(parsed, configPath);
    return { config, deprecations };
  }

  // File absent → defaults; no deprecations.
  return { config: { ...DEFAULT_SIGNAL_INGESTION_CONFIG }, deprecations };
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function extractLegacyFloodingMultiplier(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  const spec = (root['spec'] as Record<string, unknown> | undefined) ?? root;
  const flooding = spec['flooding'];
  if (typeof flooding !== 'object' || flooding === null) return undefined;
  const detection = (flooding as Record<string, unknown>)['detection'];
  if (typeof detection !== 'object' || detection === null) return undefined;
  return (detection as Record<string, unknown>)['sourceBaselineDriftMultiplier'];
}

function injectTranslatedZScore(parsed: unknown, zScoreThreshold: number): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const root = parsed as Record<string, unknown>;
  const spec = (root['spec'] as Record<string, unknown> | undefined) ?? root;
  const flooding = spec['flooding'];
  if (typeof flooding !== 'object' || flooding === null) return;
  const detection = (flooding as Record<string, unknown>)['detection'];
  if (typeof detection !== 'object' || detection === null) return;
  const detectionObj = detection as Record<string, unknown>;
  // Only inject when operator did NOT also supply the explicit v0.3 key;
  // an explicit v0.3 value takes precedence over the translated legacy value
  // (operator's stated intent wins over the inferred translation).
  if (detectionObj['zScoreThreshold'] === undefined) {
    detectionObj['zScoreThreshold'] = zScoreThreshold;
  }
  // Strip the legacy key so resolveFloodingDetection() doesn't see it via any
  // future additionalProperties check.
  delete detectionObj['sourceBaselineDriftMultiplier'];
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

function resolveManualEntry(value: unknown): ManualEntryConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.manualEntry;
  if (value === undefined || value === null) {
    return {
      dailyCapPerOperator: defaults.dailyCapPerOperator,
      evidenceUrlOptional: defaults.evidenceUrlOptional,
      qualityMetric: { ...defaults.qualityMetric },
    };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('manualEntry must be an object');
  }
  const obj = value as Record<string, unknown>;
  const qm = obj['qualityMetric'];
  let qualityMetric: ManualEntryQualityMetricConfig;
  if (qm === undefined || qm === null) {
    qualityMetric = { ...defaults.qualityMetric };
  } else if (typeof qm !== 'object' || Array.isArray(qm)) {
    throw new SignalIngestionConfigError('manualEntry.qualityMetric must be an object');
  } else {
    const q = qm as Record<string, unknown>;
    qualityMetric = {
      enabled: resolveBoolean(q['enabled'], defaults.qualityMetric.enabled),
      windowDays: resolvePositiveNumber(
        q['windowDays'],
        defaults.qualityMetric.windowDays,
        'manualEntry.qualityMetric.windowDays',
      ),
      shareWarningThreshold: resolveShareThreshold(
        q['shareWarningThreshold'],
        defaults.qualityMetric.shareWarningThreshold,
      ),
    };
  }
  return {
    dailyCapPerOperator: resolveNonNegativeNumber(
      obj['dailyCapPerOperator'],
      defaults.dailyCapPerOperator,
      'manualEntry.dailyCapPerOperator',
    ),
    evidenceUrlOptional: resolveBoolean(obj['evidenceUrlOptional'], defaults.evidenceUrlOptional),
    qualityMetric,
  };
}

function resolveShareThreshold(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new SignalIngestionConfigError(
      `manualEntry.qualityMetric.shareWarningThreshold must be a number in [0, 1], got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function resolveLanguageDetectionConfig(value: unknown): LanguageDetectionConfig {
  const defaults = DEFAULT_SIGNAL_INGESTION_CONFIG.languageDetection;
  if (value === undefined || value === null) return { ...defaults };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SignalIngestionConfigError('languageDetection must be an object');
  }
  const obj = value as Record<string, unknown>;

  const library = obj['library'];
  if (library !== undefined && library !== 'franc' && library !== 'none') {
    throw new SignalIngestionConfigError(
      `languageDetection.library must be 'franc' or 'none', got ${JSON.stringify(library)}`,
    );
  }

  const onUndetermined = obj['onUndetermined'];
  if (onUndetermined !== undefined && onUndetermined !== 'accept' && onUndetermined !== 'drop') {
    throw new SignalIngestionConfigError(
      `languageDetection.onUndetermined must be 'accept' or 'drop', got ${JSON.stringify(onUndetermined)}`,
    );
  }

  return {
    library: (library as LanguageDetectionConfig['library']) ?? defaults.library,
    minDetectionLength: resolvePositiveNumber(
      obj['minDetectionLength'],
      defaults.minDetectionLength,
      'minDetectionLength',
    ),
    onUndetermined:
      (onUndetermined as LanguageDetectionConfig['onUndetermined']) ?? defaults.onUndetermined,
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
