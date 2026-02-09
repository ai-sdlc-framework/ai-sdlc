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
  type SecurityContext,
} from './orchestrator/security.js';

// Provenance tracking
export {
  createPipelineProvenance,
  attachProvenanceToPR,
  validatePipelineProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  type ProvenanceRecord,
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
  STANDARD_METRICS,
} from './orchestrator/instrumented.js';

// Agent discovery
export {
  createPipelineDiscovery,
  findMatchingAgent,
  resolveAgentForIssue,
  matchAgentBySkill,
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
