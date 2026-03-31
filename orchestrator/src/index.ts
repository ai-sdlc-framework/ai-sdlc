// ── Core orchestration ───────────────────────────────────────────────

export { loadConfig, loadConfigAsync, type AiSdlcConfig } from './config.js';
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
} from './admission-score.js';

// PR review orchestration
export { executeReview, type ReviewContext, type ReviewOptions } from './review.js';

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
} from './state/index.js';

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
