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
  ORCHESTRATOR_SPAWNER_ENV,
  OrchestratorDisabledError,
  ParentNotOnMainError,
  RECOVERABLE_ABORT_OUTCOMES,
  resolveUmbrellaSpawnerKind,
  ROLLBACK_OUTCOMES,
  runOrchestratorLoop,
  runOrchestratorTick,
  runParentBranchGuard,
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
// AISDLC-373 — single-PR operator-driven path: resolve a worktree-local
// task file into the `{id, title}` pair the synthetic frontier needs.
export {
  resolveTaskFromFile,
  TaskFromFileResolutionError,
  type ResolvedTaskFromFile,
} from './task-from-file.js';
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
  OrchestratorBlockedByBlastRadiusOverlapEvent,
  OrchestratorBlockedByDependencyEvent,
  OrchestratorBlockedByDispatchabilityEvent,
  OrchestratorBlockedByDorEvent,
  OrchestratorBlockedByOpenPullRequestEvent,
  OrchestratorBlockedEvent,
  OrchestratorConfig,
  OrchestratorFilterEvent,
  OrchestratorIdleEvent,
  OrchestratorOrphanParentEvent,
  OrchestratorRollbackEvent,
  OrchestratorStatus,
  OrchestratorStuckCandidateEvent,
  OrchestratorTaskAbortedRecoverableEvent,
  OrchestratorTaskAlreadyInFlightEvent,
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

// RFC-0009 §7.4 Phase 4.3 — HC_cost channel (AISDLC-318).
export {
  applyHcCost,
  extractMaxBudgetUsd,
  formatHcCostAdmissionLine,
  HC_COST_DEFAULT_WEIGHT,
  HC_COST_ENABLED_ENV,
  HC_COST_WEIGHT_ENV,
  loadHcCostConfig,
  readCalibrationTier,
  type HcCostCalibrationTier,
  type HcCostApplication,
  type HcCostConfig,
} from './hc-cost.js';

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

// AISDLC-396 — Pattern X bg-agent-request coordination protocol.
// In-session-agent dispatch via filesystem coordination between the
// Conductor (slash command body) and the slash command body's foreground
// Agent-fire sweep. Plugin subagents can't use Agent (AISDLC-98) so the
// Conductor cannot dispatch a dev directly — it writes a request file the
// slash command body picks up and converts into an Agent tool call.
export {
  BG_AGENT_REQUEST_SCHEMA_VERSION,
  BG_AGENT_REQUEST_SUBDIR,
  bgAgentRequestPath,
  buildDevPromptFromManifest,
  countInFlightBgAgents,
  DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS,
  ensureBgAgentRequestDir,
  listBgAgentRequests,
  pruneOrphanedBgAgentRequests,
  readBgAgentRequest,
  removeBgAgentRequest,
  writeBgAgentRequest,
  type BgAgentRequest,
  type BgAgentRequestStatus,
  type WriteBgAgentRequestOptions,
} from './dispatch-bg-agent.js';

// RFC-0015 Phase 3 — pre-dispatch admission filters (AISDLC-169.3).
// AISDLC-175 — orphan-parent filter (parent task whose every child is done).
// AISDLC-223 — blocked filter (operator-marked tasks with blocked.reason).
// AISDLC-361 — open-PR-by-branch filter (task has open PR on canonical branch).
export {
  checkBlocked,
  checkDependencyReadiness,
  checkDorReadiness,
  checkExternalDependencies,
  checkOpenPullRequestExists,
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
  type CheckOpenPullRequestExistsOpts,
  type CheckOrphanParentOpts,
  type DependencyBlockedDetail,
  type DorBlockedDetail,
  type FilterChainResult,
  type FilterDetail,
  type FilterName,
  type FilterResult,
  type OpenPREntry,
  type OpenPullRequestExistsDetail,
  type OrphanParentDetail,
  type RunFilterChainOpts,
} from './filters/index.js';
