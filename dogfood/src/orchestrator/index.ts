export { loadConfig, type AiSdlcConfig } from './load-config.js';
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
} from './security.js';

// Provenance tracking
export {
  createPipelineProvenance,
  attachProvenanceToPR,
  validatePipelineProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  type ProvenanceRecord,
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
  STANDARD_METRICS,
} from './instrumented.js';

// Agent discovery
export {
  createPipelineDiscovery,
  findMatchingAgent,
  resolveAgentForIssue,
  matchAgentBySkill,
} from './discovery.js';

// Structured logging
export {
  createStructuredConsoleLogger,
  createStructuredBufferLogger,
} from './structured-logger.js';

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
} from './builders.js';

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
  scanPipelineAdapters,
} from './adapters.js';

// Specialized reconcilers
export {
  createDogfoodPipelineReconciler,
  createDogfoodGateReconciler,
  createDogfoodAutonomyReconciler,
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
