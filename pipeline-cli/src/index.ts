/**
 * @ai-sdlc/pipeline-cli — public entry point.
 *
 * Re-exports the public surface (types, runtime, step functions, composite
 * `executePipeline`) so consumers import one place:
 *
 *   import {
 *     executePipeline,
 *     MockSpawner,
 *     validateTask,
 *     // ... etc
 *   } from '@ai-sdlc/pipeline-cli';
 */

export * from './types.js';
export * from './runtime/index.js';
export * from './steps/index.js';
export * from './deps/index.js';
export { executePipeline } from './execute-pipeline.js';

// RFC-0015 Phase 1 — autonomous-pipeline orchestrator (AISDLC-169.1).
export {
  buildOrchestratorStatus,
  defaultOrchestratorConfig,
  DEFAULT_MAX_CONCURRENT as ORCHESTRATOR_DEFAULT_MAX_CONCURRENT,
  DEFAULT_TICK_INTERVAL_SEC as ORCHESTRATOR_DEFAULT_TICK_INTERVAL_SEC,
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  orchestratorDisabledMessage,
  OrchestratorDisabledError,
  runOrchestratorLoop,
  runOrchestratorTick,
  type DispatchFn as OrchestratorDispatchFn,
  type EscalateFn as OrchestratorEscalateFn,
  type EscalationRecord as OrchestratorEscalationRecord,
  type FrontierFn as OrchestratorFrontierFn,
  type OrchestratorAdapters,
  type OrchestratorConfig,
  type OrchestratorStatus,
  type OrchestratorTickResult,
  type TaskDispatchOutcome,
} from './orchestrator/index.js';

// AISDLC-142 — incremental review primitives (skip / delta-only / full).
// AISDLC-146 — HMAC-signed v2 markers (Layer 2 defense-in-depth).
export {
  buildAutoApprovedVerdict,
  collectChangedFileDeltaEntries,
  computeContentHashV3,
  decideIncrementalReview,
  DEFAULT_MAX_DELTA_LINES,
  findMarkerInComments,
  formatMarker,
  MARKER_HMAC_SECRET_ENV,
  MARKER_PREFIX,
  MARKER_SUFFIX,
  parseMarker,
  parseNumstatForDelta,
  type ChangedFileDeltaEntry,
  type DecideInputs,
  type DeltaStats,
  type IncrementalDecision,
  type IncrementalReason,
  type MarkerPayload,
  type MarkerVersion,
  type RunGit,
} from './incremental-review/incremental.js';

// AISDLC-141 — conditional review classifier (RFC-0010 §12).
export {
  ALL_REVIEWERS,
  appendCalibrationEntry,
  decideFromInvocationFailure,
  decideFromRulesetOutput,
  defaultRulesetDecision,
  parseNumstat,
  parsePathsFile,
  parseUnifiedDiff,
  type CalibrationLogEntry,
  type ClassifierDecision,
  type ClassifierOutput,
  type DiffSummary,
  type FellOpenReason,
  type ReviewerName,
} from './classifier/classifier.js';

// AISDLC-147 patch 2 — Anthropic API budget-exhaustion classifier.
export {
  BUDGET_EXHAUSTED_SUBSTRINGS,
  classifyOneReviewer,
  classifyReviewerOutputs,
  type AggregateDecision,
  type BudgetClassification,
  type ClassifiedReviewer,
  type ReviewerClassification,
  type ReviewerRawOutput,
} from './classifier/budget-classifier.js';

// RFC-0011 Phase 2a — Definition-of-Ready Stage A.
export {
  evaluateIssue,
  STAGE_A_PERF_BUDGET_MS,
  EVALUATOR_VERSION,
  DEFAULT_RESOLVERS,
  resolveReference,
  extractReferences,
  fileExistenceResolver,
  githubIssueResolver,
  urlHeadResolver,
  type IssueInput,
  type StageAVerdict,
  type GateEvaluation,
  type GateId,
  type GateVerdict,
  type GateConfidence,
  type GateSeverity,
  type GateStage,
  type OverallVerdict,
  type Reference,
  type ResolveResult,
  type Resolver,
  type ResolverOpts,
} from './dor/index.js';
