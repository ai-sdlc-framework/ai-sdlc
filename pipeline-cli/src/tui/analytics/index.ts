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

// ── RFC-0025 Framework Quality Monitoring — Phase 1 substrate + Phase 3 ─
// Phase 1: Salvaged from closed PR #481 (AISDLC-270). Misaligned
// implementations are marked with TODO stubs; later Refit phases
// (AISDLC-303..307) will reshape each accordingly.
// Phase 3 (AISDLC-304): multi-window recurrence (OQ-3), first-capture
// MTTR label (OQ-8), v2 MTTD substrate, per-org config loader.

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
  formatRecurrenceEntry,
  type QualityMetrics,
  type MttrEntry,
  type RecurrenceEntry,
  type RecurrenceByWindow,
  type MttdV2Substrate,
  type ComputeQualityMetricsOpts,
} from './quality-metrics.js';

// ── RFC-0025 Quality Monitoring Config — Phase 3 + Phase 6 ──────────
// Per-org configurable recurrence windows + Phase 6 (AISDLC-307)
// upstream-reporting (OQ-5) and vendor-namespace (OQ-10) settings.
// Config file: `.ai-sdlc/quality-monitoring.yaml` (§13.1).

export {
  loadQualityMonitoringConfig,
  parseQualityMonitoringConfigYaml,
  parseDurationDays,
  enforceVendorNamespaceConfig,
  QualityMonitoringConfigError,
  DEFAULT_RECURRENCE_WINDOWS,
  DEFAULT_UPSTREAM_TEMPLATE_PATH,
  DEFAULT_VENDOR_NAMESPACE_ENFORCE,
  DEFAULT_COVERAGE_GAP_AUTO_QUARANTINE,
  DEFAULT_COVERAGE_GAP_FILE_CAPTURE,
  DEFAULT_DETERMINISM_SAMPLE_RATE,
  DEFAULT_DETERMINISM_ALWAYS_ON_REQUIRES,
  DEFAULT_DETERMINISM_ALWAYS_ON_TOP_BLAST_DECILE,
  DEFAULT_OPERATOR_TIME_COST_AFK_MINUTES,
  QUALITY_MONITORING_CONFIG_DEFAULTS,
  type QualityMonitoringConfig,
  type LoadQualityMonitoringConfigOpts,
  type UpstreamReportingConfig,
  type VendorNamespaceConfig,
  type VendorNamespaceEnforce,
  type CoverageGapConfig,
  type DeterminismDetectionConfig,
  type OperatorTimeCostConfig,
} from './quality-monitoring-config.js';

// ── RFC-0025 §13 OQ-5 Upstream Reporting — Phase 6 (AISDLC-307) ─────
// Operator-initiated, pre-filled GitHub issue for framework-bug
// captures. No telemetry pipeline.

export {
  anonymiseText,
  buildCaptureId,
  buildUpstreamReport,
  loadCaptureRecord,
  openInBrowser,
  relatedPathsForSubclass,
  renderIssueBody,
  suggestFixForSubclass,
  BUILTIN_UPSTREAM_TEMPLATE,
  UpstreamReportError,
  type BuildUpstreamReportOpts,
  type LoadCaptureOpts,
  type OpenInBrowserOpts,
  type RenderIssueBodyOpts,
  type UpstreamReport,
} from './upstream-reporter.js';

export {
  shouldSampleDeterminism,
  shouldSampleDeterminismComposite,
  isTopDecileBlastRadius,
  recordDeterminismBaseline,
  readDeterminismBaseline,
  checkDeterminismViolation,
  DETERMINISM_SAMPLE_RATE,
  DETERMINISM_SAMPLE_FRACTION,
  DETERMINISM_DIR,
  BASELINE_MAX_AGE_MS,
  type DeterminismBaseline,
  type DeterminismCheckResult,
  type DeterminismCompositeDecision,
  type DeterminismSampleReason,
  type ShouldSampleDeterminismCompositeOpts,
} from './determinism-detector.js';

// ── RFC-0025 §13 OQ-6 Coverage-gap response — Phase 5 (AISDLC-306) ───
// Composes with RFC-0024 capture substrate. Auto-quarantines the
// affected dispatch + writes a capture with `source: framework-coverage-gap`
// + `triage: tbd` so operators triage via the standard RFC-0024 rubric.

export {
  recordFrameworkCoverageGap,
  FRAMEWORK_COVERAGE_GAP_SOURCE,
  type RecordCoverageGapOpts,
  type RecordCoverageGapResult,
} from './coverage-gap.js';

// ── RFC-0025 §7.1 OQ-9 Operator-time-cost — Phase 5 (AISDLC-306) ────
// Instrumented from RFC-0015 events.jsonl substrate. AFK-filtered active
// cost feeds the §7 severity rubric output + RFC-0035 §7 fatigue signal
// (gated until AISDLC-291 ships).

export {
  computeOperatorTimeCost,
  classifyActiveCostBucket,
  formatOperatorTimeCostForRubric,
  resolveAfkInactivityMinutes,
  BLOCKED_EVENT_TYPES,
  ACTION_EVENT_TYPES,
  type ComputeOperatorTimeCostOpts,
  type OperatorTimeCostEntry,
  type OperatorTimeCostMetrics,
} from './operator-time-cost.js';
