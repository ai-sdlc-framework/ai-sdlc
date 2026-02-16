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
export { executeFixCI, countRetryAttempts, fetchCILogs, type FixCIOptions } from './fix-ci.js';

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
  NOTIFICATION_TITLES,
} from './defaults.js';

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
  type AgentRunner,
  type AgentContext,
  type AgentResult,
} from './runners/index.js';

// State store
export { StateStore } from './state/index.js';

// Orchestrator class
export { Orchestrator, type OrchestratorConfig } from './orchestrator.js';

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
