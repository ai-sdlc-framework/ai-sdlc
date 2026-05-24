export {
  type AdapterCredentialInvalidDecision,
  type CustomerTier,
  type ManualSignalIncompleteDecision,
  type RawSignal,
  type SignalFetchResult,
  type SignalSourceAdapter,
  type SignalSourceName,
  type SignalTier,
} from './types.js';

export {
  AdapterCredentialInvalid,
  ManualSignalIncomplete,
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
  type SupportTicketAdapterOptions,
} from './adapters/support-ticket.js';
export {
  CommunityThreadSignalSourceAdapter,
  type CommunityThreadAdapterOptions,
} from './adapters/community-thread.js';
export { ManualSignalSourceAdapter, type ManualSignalInput } from './adapters/manual.js';

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
  DEFAULT_SIGNAL_INGESTION_CONFIG,
  DEFAULT_SIGNAL_INGESTION_CONFIG_PATH,
  SignalIngestionConfigError,
  type ClusteringConfig,
  type IcpResonanceWeights,
  type LoadSignalIngestionConfigOptions,
  type SaResonanceThresholds,
  type SignalIngestionConfig,
  type Tier2SignificanceThreshold,
  type TierMultipliers,
} from './config.js';

// RFC-0030 Phase 3 — clustering
export {
  clusterSignals,
  computeClusterId,
  cosineSimilarity,
  type ClusterSignalsOptions,
  type ClusteredSignalInput,
  type ClusteringAlgorithmUsed,
  type ClusteringResult,
  type DemandCluster,
} from './clustering.js';

import { CommunityThreadSignalSourceAdapter } from './adapters/community-thread.js';
import { ManualSignalSourceAdapter } from './adapters/manual.js';
import { SupportTicketSignalSourceAdapter } from './adapters/support-ticket.js';
import { SignalSourceRegistry } from './registry.js';

export function createDefaultSignalSourceRegistry(): SignalSourceRegistry {
  const registry = new SignalSourceRegistry();
  registry.register(new SupportTicketSignalSourceAdapter());
  registry.register(new CommunityThreadSignalSourceAdapter());
  registry.register(new ManualSignalSourceAdapter());
  return registry;
}
