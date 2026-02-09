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
