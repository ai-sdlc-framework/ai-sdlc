/**
 * Public surface for the operator-throughput analytics module
 * (RFC-0023 §10 / AISDLC-178.6).
 */

export { isTelemetryEnabled, TUI_TELEMETRY_FLAG } from './feature-flag.js';

export { decisionsPath, prDecisionsPath, interactionsPath, operatorDirPath } from './paths.js';

export {
  writeDecision,
  DecisionsTracker,
  NEEDS_CLARIFICATION_STATUS,
  type DecisionRecord,
  type DecisionsTrackerOpts,
  type WriteDecisionOpts,
} from './decisions-writer.js';

export {
  writePrDecision,
  PrDecisionsTracker,
  ATTENTION_REQUIRED_REVIEW_DECISION,
  type PrDecisionAction,
  type PrDecisionRecord,
  type PrDecisionsTrackerOpts,
  type WritePrDecisionOpts,
} from './pr-decisions-writer.js';

export {
  writeInteraction,
  type InteractionKind,
  type InteractionRecord,
  type WriteInteractionOpts,
} from './interactions-writer.js';

export {
  readDecisions,
  type ReadDecisionsOpts,
  type ReadDecisionsResult,
} from './decisions-reader.js';

export {
  readPrDecisions,
  type ReadPrDecisionsOpts,
  type ReadPrDecisionsResult,
} from './pr-decisions-reader.js';

export {
  readReliabilityTrend,
  FRAMEWORK_QUALITY_DIRNAME,
  FRAMEWORK_QUALITY_CAPTURES_FILE,
  type ReadReliabilityTrendOpts,
  type ReliabilityTrend,
} from './quality-reader.js';

export {
  computeOperatorMetrics,
  computePipelineMetrics,
  formatDurationCompact,
  formatReliabilityTrend,
  STALE_CLARIFICATION_THRESHOLD_MS,
  TWENTY_FOUR_HOURS_MS,
  type ComputeOperatorMetricsOpts,
  type ComputePipelineMetricsOpts,
  type OperatorMetrics,
  type PipelineMetrics,
} from './metrics.js';
