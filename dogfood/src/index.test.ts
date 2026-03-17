import { describe, it, expect } from 'vitest';
import * as index from './index.js';

describe('dogfood root barrel exports', () => {
  // Core orchestration
  it('exports loadConfig', () => {
    expect(index.loadConfig).toBeTypeOf('function');
  });

  it('exports loadConfigAsync', () => {
    expect(index.loadConfigAsync).toBeTypeOf('function');
  });

  it('exports validateIssue', () => {
    expect(index.validateIssue).toBeTypeOf('function');
  });

  it('exports validateIssueWithExtensions', () => {
    expect(index.validateIssueWithExtensions).toBeTypeOf('function');
  });

  it('exports parseComplexity', () => {
    expect(index.parseComplexity).toBeTypeOf('function');
  });

  it('exports executePipeline', () => {
    expect(index.executePipeline).toBeTypeOf('function');
  });

  it('exports validateAgentOutput', () => {
    expect(index.validateAgentOutput).toBeTypeOf('function');
  });

  it('exports createLogger', () => {
    expect(index.createLogger).toBeTypeOf('function');
  });

  it('exports executeFixCI', () => {
    expect(index.executeFixCI).toBeTypeOf('function');
  });

  it('exports countRetryAttempts', () => {
    expect(index.countRetryAttempts).toBeTypeOf('function');
  });

  it('exports fetchCILogs', () => {
    expect(index.fetchCILogs).toBeTypeOf('function');
  });

  // Shared utilities
  it('exports getGitHubConfig', () => {
    expect(index.getGitHubConfig).toBeTypeOf('function');
  });

  it('exports resolveRepoRoot', () => {
    expect(index.resolveRepoRoot).toBeTypeOf('function');
  });

  it('exports createDefaultAuditLog', () => {
    expect(index.createDefaultAuditLog).toBeTypeOf('function');
  });

  it('exports resolveAutonomyLevel', () => {
    expect(index.resolveAutonomyLevel).toBeTypeOf('function');
  });

  it('exports resolveConstraints', () => {
    expect(index.resolveConstraints).toBeTypeOf('function');
  });

  it('exports mergeBlockedPaths', () => {
    expect(index.mergeBlockedPaths).toBeTypeOf('function');
  });

  it('exports isAutonomousStrategy', () => {
    expect(index.isAutonomousStrategy).toBeTypeOf('function');
  });

  it('exports recordMetric', () => {
    expect(index.recordMetric).toBeTypeOf('function');
  });

  it('exports validateAndAuditOutput', () => {
    expect(index.validateAndAuditOutput).toBeTypeOf('function');
  });

  it('exports createPipelineMemory', () => {
    expect(index.createPipelineMemory).toBeTypeOf('function');
  });

  it('exports evaluatePipelineCompliance', () => {
    expect(index.evaluatePipelineCompliance).toBeTypeOf('function');
  });

  it('exports authorizeFilesChanged', () => {
    expect(index.authorizeFilesChanged).toBeTypeOf('function');
  });

  it('exports extractIssueNumber', () => {
    expect(index.extractIssueNumber).toBeTypeOf('function');
  });

  it('exports BRANCH_PATTERN', () => {
    expect(index.BRANCH_PATTERN).toBeDefined();
  });

  it('exports DEFAULT_CONFIG_DIR_NAME', () => {
    expect(index.DEFAULT_CONFIG_DIR_NAME).toBeTypeOf('string');
  });

  // Security subsystem
  it('exports createPipelineSecurity', () => {
    expect(index.createPipelineSecurity).toBeTypeOf('function');
  });

  it('exports checkKillSwitch', () => {
    expect(index.checkKillSwitch).toBeTypeOf('function');
  });

  it('exports issueAgentCredentials', () => {
    expect(index.issueAgentCredentials).toBeTypeOf('function');
  });

  it('exports revokeAgentCredentials', () => {
    expect(index.revokeAgentCredentials).toBeTypeOf('function');
  });

  it('exports classifyAndSubmitApproval', () => {
    expect(index.classifyAndSubmitApproval).toBeTypeOf('function');
  });

  it('exports classifyApprovalTier', () => {
    expect(index.classifyApprovalTier).toBeTypeOf('function');
  });

  it('exports compareTiers', () => {
    expect(index.compareTiers).toBeTypeOf('function');
  });

  it('exports createGitHubSandbox', () => {
    expect(index.createGitHubSandbox).toBeTypeOf('function');
  });

  it('exports createGitHubJITCredentialIssuer', () => {
    expect(index.createGitHubJITCredentialIssuer).toBeTypeOf('function');
  });

  it('exports createGitHubSandboxProvider', () => {
    expect(index.createGitHubSandboxProvider).toBeTypeOf('function');
  });

  it('exports createGitHubJITProvider', () => {
    expect(index.createGitHubJITProvider).toBeTypeOf('function');
  });

  // Provenance tracking
  it('exports createPipelineProvenance', () => {
    expect(index.createPipelineProvenance).toBeTypeOf('function');
  });

  it('exports attachProvenanceToPR', () => {
    expect(index.attachProvenanceToPR).toBeTypeOf('function');
  });

  it('exports validatePipelineProvenance', () => {
    expect(index.validatePipelineProvenance).toBeTypeOf('function');
  });

  it('exports provenanceToAnnotations', () => {
    expect(index.provenanceToAnnotations).toBeTypeOf('function');
  });

  it('exports provenanceFromAnnotations', () => {
    expect(index.provenanceFromAnnotations).toBeTypeOf('function');
  });

  it('exports PROVENANCE_ANNOTATION_PREFIX', () => {
    expect(index.PROVENANCE_ANNOTATION_PREFIX).toBeTypeOf('string');
  });

  // Admission pipeline
  it('exports createPipelineAdmission', () => {
    expect(index.createPipelineAdmission).toBeTypeOf('function');
  });

  it('exports admitIssueResource', () => {
    expect(index.admitIssueResource).toBeTypeOf('function');
  });

  // Metrics instrumentation
  it('exports createPipelineMetricStore', () => {
    expect(index.createPipelineMetricStore).toBeTypeOf('function');
  });

  it('exports createInstrumentedEnforcement', () => {
    expect(index.createInstrumentedEnforcement).toBeTypeOf('function');
  });

  it('exports createInstrumentedAutonomy', () => {
    expect(index.createInstrumentedAutonomy).toBeTypeOf('function');
  });

  it('exports createInstrumentedExecutor', () => {
    expect(index.createInstrumentedExecutor).toBeTypeOf('function');
  });

  it('exports STANDARD_METRICS', () => {
    expect(index.STANDARD_METRICS).toBeDefined();
  });

  it('exports instrumentExecutor', () => {
    expect(index.instrumentExecutor).toBeTypeOf('function');
  });

  // Agent discovery
  it('exports createPipelineDiscovery', () => {
    expect(index.createPipelineDiscovery).toBeTypeOf('function');
  });

  it('exports findMatchingAgent', () => {
    expect(index.findMatchingAgent).toBeTypeOf('function');
  });

  it('exports resolveAgentForIssue', () => {
    expect(index.resolveAgentForIssue).toBeTypeOf('function');
  });

  it('exports matchAgentBySkill', () => {
    expect(index.matchAgentBySkill).toBeTypeOf('function');
  });

  it('exports createStubAgentCardFetcher', () => {
    expect(index.createStubAgentCardFetcher).toBeTypeOf('function');
  });

  it('exports createPipelineAgentCardFetcher', () => {
    expect(index.createPipelineAgentCardFetcher).toBeTypeOf('function');
  });

  // Structured logging
  it('exports createStructuredConsoleLogger', () => {
    expect(index.createStructuredConsoleLogger).toBeTypeOf('function');
  });

  it('exports createStructuredBufferLogger', () => {
    expect(index.createStructuredBufferLogger).toBeTypeOf('function');
  });

  // Watch mode
  it('exports startWatch', () => {
    expect(index.startWatch).toBeTypeOf('function');
  });

  // Runners
  it('exports GitHubActionsRunner', () => {
    expect(index.GitHubActionsRunner).toBeTypeOf('function');
  });

  it('exports ClaudeCodeRunner', () => {
    expect(index.ClaudeCodeRunner).toBeTypeOf('function');
  });

  // Agent orchestration
  it('exports createPipelineOrchestration', () => {
    expect(index.createPipelineOrchestration).toBeTypeOf('function');
  });

  it('exports executePipelineOrchestration', () => {
    expect(index.executePipelineOrchestration).toBeTypeOf('function');
  });

  it('exports validatePipelineHandoffs', () => {
    expect(index.validatePipelineHandoffs).toBeTypeOf('function');
  });

  it('exports sequential', () => {
    expect(index.sequential).toBeTypeOf('function');
  });

  it('exports parallel', () => {
    expect(index.parallel).toBeTypeOf('function');
  });

  it('exports hybrid', () => {
    expect(index.hybrid).toBeTypeOf('function');
  });

  it('exports hierarchical', () => {
    expect(index.hierarchical).toBeTypeOf('function');
  });

  it('exports swarm', () => {
    expect(index.swarm).toBeTypeOf('function');
  });

  it('exports validateHandoff', () => {
    expect(index.validateHandoff).toBeTypeOf('function');
  });

  it('exports simpleSchemaValidate', () => {
    expect(index.simpleSchemaValidate).toBeTypeOf('function');
  });

  // Policy evaluators
  it('exports createPipelineRegoEvaluator', () => {
    expect(index.createPipelineRegoEvaluator).toBeTypeOf('function');
  });

  it('exports createPipelineCELEvaluator', () => {
    expect(index.createPipelineCELEvaluator).toBeTypeOf('function');
  });

  it('exports createPipelineABACHook', () => {
    expect(index.createPipelineABACHook).toBeTypeOf('function');
  });

  it('exports createPipelineExpressionEvaluator', () => {
    expect(index.createPipelineExpressionEvaluator).toBeTypeOf('function');
  });

  it('exports createPipelineLLMEvaluator', () => {
    expect(index.createPipelineLLMEvaluator).toBeTypeOf('function');
  });

  it('exports evaluatePipelineGate', () => {
    expect(index.evaluatePipelineGate).toBeTypeOf('function');
  });

  it('exports scorePipelineComplexity', () => {
    expect(index.scorePipelineComplexity).toBeTypeOf('function');
  });

  it('exports evaluatePipelineComplexityRouting', () => {
    expect(index.evaluatePipelineComplexityRouting).toBeTypeOf('function');
  });

  // Adapter ecosystem
  it('exports createPipelineAdapterRegistry', () => {
    expect(index.createPipelineAdapterRegistry).toBeTypeOf('function');
  });

  it('exports createPipelineWebhookBridge', () => {
    expect(index.createPipelineWebhookBridge).toBeTypeOf('function');
  });

  it('exports resolveAdapterFromGit', () => {
    expect(index.resolveAdapterFromGit).toBeTypeOf('function');
  });

  it('exports resolveInfrastructure', () => {
    expect(index.resolveInfrastructure).toBeTypeOf('function');
  });

  it('exports scanPipelineAdapters', () => {
    expect(index.scanPipelineAdapters).toBeTypeOf('function');
  });

  // Reconcilers
  it('exports createPipelineReconciler', () => {
    expect(index.createPipelineReconciler).toBeTypeOf('function');
  });

  it('exports createGateReconciler', () => {
    expect(index.createGateReconciler).toBeTypeOf('function');
  });

  it('exports createAutonomyReconciler', () => {
    expect(index.createAutonomyReconciler).toBeTypeOf('function');
  });

  it('exports hasResourceChanged', () => {
    expect(index.hasResourceChanged).toBeTypeOf('function');
  });

  it('exports fingerprintResource', () => {
    expect(index.fingerprintResource).toBeTypeOf('function');
  });

  // Backward-compatible reconciler aliases
  it('exports createDogfoodPipelineReconciler alias', () => {
    expect(index.createDogfoodPipelineReconciler).toBeTypeOf('function');
    expect(index.createDogfoodPipelineReconciler).toBe(index.createPipelineReconciler);
  });

  it('exports createDogfoodGateReconciler alias', () => {
    expect(index.createDogfoodGateReconciler).toBeTypeOf('function');
    expect(index.createDogfoodGateReconciler).toBe(index.createGateReconciler);
  });

  it('exports createDogfoodAutonomyReconciler alias', () => {
    expect(index.createDogfoodAutonomyReconciler).toBeTypeOf('function');
    expect(index.createDogfoodAutonomyReconciler).toBe(index.createAutonomyReconciler);
  });

  // Extended audit
  it('exports createFileAuditLog', () => {
    expect(index.createFileAuditLog).toBeTypeOf('function');
  });

  it('exports verifyAuditIntegrity', () => {
    expect(index.verifyAuditIntegrity).toBeTypeOf('function');
  });

  it('exports loadAuditEntries', () => {
    expect(index.loadAuditEntries).toBeTypeOf('function');
  });

  it('exports rotateAuditLog', () => {
    expect(index.rotateAuditLog).toBeTypeOf('function');
  });

  it('exports computeAuditHash', () => {
    expect(index.computeAuditHash).toBeTypeOf('function');
  });

  // Extended compliance
  it('exports checkFrameworkCompliance', () => {
    expect(index.checkFrameworkCompliance).toBeTypeOf('function');
  });

  it('exports getControlCatalog', () => {
    expect(index.getControlCatalog).toBeTypeOf('function');
  });

  it('exports getFrameworkMappings', () => {
    expect(index.getFrameworkMappings).toBeTypeOf('function');
  });

  it('exports listSupportedFrameworks', () => {
    expect(index.listSupportedFrameworks).toBeTypeOf('function');
  });

  // Extended telemetry
  it('exports createSilentLogger', () => {
    expect(index.createSilentLogger).toBeTypeOf('function');
  });

  it('exports withPipelineSpanSync', () => {
    expect(index.withPipelineSpanSync).toBeTypeOf('function');
  });

  it('exports getPipelineTracer', () => {
    expect(index.getPipelineTracer).toBeTypeOf('function');
  });

  it('exports validateResourceSchema', () => {
    expect(index.validateResourceSchema).toBeTypeOf('function');
  });

  // Orchestrator class & state store
  it('exports Orchestrator', () => {
    expect(index.Orchestrator).toBeTypeOf('function');
  });

  it('exports StateStore', () => {
    expect(index.StateStore).toBeTypeOf('function');
  });

  // Resource builders (dogfood-specific)
  it('exports buildDogfoodPipeline', () => {
    expect(index.buildDogfoodPipeline).toBeTypeOf('function');
  });

  it('exports buildDogfoodAgentRole', () => {
    expect(index.buildDogfoodAgentRole).toBeTypeOf('function');
  });

  it('exports buildDogfoodQualityGate', () => {
    expect(index.buildDogfoodQualityGate).toBeTypeOf('function');
  });

  it('exports buildDogfoodAutonomyPolicy', () => {
    expect(index.buildDogfoodAutonomyPolicy).toBeTypeOf('function');
  });

  it('exports buildDogfoodAdapterBinding', () => {
    expect(index.buildDogfoodAdapterBinding).toBeTypeOf('function');
  });

  it('exports PipelineBuilder', () => {
    expect(index.PipelineBuilder).toBeTypeOf('function');
  });

  it('exports API_VERSION', () => {
    expect(index.API_VERSION).toBeTypeOf('string');
  });
});
