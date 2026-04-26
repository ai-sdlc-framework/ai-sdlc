// ── Core orchestration ───────────────────────────────────────────────

export {
  loadConfig,
  loadConfigAsync,
  type AiSdlcConfig,
  type ConfigLoadWarning,
} from './config.js';
export { validateIssue, validateIssueWithExtensions, parseComplexity } from './validate-issue.js';
export {
  executePipeline,
  type ExecuteOptions,
  type PipelineResult,
  type PromotionResult,
} from './execute.js';
export {
  validateAgentOutput,
  type ValidationContext,
  type ValidationResult,
  type ValidationViolation,
} from './validate-agent-output.js';
export { createLogger, type Logger } from './logger.js';
export { validateConfigFiles, type FileValidationResult } from './validate-config.js';
export { executeFixCI, countRetryAttempts, fetchCILogs, type FixCIOptions } from './fix-ci.js';
export {
  executeFixReview,
  countRetryAttempts as countReviewRetryAttempts,
  fetchReviewFindings,
  type FixReviewOptions,
} from './fix-review.js';
export { executeTriage, type TriageOptions, type TriageResult } from './triage.js';

// Shared utilities
export {
  getGitHubConfig,
  resolveRepoRoot,
  createDefaultAuditLog,
  resolveAutonomyLevel,
  resolveConstraints,
  mergeBlockedPaths,
  isAutonomousStrategy,
  recordMetric,
  validateAndAuditOutput,
  createPipelineMemory,
  evaluatePipelineCompliance,
  authorizeFilesChanged,
  extractIssueNumber,
  extractIssueId,
  issueIdToNumber,
  formatIssueRef,
  BRANCH_PATTERN,
  createAbacPermissionHook,
  createBlockedPathsHook,
  createAuditLoggingHook,
  createPipelineAuthorizationChain,
  type GitHubEnvConfig,
  type ValidateAndAuditParams,
} from './shared.js';

// Defaults
export {
  DEFAULT_MODEL,
  DEFAULT_GITHUB_ORG,
  DEFAULT_GITHUB_REPO,
  DEFAULT_GITHUB_REPOSITORY,
  DEFAULT_CONFIG_DIR_NAME,
  DEFAULT_SANDBOX_MEMORY_MB,
  DEFAULT_SANDBOX_CPU_PERCENT,
  DEFAULT_SANDBOX_NETWORK_POLICY,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  defaultSandboxConstraints,
  DEFAULT_RUNNER_TIMEOUT_MS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_MAX_FILES_PER_CHANGE,
  DEFAULT_REQUIRE_TESTS,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_MAX_FIX_ATTEMPTS,
  DEFAULT_MAX_LOG_LINES,
  DEFAULT_GH_CLI_TIMEOUT_MS,
  DEFAULT_JIT_TTL_MS,
  DEFAULT_JIT_SCOPE,
  DEFAULT_BRANCH_TEMPLATE,
  DEFAULT_BRANCH_PATTERN,
  DEFAULT_PR_TITLE_TEMPLATE,
  DEFAULT_PR_FOOTER,
  DEFAULT_COMPLEXITY_THRESHOLDS,
  DEFAULT_MAX_LINES_PER_PR,
  DEFAULT_ANALYSIS_INCLUDE,
  DEFAULT_ANALYSIS_EXCLUDE,
  DEFAULT_GIT_HISTORY_DAYS,
  DEFAULT_HOTSPOT_THRESHOLD,
  NOTIFICATION_TITLES,
  DEFAULT_MODEL_COSTS,
  DEFAULT_COST_BUDGET_USD,
  DEFAULT_DASHBOARD_REFRESH_MS,
  PROGRESSIVE_GATE_PROFILES,
  DEFAULT_LINT_COMMAND,
  DEFAULT_FORMAT_COMMAND,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_COMMIT_CO_AUTHOR,
  DEFAULT_OPENAI_API_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_API_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GENERIC_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_SYSTEM_PROMPT,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_WORKFLOW_FILE,
  DEFAULT_LABEL_TO_SKILL_MAP,
  DEFAULT_ANALYSIS_CACHE_TTL_MS,
} from './defaults.js';
export type { ComplexityBand, GateProfile } from './defaults.js';

// Notifications
export { renderTemplate } from './notifications.js';

// Security subsystem
export {
  createPipelineSecurity,
  checkKillSwitch,
  issueAgentCredentials,
  revokeAgentCredentials,
  classifyAndSubmitApproval,
  classifyApprovalTier,
  compareTiers,
  createGitHubSandbox,
  createGitHubJITCredentialIssuer,
  createGitHubSandboxProvider,
  createGitHubJITProvider,
  type SecurityContext,
} from './security.js';

// Provenance tracking
export {
  createPipelineProvenance,
  attachProvenanceToPR,
  validatePipelineProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  PROVENANCE_ANNOTATION_PREFIX,
  type ProvenanceRecord,
  type ReviewDecision,
} from './provenance.js';

// Admission pipeline
export {
  createPipelineAdmission,
  admitIssueResource,
  type PipelineAdmissionConfig,
  type AdmissionPipeline,
  type AdmissionResult,
} from './admission.js';

// Metrics instrumentation
export {
  createPipelineMetricStore,
  createInstrumentedEnforcement,
  createInstrumentedAutonomy,
  createInstrumentedExecutor,
  STANDARD_METRICS,
  instrumentExecutor,
} from './instrumented.js';

// Agent discovery
export {
  createPipelineDiscovery,
  findMatchingAgent,
  resolveAgentForIssue,
  matchAgentBySkill,
  createStubAgentCardFetcher,
  createPipelineAgentCardFetcher,
} from './discovery.js';

// Structured logging
export {
  createStructuredConsoleLogger,
  createStructuredBufferLogger,
} from './structured-logger.js';

// Watch mode
export { startWatch, type WatchOptions, type WatchHandle } from './watch.js';

// Priority scoring (PPA)
export {
  computePriority,
  rankWorkItems,
  type PriorityScore,
  type PriorityInput,
  type PriorityConfig,
} from './priority.js';

// Action enforcement
export {
  checkAction,
  enforceAction,
  DEFAULT_BLOCKED_ACTIONS,
  type ActionEnforcementResult,
} from './action-enforcement.js';

// Issue admission scoring
export {
  scoreIssueForAdmission,
  mapIssueToPriorityInput,
  type AdmissionInput,
  type AdmissionThresholds,
  type IssueAdmissionResult,
  type AuthorAssociation,
  type DesignSystemContext,
  type AutonomyContext,
  type CodeAreaQuality,
  type DesignAuthoritySignal,
  type DesignAuthoritySignalType,
  type DesignQualityMetrics,
} from './admission-score.js';
export {
  enrichAdmissionInput,
  computeDesignSystemReadiness,
  computeReadinessFromDesignSystemContext,
  computeDefectRiskFactor,
  computeAutonomyFactor,
  computeDesignAuthorityWeight,
  complexityToAutonomyLevel,
  type EnrichmentContext,
  type LifecyclePhase,
} from './admission-enrichment.js';
export { computeAdmissionComposite, type AdmissionComposite } from './admission-composite.js';
export {
  parseBacklogTask,
  loadBacklogTaskFromRoot,
  mapBacklogTaskToAdmissionInput,
  loadSoulTracks,
  loadMaintainers,
  type BacklogTaskSnapshot,
  type BacklogAcceptanceCriterion,
  type BacklogMappingOptions,
  type BacklogAdmissionMapping,
} from './backlog-adapter.js';
export {
  computePillarBreakdown,
  detectTensions,
  pillarSignalScore,
  type PillarBreakdown,
  type PillarContribution,
  type PillarName,
  type SharedDimensions,
  type TensionFlag,
  type TensionFlagType,
  type HcChannelBreakdown,
} from './pillar-breakdown.js';

// RFC-0008 Addendum B — SA scoring (Layer 1/2/3 + composite)
export {
  compileDid,
  validatePhase2bReadiness,
  hashDidSpec,
  canonicalJson,
  tokenize,
  serializeForStore,
  deserializeFromStore,
  type CompiledDid,
  type CompiledScopeLists,
  type CompiledScopeEntry,
  type CompiledConstraintRule,
  type CompiledAntiPattern,
  type CompiledAntiPatternLists,
  type CompiledMeasurableSignal,
  type Bm25Corpus,
  type Bm25Document,
  type PrincipleCorpora,
  type ReadinessResult,
} from './sa-scoring/did-compiler.js';
export {
  HttpDepparseClient,
  FakeDepparseClient,
  DepparseError,
  type DepparseClient,
  type DepparseMatch,
  type DepparseMatchRequest,
  type DepparseMatchResponse,
  type DepparseHealth,
  type DepparseErrorKind,
} from './sa-scoring/depparse-client.js';
export {
  runLayer1,
  checkScopeGate,
  detectConstraintViolations,
  detectAntiPatterns,
  checkMeasurableSignals,
  renderPreVerifiedSummary,
  type DeterministicScoringResult,
  type ScopeGateResult,
  type ScopeGateMatch,
  type ConstraintViolation,
  type ConstraintViolationResult,
  type AntiPatternHit,
  type AntiPatternResult,
  type MeasurableSignalCheck,
  type MeasurableSignalResult,
  type Layer1Input,
} from './sa-scoring/layer1-deterministic.js';
export {
  computeDomainRelevance,
  computePrincipleCoverage,
  type DomainRelevanceResult,
  type PrincipleCoverageVector,
  type PrincipleCoverageEntry,
  type ContributingTerm,
} from './sa-scoring/layer2-structural.js';
export {
  runLayer3,
  buildSa1Prompt,
  buildSa2Prompt,
  extractJson,
  RecordedLLMClient,
  LayerLlmError,
  CONFIDENCE_THRESHOLD,
  type LLMClient,
  type LLMScoringResult,
  type SubtleConflict,
  type SubtleDesignConflict,
  type Layer3Input,
  type PromptContext,
  type LayerLlmErrorKind,
} from './sa-scoring/layer3-llm.js';
export {
  computeSoulAlignment,
  computeSa1,
  computeSa2,
  getPhaseWeights,
  W_STRUCTURAL_FLOOR,
  type SoulAlignmentResult,
  type SoulAlignmentInput,
  type Sa1Inputs,
  type Sa2Inputs,
  type Sa1Result,
  type Sa2Result,
  type SaPhase,
  type PhaseWeights,
} from './sa-scoring/composite.js';
export { computeSa2Computable, type Sa2ComputableResult } from './sa-scoring/c1-sa2-computable.js';
export {
  SAFeedbackStore,
  SA_FEEDBACK_LABELS,
  classifyLabel,
  recordOverrideFeedback,
  type RecordFeedbackInput,
  type PrecisionWindow,
  type PrecisionResult,
  type CategoryFalsePositive,
  type OverrideFeedbackInput,
} from './sa-scoring/feedback-store.js';
export {
  computeCalibrationCoefficient,
  buildCategoryCoefficients,
  type CategoryFeedback,
  type BuildCategoryCoefficientsInput,
} from './calibration.js';
export {
  autoCalibratePhaseWeights,
  computePhase3Weights,
  decideCalibrationDirection,
  renderCalibrationDiff,
  WEIGHT_FLOOR,
  WEIGHT_CEILING,
  DEFAULT_SHIFT_SIZE,
  DEFAULT_WINDOW_DAYS,
  PRECISION_DELTA_THRESHOLD,
  type PrecisionPair,
  type CalibrationDecision,
  type ComputePhase3WeightsInput,
  type AutoCalibrateDeps,
  type AutoCalibrateResult,
  type DimensionDiff,
} from './sa-scoring/auto-calibrate.js';
export {
  detectSoulDrift,
  computeWindowStats,
  computeTrend,
  describeDriftSource,
  DEFAULT_MEAN_THRESHOLD,
  DEFAULT_STDDEV_THRESHOLD,
  DEFAULT_CONSECUTIVE_WINDOWS,
  DEFAULT_RECOVERY_MS,
  type SoulDriftDetectedEvent,
  type DriftTrend,
  type WindowStats,
  type DriftDetectorDeps,
} from './sa-scoring/drift-monitor.js';
export {
  handleCoreIdentityChanged,
  type CoreIdentityChangedEvent,
  type BacklogReshuffledEvent,
  type SoulGraphStaleFlag,
  type RescoreDeps,
  type HandleResult,
} from './sa-scoring/rescore-orchestrator.js';
export {
  scoreSoulAlignment,
  resolveSoulAlignmentOverride,
  type ScoreSoulAlignmentInput,
  type ScoreSoulAlignmentDeps,
  type SoulAlignmentScoringResult,
} from './sa-scoring/index.js';
export type { SaDimension, FeedbackSignal } from './state/types.js';

// PR review orchestration
export { executeReview, type ReviewContext, type ReviewOptions } from './review.js';
export {
  metaReview,
  ReviewFeedbackStore,
  type MetaReviewDecision,
  type MetaReviewResult,
  type ReviewFeedback,
} from './review-meta.js';

// Agent orchestration
export {
  createPipelineOrchestration,
  executePipelineOrchestration,
  validatePipelineHandoffs,
  sequential,
  parallel,
  hybrid,
  hierarchical,
  swarm,
  validateHandoff,
  simpleSchemaValidate,
} from './orchestration.js';

// Policy evaluators
export {
  createPipelineRegoEvaluator,
  createPipelineCELEvaluator,
  createPipelineABACHook,
  createPipelineExpressionEvaluator,
  createPipelineLLMEvaluator,
  evaluatePipelineGate,
  scorePipelineComplexity,
  evaluatePipelineComplexityRouting,
} from './policy-evaluators.js';

// Adapter ecosystem
export {
  createPipelineAdapterRegistry,
  createPipelineWebhookBridge,
  resolveAdapterFromGit,
  resolveInfrastructure,
  resolveIssueTrackerFromConfig,
  scanPipelineAdapters,
} from './adapters.js';

// Reconcilers (generalized names)
export {
  createPipelineReconciler,
  createGateReconciler,
  createAutonomyReconciler,
  hasResourceChanged,
  fingerprintResource,
} from './reconcilers.js';

// Extended audit
export {
  createFileAuditLog,
  verifyAuditIntegrity,
  loadAuditEntries,
  rotateAuditLog,
  computeAuditHash,
} from './audit-extended.js';

// Extended compliance
export {
  checkFrameworkCompliance,
  getControlCatalog,
  getFrameworkMappings,
  listSupportedFrameworks,
} from './compliance-extended.js';

// Extended telemetry
export {
  createSilentLogger,
  withPipelineSpanSync,
  getPipelineTracer,
  validateResourceSchema,
} from './telemetry-extended.js';

// Runners
export {
  ClaudeCodeRunner,
  ClaudeCodeRunner as GitHubActionsRunner,
  GenericLLMRunner,
  CopilotRunner,
  CursorRunner,
  CodexRunner,
  RunnerRegistry,
  createRunnerRegistry,
  SecurityTriageRunner,
  ReviewAgentRunner,
  REVIEW_PROMPTS,
  type AgentRunner,
  type AgentContext,
  type AgentResult,
  type AgentProgressEvent,
  type GenericLLMConfig,
  type RegisteredRunner,
  type SecurityTriageConfig,
  type TriageVerdict,
  type ReviewAgentConfig,
  type ReviewType,
  type ReviewFinding,
  type ReviewVerdict,
} from './runners/index.js';

// Runners (additional type)
export type { TokenUsage } from './runners/index.js';

// Notifications
export { SlackMessenger, TeamsMessenger, NotificationRouter } from './notifications/index.js';
export type {
  SlackConfig,
  TeamsConfig,
  PipelineEvent,
  PipelineEventType,
  NotificationRoute,
  NotificationTemplate,
} from './notifications/index.js';

// State store
export { StateStore } from './state/index.js';
export type {
  HotspotRecord,
  RoutingDecision,
  CostLedgerEntry,
  GateThresholdOverride,
  AutonomyEvent,
  AutonomyEventType,
  HandoffEvent,
  DeploymentRecord,
  DeploymentRecordState,
  RolloutStepRecord,
  AuditEntryRecord,
  PriorityCalibrationSample,
  ToolSequenceEvent,
  WorkflowPattern,
  PatternProposal,
} from './state/index.js';

// Workflow pattern detection
export {
  readToolSequenceJSONL,
  readSessionMetaFiles,
  sessionMetaToEvents,
  categorizeAction,
  DEFAULT_DETECTION_OPTIONS,
} from './workflow-patterns/index.js';
export type {
  CanonicalStep,
  NGram,
  DetectedPattern,
  DetectionOptions,
  RawToolSequenceEntry,
  SessionMeta,
} from './workflow-patterns/index.js';

// Deployment targets
export {
  createKubernetesTarget,
  createVercelTarget,
  createFlyioTarget,
  createHttpMetricsCollector,
  createStubMetricsCollector,
  RolloutController,
} from './deploy/index.js';
export type {
  DeploymentTargetConfig,
  HealthCheckConfig,
  DeploymentState,
  DeploymentResult,
  DeploymentTarget,
  ExecFn,
  FetchFn,
  KubernetesConfig,
  VercelConfig,
  FlyioConfig,
  CanaryStep,
  CanaryConfig,
  BlueGreenConfig,
  RollingConfig,
  RolloutStrategy,
  RolloutPhase,
  RolloutStatus,
  RolloutMetrics,
  MetricsSource,
  RolloutControllerConfig,
  HttpMetricsConfig,
} from './deploy/index.js';

// Progressive gates
export {
  getComplexityBand,
  getGateProfile,
  adjustEnforcement,
  adjustGateForComplexity,
  adjustGatesForComplexity,
  computeGateAdjustments,
} from './progressive-gates.js';
export type { AdjustedGate, GateAdjustment } from './progressive-gates.js';

// Process escalation
export {
  evaluateProcessEscalation,
  isSignificantEscalation,
  formatEscalationSummary,
} from './process-escalation.js';
export type {
  EscalationAction,
  EscalationResult,
  EscalationActionType,
} from './process-escalation.js';

// Enhanced episodic memory
export {
  createEnhancedEpisodicMemory,
  detectRegressions,
  extractEpisodicPatterns,
} from './episodic-enhanced.js';
export type {
  EnhancedEpisodicInput,
  RegressionInfo,
  FailurePattern,
  EpisodicSummary,
} from './episodic-enhanced.js';

// Context enrichment
export {
  findRelevantEpisodes,
  formatEpisodicContext,
  enrichAgentContext,
} from './context-enrichment.js';
export type { EpisodeSearchCriteria, ScoredEpisode } from './context-enrichment.js';

// Autonomy tracker
export { AutonomyTracker } from './autonomy-tracker.js';
export type {
  AgentPerformanceMetrics,
  PromotionEvaluation,
  DemotionEvaluation,
  PromotionProximity,
} from './autonomy-tracker.js';

// Cost tracker
export { CostTracker } from './cost-tracker.js';
export type { CostSummary, BudgetStatus, CostTimeSeriesPoint } from './cost-tracker.js';

// OTel bridge
export { createOTelBridge, isOTelAvailable } from './otel-exporter.js';
export type { OTelBridge, OTelBridgeOptions, OTelSpanHandle } from './otel-exporter.js';

// Dashboard renderer
export { renderDashboardFrame } from './cli/dashboard-renderer.js';
export type { DashboardData } from './cli/dashboard-renderer.js';

// Codebase analysis
export {
  walkFiles,
  detectModules,
  parseImports,
  buildModuleGraph,
  detectConventions,
  detectPatterns,
  analyzeHotspots,
  computeComplexityScore,
  analyzeCodebase,
  buildCodebaseContext,
  formatContextForPrompt,
  analyzeDiff,
  extractChangedFiles,
} from './analysis/index.js';
export type {
  CodebaseProfile,
  CodebaseContext,
  Hotspot,
  ArchitecturalPattern,
  DetectedConvention,
  ModuleInfo,
  ModuleGraph,
  DependencyEdge,
  AnalyzerOptions,
  FileInfo,
  ImportStatement,
  DiffFinding,
  DiffAnalysisResult,
} from './analysis/index.js';

// Check runs
export { createCheckRun, updateCheckRun, reportGateCheckRuns } from './check-runs.js';

// Multi-repo orchestration
export {
  detectMonorepoLayout,
  detectWorkspace,
  buildServiceMap,
  detectCycles,
  topologicalOrder,
  getTransitiveDependents,
  analyzeImpact,
  formatImpactSummary,
  getAffectedBuildOrder,
} from './multi-repo/index.js';
export type {
  ServiceNode,
  ServiceMap,
  ServiceEdge,
  MonorepoLayout,
  WorkspaceConfig,
  WorkspacePackage,
  ImpactResult,
} from './multi-repo/index.js';

// Task decomposition
export { decomposeTask, validateTaskGraph, getExecutionLayers } from './task-decomposer.js';
export type {
  SubTask,
  TaskGraph,
  DecompositionContext,
  DecompositionOptions,
} from './task-decomposer.js';

// Handoff execution
export { HandoffExecutor } from './handoff-executor.js';
export type { HandoffPayload, HandoffResult, HandoffExecutorOptions } from './handoff-executor.js';

// Webhook manager
export {
  createWebhookManager,
  type WebhookManager,
  type WebhookManagerConfig,
  type WebhookBridges,
} from './webhook-manager.js';

// Audit modules
export { createSqliteAuditSink } from './audit-sqlite-sink.js';
export { createAuditScheduler } from './audit-scheduler.js';
export type { AuditSchedulerConfig, AuditScheduler } from './audit-scheduler.js';
export { exportAuditEntries, generateComplianceReport } from './audit-export.js';
export type {
  ExportFormat,
  ExportOptions,
  ComplianceReportOptions,
  ComplianceReport,
} from './audit-export.js';
export { archiveEntries, loadArchivedEntries, verifyArchiveContinuity } from './audit-archival.js';
export type { ArchiveManifest, ArchivalOptions } from './audit-archival.js';

// Orchestrator class
export { Orchestrator, type OrchestratorConfig, type WebhookConfig } from './orchestrator.js';

// Plugin interface
export type {
  OrchestratorPlugin,
  PluginContext,
  BeforeRunEvent,
  AfterRunEvent,
  RunErrorEvent,
} from './plugin.js';

// Cost governance plugin
export { CostGovernancePlugin } from './cost-governance.js';

// RFC-0010 runtime primitives
export {
  WorktreePoolManager,
  WorktreePoolError,
  WorktreeOwnershipError,
  deterministicPort,
  allocatePort,
  allocateContiguousPorts,
  isPortFree,
  PortAllocationError,
  slugifyBranch,
  worktreePath,
  verifyOwnership,
  assertOwnership,
  isExistingWorktree,
  readParallelismMode,
  isParallelismEnabled,
  PARALLELISM_FLAG,
  DEFAULT_BASE_PORT,
  DEFAULT_POOL_ROOT,
  DEFAULT_STALE_THRESHOLD_DAYS,
  type WorktreePoolSpec,
  type WorktreePoolManagerDeps,
  type WorktreeHandle,
  type AllocateOptions,
  type AllocatePortOptions,
  type AllocateContiguousOptions,
  type OwnershipResult,
  type ParallelismMode,
} from './runtime/index.js';

// RFC-0010 harness adapters
export {
  HarnessRegistry,
  UnknownHarnessError,
  ClaudeCodeAdapter,
  CodexAdapter,
  createDefaultHarnessRegistry,
  probeVersion,
  matchesRange,
  enforceIndependence,
  validateIndependenceGraph,
  CyclicIndependenceConstraintError,
  type HarnessAdapter,
  type HarnessAvailability,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessInput,
  type HarnessName,
  type HarnessRequires,
  type HarnessResult,
  type HarnessResultStatus,
  type ClaudeCodeAdapterDeps,
  type CodexAdapterDeps,
  type IndependenceResult,
  type UpstreamRun,
  type ToolDefinition,
} from './harness/index.js';

// RFC-0010 subscription scheduling
export {
  SubscriptionLedger,
  validateTenantShares,
  evaluateSchedule,
  CalibrationStore,
  COLD_START_DEFAULT,
  buildBurnDownReport,
  analyzeTier,
  PLAN_COSTS_USD,
  isOffPeakAt,
  nextOffPeakStart,
  ageInDays,
  freshnessLevel,
  DEFAULT_TENANT,
  COLD_START_DEFAULT_INPUT,
  COLD_START_DEFAULT_OUTPUT,
  ESTIMATE_VARIANCE_THRESHOLD,
  ROLLING_WINDOW_SIZE,
  type SubscriptionPlan,
  type Schedule,
  type TokenEstimate,
  type LedgerKey,
  type WindowState,
  type AdmissionDecision,
  type BurnDownReport,
  type LedgerEvent,
  type BillingMode,
  type QuotaSource,
  type OffPeakSchedule,
  type BurnDownInput,
  type CalibrationStoreDeps,
  type LedgerDeps,
  type ScheduleDecision,
  type ScheduleEvaluationContext,
  type Confidence,
  type ContentionEvent,
  type TierAnalysisInput,
  type TierAnalysisResult,
  type FreshnessLevel,
} from './scheduling/index.js';

// RFC-0010 artifacts (heartbeat + event stream + atomic JSON + state listing)
export {
  StateWriter,
  appendEvent,
  readEvents,
  atomicWriteJson,
  listActiveStates,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  type RuntimeState,
  type ArtifactEvent,
  type StageStatus,
} from './artifacts/index.js';

// RFC-0010 dispatch (worker pool + merge gate + requeue)
export {
  runWorkerPool,
  withMergeGate,
  forceReleaseMergeGate,
  isBranchUpToDate,
  MergeGateLockTimeoutError,
  decideRequeue,
  appendTriageHistory,
  type WorkItem,
  type WorkerPoolDeps,
  type WorkerPoolEvent,
  type WorkerPoolResult,
  type FailureEvent,
  type RequeueTrigger,
  type RequeueDecision,
  type RequeueDecisionInput,
  type TriageHistoryEntry,
  type FailureClassification,
  type MergeGateDeps,
} from './dispatch/index.js';

// RFC-0010 model registry + classifier
export {
  ModelRegistry,
  ModelRemovedError,
  UnknownAliasError,
  DEFAULT_REGISTRY,
  decideFromRawOutput,
  decideFromInvocationFailure,
  validateClassifierOutput,
  defaultRulesetDecision,
  appendCalibrationEntry,
  ALL_REVIEWERS,
  type ModelEntry,
  type ResolutionContext,
  type ResolutionResult,
  type ResolutionEvent,
  type ReviewerName,
  type ClassifierOutput,
  type ClassifierDecision,
  type FellOpenReason,
  type CalibrationLogEntry,
  type DiffSummary,
} from './models/index.js';

// Pipeline cycle detection
export {
  PipelineCycleDetector,
  createStageMarker,
  parseStageInvocations,
  DEFAULT_CYCLE_LIMITS,
  type PipelineStage,
  type CycleConfig,
  type CycleDetectionResult,
} from './pipeline-cycle-detector.js';
export {
  checkAndHandleCycle,
  createCycleDetectorFromConfig,
  type CycleHandlerOptions,
  type CycleCheckResult,
} from './cycle-utils.js';

// Comprehensive type re-exports
export type {
  ApiVersion,
  Metadata,
  Condition,
  SecretRef,
  MetricCondition,
  Duration,
  Resource,
  TriggerFilter,
  Trigger,
  Provider,
  RoutingStrategy,
  ComplexityThreshold,
  Routing,
  Stage,
  PipelineSpec,
  PipelinePhase,
  PipelineStatus,
  Pipeline,
  AgentConstraints,
  HandoffContractRef,
  Handoff,
  SkillExample,
  Skill,
  AgentCard,
  AgentRoleSpec,
  AgentRoleStatus,
  AgentRole,
  GateScope,
  MetricRule,
  ToolRule,
  ReviewerRule,
  DocumentationRule,
  ProvenanceRule,
  ExpressionRule,
  GateRule,
  EnforcementLevel,
  Override,
  RetryPolicy,
  Evaluation,
  Gate,
  QualityGateSpec,
  QualityGateStatus,
  QualityGate,
  Permissions,
  ApprovalRequirement,
  Guardrails,
  MonitoringLevel,
  AutonomyLevel,
  PromotionCriteria,
  DemotionTrigger,
  AgentAutonomyStatus,
  AutonomyPolicySpec,
  AutonomyPolicyStatus,
  AutonomyPolicy,
  AdapterInterface,
  HealthCheck,
  AdapterBindingSpec,
  AdapterBindingStatus,
  AdapterBinding,
  AnyResource,
  ResourceKind,
  ValidationError,
  GateVerdict,
  DemotionResult,
  ComplexityFactor,
  AuthorizationContext,
  AuthorizationResult,
  AuthIdentity,
  AuthenticationResult,
  Authenticator,
  MutatingGateContext,
  ExpressionEvaluator,
  ExpressionVerdict,
  LLMEvaluationDimension,
  LLMEvaluationResult,
  LLMGateVerdict,
  AgentExecutionState,
  HandoffValidationError,
  SchemaResolver,
  SchemaValidationError,
  MemoryTier,
  MemoryEntry,
  WorkingMemory,
  ShortTermMemory,
  LongTermMemory,
  SharedMemory,
  EpisodicMemory,
} from './types.js';
