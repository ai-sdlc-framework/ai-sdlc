/**
 * Public surface for the autonomous-pipeline orchestrator (RFC-0015
 * Phase 1 + Phase 3).
 *
 * Phase 1 shipped:
 *   - The bare polling loop (`runOrchestratorLoop`) + per-tick driver
 *     (`runOrchestratorTick`).
 *   - Status inspection (`buildOrchestratorStatus`) for `cli-orchestrator status`.
 *   - Feature-flag predicate (`isOrchestratorEnabled`).
 *
 * Phase 3 (this revision) adds:
 *   - Pre-dispatch admission filter chain (DependencyReadiness, DoR
 *     readiness, external-deps gate). Re-exported from `./filters/`.
 *   - In-memory stuck-candidate counter + `OrchestratorStuckCandidate`
 *     event surface. Persistence to `$ARTIFACTS_DIR/_orchestrator/state.json`
 *     is deferred to Phase 4.
 *   - Exponential-backoff sleep cadence (Q3 + Q5) — `MAX_IDLE_SLEEP_SEC`
 *     + `makeInitialCadenceState` for callers that want to share state.
 *
 * Phase 2 (AISDLC-169.2 — in-flight on PR #224) lands the catalogued
 * failure playbook. Phase 4 (AISDLC-169.4) replaces the in-memory event
 * arrays with the `events.jsonl` writer + `cli-status --orchestrator`
 * view; Phase 5 (AISDLC-169.5) wires the soak corpus + chaos test +
 * promotion runbook.
 */

export {
  buildOrchestratorStatus,
  defaultOrchestratorConfig,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TICK_INTERVAL_SEC,
  makeInitialCadenceState,
  MAX_IDLE_SLEEP_SEC,
  OrchestratorDisabledError,
  RECOVERABLE_ABORT_OUTCOMES,
  ROLLBACK_OUTCOMES,
  runOrchestratorLoop,
  runOrchestratorTick,
  STUCK_CANDIDATE_THRESHOLD,
  type CadenceState,
  type OrchestratorAdapters,
  type StuckCounterEntry,
} from './loop.js';
export {
  countCheckpointCommits,
  countCommitsBeyondMain,
  detectRecoverableWorktree,
  emitCheckpointCommit,
  worktreePath as resolveWorktreePath,
  type CheckpointOptions,
  type CheckpointResult,
} from './checkpoint.js';
export {
  buildQuarantineRef,
  rollbackDispatch,
  type RollbackOptions,
  type RollbackResult,
} from './rollback.js';
export {
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  orchestratorDisabledMessage,
} from './feature-flag.js';
export {
  eventsDirPath,
  eventsFilePath,
  readRecentEvents,
  writeEvent,
  type OrchestratorEvent,
  type OrchestratorEventType,
  type ReadEventsOpts,
  type WriteEventOpts,
} from './events.js';
export type {
  DispatchFn,
  EscalateFn,
  EscalationRecord,
  FrontierFn,
  OrchestratorAwaitingExternalEvent,
  OrchestratorBlockedByDependencyEvent,
  OrchestratorBlockedByDorEvent,
  OrchestratorBlockedEvent,
  OrchestratorConfig,
  OrchestratorFilterEvent,
  OrchestratorIdleEvent,
  OrchestratorOrphanParentEvent,
  OrchestratorRollbackEvent,
  OrchestratorStatus,
  OrchestratorStuckCandidateEvent,
  OrchestratorTaskAbortedRecoverableEvent,
  OrchestratorTaskBlockedEvent,
  OrchestratorTaskResumedEvent,
  OrchestratorTickResult,
  OrchestratorWorkQuarantinedEvent,
  PipelineFailureDetail,
  PipelineOutcomeDetail,
  RichDispatchResult,
  TaskDispatchOutcome,
  UmbrellaDispatchFn,
} from './types.js';

// RFC-0015 Phase 2 — failure playbook (AISDLC-169.2).
export {
  CATALOGUED_MODES,
  DEFAULT_CATALOGUE,
  LONG_RUNNING_PR_THRESHOLD_MS,
  PLAYBOOK_HANDLERS,
  WorkerStateTracker,
  assertRegistryConsistency,
  attestationVerifyMismatchHandler,
  effectiveBudgets,
  envHookFailureHandler,
  findHandler,
  isDataOnlyChange,
  loadFailurePatternCatalogue,
  longRunningPrHandler,
  parseCatalogueYaml,
  pushRaceHandler,
  readPersistedWorkerState,
  rebaseConflictHandler,
  resolveCataloguePath,
  reviewerMajorOrCriticalHandler,
  runPlaybook,
  secretScanBlockedHandler,
  stackedPrBaseSquashedHandler,
  verificationFailureHandler,
  CatalogueParseError,
  RETRY_DELAY_MS,
  type CataloguePatternEntry,
  type FailureMode,
  type FailurePatternCatalogue,
  type FailureSignal,
  type Handler,
  type HandlerDeps,
  type LoadCatalogueOpts,
  type PersistedWorkerState,
  type PlaybookEvent,
  type PlaybookOpts,
  type PlaybookResult,
  type RemediationAppliedEvent,
  type RemediationFailedEvent,
  type RemediationOutcome,
  type RemediationStatus,
  type StateTrackerOpts,
  type WorkerContext,
  type WorkerParkedEvent,
  type WorkerState,
  type WorkerStateTransitionEvent,
} from './playbook/index.js';

// RFC-0015 Phase 3 — pre-dispatch admission filters (AISDLC-169.3).
// AISDLC-175 — orphan-parent filter (parent task whose every child is done).
// AISDLC-223 — blocked filter (operator-marked tasks with blocked.reason).
export {
  checkBlocked,
  checkDependencyReadiness,
  checkDorReadiness,
  checkExternalDependencies,
  checkOrphanParent,
  DOR_BYPASS_LABEL,
  formatFilterTrace,
  runFilterChain,
  type AwaitingExternalDetail,
  type BlockedDetail,
  type BlockedFrontmatter,
  type CheckBlockedOpts,
  type CheckDependencyReadinessOpts,
  type CheckDorReadinessOpts,
  type CheckExternalDependenciesOpts,
  type CheckOrphanParentOpts,
  type DependencyBlockedDetail,
  type DorBlockedDetail,
  type FilterChainResult,
  type FilterDetail,
  type FilterName,
  type FilterResult,
  type OrphanParentDetail,
  type RunFilterChainOpts,
} from './filters/index.js';
