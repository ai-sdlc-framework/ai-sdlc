export { loadConfig, loadConfigAsync, type AiSdlcConfig } from './orchestrator/load-config.js';
export {
  validateIssue,
  validateIssueWithExtensions,
  parseComplexity,
} from './orchestrator/validate-issue.js';
export {
  executePipeline,
  type ExecuteOptions,
  type PipelineResult,
  type PromotionResult,
} from './orchestrator/execute.js';
export {
  validateAgentOutput,
  type ValidationContext,
  type ValidationResult,
  type ValidationViolation,
} from './orchestrator/validate-agent-output.js';
export { createLogger, type Logger } from './orchestrator/logger.js';
export {
  executeFixCI,
  countRetryAttempts,
  fetchCILogs,
  type FixCIOptions,
} from './orchestrator/fix-ci.js';
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
  type GitHubEnvConfig,
  type ValidateAndAuditParams,
} from './orchestrator/shared.js';
export { startWatch, type WatchOptions, type WatchHandle } from './orchestrator/watch.js';
export type { AgentRunner, AgentContext, AgentResult } from './runner/types.js';
export { GitHubActionsRunner } from './runner/github-actions.js';

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
} from './orchestrator/security.js';

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
} from './orchestrator/provenance.js';

// Admission pipeline
export {
  createPipelineAdmission,
  admitIssueResource,
  type PipelineAdmissionConfig,
  type AdmissionPipeline,
  type AdmissionResult,
} from './orchestrator/admission.js';

// Metrics instrumentation
export {
  createPipelineMetricStore,
  createInstrumentedEnforcement,
  createInstrumentedAutonomy,
  createInstrumentedExecutor,
  STANDARD_METRICS,
  instrumentExecutor,
} from './orchestrator/instrumented.js';

// Agent discovery
export {
  createPipelineDiscovery,
  findMatchingAgent,
  resolveAgentForIssue,
  matchAgentBySkill,
  createStubAgentCardFetcher,
  createPipelineAgentCardFetcher,
} from './orchestrator/discovery.js';

// Structured logging
export {
  createStructuredConsoleLogger,
  createStructuredBufferLogger,
} from './orchestrator/structured-logger.js';

// Resource builders
export {
  buildDogfoodPipeline,
  buildDogfoodAgentRole,
  buildDogfoodQualityGate,
  buildDogfoodAutonomyPolicy,
  buildDogfoodAdapterBinding,
  PipelineBuilder,
  AgentRoleBuilder,
  QualityGateBuilder,
  AutonomyPolicyBuilder,
  AdapterBindingBuilder,
  parseBuilderManifest,
  validateBuilderManifest,
  API_VERSION,
} from './orchestrator/builders.js';

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
} from './orchestrator/orchestration.js';

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
} from './orchestrator/policy-evaluators.js';

// Adapter ecosystem
export {
  createPipelineAdapterRegistry,
  createPipelineWebhookBridge,
  resolveAdapterFromGit,
  scanPipelineAdapters,
} from './orchestrator/adapters.js';

// Specialized reconcilers
export {
  createDogfoodPipelineReconciler,
  createDogfoodGateReconciler,
  createDogfoodAutonomyReconciler,
  hasResourceChanged,
  fingerprintResource,
} from './orchestrator/reconcilers.js';

// Extended audit
export {
  createFileAuditLog,
  verifyAuditIntegrity,
  loadAuditEntries,
  rotateAuditLog,
  computeAuditHash,
} from './orchestrator/audit-extended.js';

// Extended compliance
export {
  checkFrameworkCompliance,
  getControlCatalog,
  getFrameworkMappings,
  listSupportedFrameworks,
} from './orchestrator/compliance-extended.js';

// Extended telemetry
export {
  createSilentLogger,
  withPipelineSpanSync,
  getPipelineTracer,
  validateResourceSchema,
} from './orchestrator/telemetry-extended.js';

// Comprehensive type re-exports (core, policy, agent types)
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
  PromotionCriteria as CorePromotionCriteria,
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
} from './orchestrator/types-reexport.js';
