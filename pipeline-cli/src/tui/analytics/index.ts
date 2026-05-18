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

// ── RFC-0025 Framework Quality Monitoring — Phase 1 substrate ─────────
// Salvaged from closed PR #481 (AISDLC-270). Misaligned implementations
// are marked with TODO stubs; later Refit phases (AISDLC-303..307) will
// reshape each accordingly.

export {
  classifyFailure,
  computeSeverity,
  validateVendorNamespace,
  ClassificationError,
  BUILTIN_FRAMEWORK_SUBCLASSES,
  type FailureClass,
  type FailureSignal,
  type FrameworkSubclass,
  type ClassificationResult,
  type FrameworkBugCaptureRecord,
  type SeverityAxes,
  type SeverityScore,
  type CompositeSeverity,
  type ClassificationContext,
} from './quality-classifier.js';

export {
  appendFrameworkCapture,
  routeFrameworkBug,
  resolveCodeownersAssignee,
  isQualityMonitoringEnabled,
  type AppendCaptureOpts,
  type RouteOpts,
  type RouteResult,
} from './quality-router.js';

export {
  computeQualityMetrics,
  formatMttr,
  formatCoverageRate,
  type QualityMetrics,
  type MttrEntry,
  type RecurrenceEntry,
  type ComputeQualityMetricsOpts,
} from './quality-metrics.js';

export {
  shouldSampleDeterminism,
  recordDeterminismBaseline,
  readDeterminismBaseline,
  checkDeterminismViolation,
  DETERMINISM_SAMPLE_RATE,
  DETERMINISM_DIR,
  BASELINE_MAX_AGE_MS,
  type DeterminismBaseline,
  type DeterminismCheckResult,
} from './determinism-detector.js';
