export {
  type AdapterCredentialInvalidDecision,
  type AdapterCredentialNotConfiguredDecision,
  type AdapterCredentialRejectedDecision,
  type AdapterRequiresCredentialMgmtRfcDecision,
  type CustomerTier,
  type ManualSignalIncompleteDecision,
  type ManualSignalRateLimitExceededDecision,
  type ManualSignalShareElevatedDecision,
  type RawSignal,
  type SignalFetchResult,
  type SignalResidencyViolationDecision,
  type SignalSourceAdapter,
  type SignalSourceName,
  type SignalTier,
} from './types.js';

export {
  AdapterCredentialInvalid,
  AdapterCredentialNotConfigured,
  AdapterCredentialRejected,
  AdapterRequiresCredentialMgmtRfc,
  ManualSignalIncomplete,
  ManualSignalRateLimitExceeded,
  SignalSourceUnavailable,
  UnknownSignalSource,
} from './errors.js';

export {
  SignalSourceRegistry,
  fetchSignalsFromAvailableAdapters,
  getSignalSourceAdapter,
} from './registry.js';

export {
  SupportTicketSignalSourceAdapter,
  DEFAULT_SUPPORT_TICKET_ENV_VAR,
  type SupportTicketAdapterOptions,
} from './adapters/support-ticket.js';
export {
  CommunityThreadSignalSourceAdapter,
  DEFAULT_COMMUNITY_THREAD_ENV_VAR,
  type CommunityThreadAdapterOptions,
} from './adapters/community-thread.js';
export {
  InAppFeedbackSignalSourceAdapter,
  DEFAULT_IN_APP_FEEDBACK_ENV_VAR,
  type InAppFeedbackAdapterOptions,
} from './adapters/in-app-feedback.js';
export {
  ManualSignalSourceAdapter,
  DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR,
  utcDateKey,
  type ManualSignalInput,
  type ManualSignalSourceAdapterOptions,
} from './adapters/manual.js';

// RFC-0030 OQ-13.4 v0.3 — manual-share quality metric
export {
  computeManualShareMetric,
  defaultIsManualSignal,
  DEFAULT_MANUAL_SHARE_MIN_POPULATION,
  DEFAULT_MANUAL_SHARE_WARNING_THRESHOLD,
  DEFAULT_MANUAL_SHARE_WINDOW_DAYS,
  type ManualShareMetricOptions,
  type ManualShareMetricResult,
} from './manual-share-metric.js';

// RFC-0030 Phase 2 — classification
export {
  classifySignals,
  computeRecencyDecay,
  computeSignalWeight,
  resolveCustomerTier,
  resolveIcpResonance,
  tokenize,
  type ClassificationResult,
  type ClassifiedSignal,
  type ClassifySignalsOptions,
  type CustomerTierRegistry,
  type ICPResonance,
  type SignalLanguageUnsupportedDecision,
} from './classifier.js';

export {
  loadSignalIngestionConfig,
  loadSignalIngestionConfigWithDeprecations,
  DEFAULT_SIGNAL_INGESTION_CONFIG,
  DEFAULT_SIGNAL_INGESTION_CONFIG_PATH,
  SignalIngestionConfigError,
  type ClusteringConfig,
  type D1CompositionWeights,
  type FloodingConfig,
  type FloodingDetectionConfig,
  type FloodingQuarantineConfig,
  type IcpResonanceWeights,
  type LanguageDetectionConfig,
  type LoadSignalIngestionConfigOptions,
  type LoadSignalIngestionConfigWithDeprecationsResult,
  type ManualEntryConfig,
  type ManualEntryQualityMetricConfig,
  type ResidencyEnforcementConfig,
  type SaResonanceThresholds,
  type SignalIngestionConfig,
  type SignalIngestionConfigDeprecatedFieldDecision,
  type Tier2SignificanceThreshold,
  type TierMultipliers,
} from './config.js';

// RFC-0030 §11 / AISDLC-348 Phase 6 — governance event logging
export {
  computeConfigDiff,
  eventsFilePath as signalIngestionEventsFilePath,
  loadSignalIngestionConfigWithGovernance,
  writeSignalIngestionConfigChangedEvent,
  type LoadConfigWithGovernanceOptions,
  type LoadConfigWithGovernanceResult,
  type SignalIngestionConfigChange,
  type SignalIngestionConfigChangedEvent,
  type SignalIngestionConfigDiff,
  type WriteConfigChangeEventOpts,
} from './governance-events.js';

// RFC-0030 Phase 3 — clustering
export {
  clusterSignals,
  clusterSignalsWithResidency,
  computeClusterId,
  cosineSimilarity,
  type ClusterSignalsOptions,
  type ClusterSignalsWithResidencyOptions,
  type ClusteredSignalInput,
  type ClusteringAlgorithmUsed,
  type ClusteringResult,
  type ClusteringResultWithResidency,
  type DemandCluster,
} from './clustering.js';

// RFC-0030 OQ-13.3 re-walkthrough — per-stage residency enforcement +
// multi-posture composition (AISDLC-432).
export {
  clusterRequiresSegregation,
  composePostures,
  groupCostByRegion,
  makeStoredSignalRecord,
  partitionSignalsByRegion,
  readSignalRecordWithAudit,
  type CostAttributionRow,
  type CostByRegionBreakdown,
  type CrossRegionReadAuditEntry,
  type PostureRegimeInput,
  type StoredSignalRecord,
} from './residency.js';

// RFC-0030 Phase 4 — significance threshold + SA resonance filter + flooding + residency
export {
  assessClusterSignificance,
  assessTier2Significance,
  checkSignalResidency,
  classifySaResonance,
  computeBaselineStat,
  computeZScore,
  DEFAULT_FLOODING_DETECTION_CONFIG,
  detectFlooding,
  filterSignalsByResidency,
  InMemoryQuarantineStore,
  isSignalQuarantined,
  SA_WEIGHT_MULTIPLIERS,
  unquarantineFlooded,
  type AssessClusterSignificanceOptions,
  type AssessClusterSignificanceResult,
  type BaselineStat,
  type DetectFloodingOptions,
  type FloodingDetectionResult,
  type FloodingDetectionStatus,
  type FloodingSourceFlag,
  type PerSourceBaseline,
  type QuarantineEntry,
  type QuarantineStore,
  type ResidencyRegimeDeclaration,
  type SaResonanceBucket,
  type SignalFloodingDetectedDecision,
  type SignalFloodingFalsePositiveDecision,
  type SignalLowSaForReviewDecision,
  type SignalOutOfScopeDecision,
  type SignalResidencyCheck,
  type SignificanceAssessedCluster,
  type Tier2SignificanceReasons,
  type Tier2SignificanceState,
  type UnquarantineFloodedOptions,
} from './significance.js';

// RFC-0030 Phase 5 — D1 formula reformulation + RFC-0008 PPA integration
export {
  aggregateD1FromClusters,
  composeD1Inputs,
  computeClusterD1,
  enrichDemandSignalFromClusters,
  type AggregatedD1Result,
  type ClusterD1Score,
  type ClusterMatcher,
  type ComposeD1InputsArgs,
  type ComposedD1Result,
  type ComputeClusterD1Options,
  type EnrichDemandSignalArgs,
  type EnrichDemandSignalResult,
} from './d1.js';

import { CommunityThreadSignalSourceAdapter } from './adapters/community-thread.js';
import { InAppFeedbackSignalSourceAdapter } from './adapters/in-app-feedback.js';
import { ManualSignalSourceAdapter } from './adapters/manual.js';
import { SupportTicketSignalSourceAdapter } from './adapters/support-ticket.js';
import { SignalSourceRegistry } from './registry.js';

/**
 * Construct the default signal-source registry with the RFC-0030 OQ-13.1
 * v0.3 v1 adapter set (env-var-based only):
 *  - `signal-source-support-ticket` (Zendesk PAT via `SIGNAL_ZENDESK_PAT`)
 *  - `signal-source-community-thread` (Discord / Slack bot token via
 *    `SIGNAL_COMMUNITY_BOT_TOKEN` / custom)
 *  - `signal-source-in-app-feedback` (API key via `SIGNAL_IN_APP_FEEDBACK_API_KEY`)
 *  - `signal-source-manual` (no auth)
 *
 * OAuth-required adapters (full Salesforce / HubSpot / OAuth-scoped Zendesk)
 * are NOT included; they defer to the future credential-management RFC and
 * would be REFUSED at registration by the `requiresOAuth = true` gate.
 *
 * The default constructions DO NOT enable env-var probing (`probeEnvVar:
 * false`) so the in-memory test pattern continues to work. Production
 * deployments should pass `probeEnvVar: true` explicitly per adapter.
 */
export function createDefaultSignalSourceRegistry(): SignalSourceRegistry {
  const registry = new SignalSourceRegistry();
  registry.register(new SupportTicketSignalSourceAdapter());
  registry.register(new CommunityThreadSignalSourceAdapter());
  registry.register(new InAppFeedbackSignalSourceAdapter());
  registry.register(new ManualSignalSourceAdapter());
  return registry;
}
