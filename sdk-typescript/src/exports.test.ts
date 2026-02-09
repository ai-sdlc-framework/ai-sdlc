import { describe, it, expect } from 'vitest';

/**
 * Verify that each SDK subpath module exports expected key symbols.
 * Uses dynamic imports to test the actual module resolution.
 */

describe('SDK subpath exports', () => {
  it('core exports resource types and validation', async () => {
    const mod = await import('./core.js');
    expect(mod.API_VERSION).toBeDefined();
    expect(mod.validate).toBeTypeOf('function');
    expect(mod.validateResource).toBeTypeOf('function');
    expect(mod.compareMetric).toBeTypeOf('function');
    expect(mod.exceedsSeverity).toBeTypeOf('function');
    expect(mod.createProvenance).toBeTypeOf('function');
    expect(mod.PROVENANCE_ANNOTATION_PREFIX).toBeTypeOf('string');
  });

  it('builders exports all 5 resource builders + distribution', async () => {
    const mod = await import('./builders.js');
    expect(mod.PipelineBuilder).toBeTypeOf('function');
    expect(mod.AgentRoleBuilder).toBeTypeOf('function');
    expect(mod.QualityGateBuilder).toBeTypeOf('function');
    expect(mod.AutonomyPolicyBuilder).toBeTypeOf('function');
    expect(mod.AdapterBindingBuilder).toBeTypeOf('function');
    expect(mod.parseBuilderManifest).toBeTypeOf('function');
    expect(mod.validateBuilderManifest).toBeTypeOf('function');
    expect(mod.buildDistribution).toBeTypeOf('function');
  });

  it('policy exports enforcement, autonomy, complexity, auth', async () => {
    const mod = await import('./policy.js');
    expect(mod.enforce).toBeTypeOf('function');
    expect(mod.evaluateGate).toBeTypeOf('function');
    expect(mod.evaluatePromotion).toBeTypeOf('function');
    expect(mod.evaluateDemotion).toBeTypeOf('function');
    expect(mod.scoreComplexity).toBeTypeOf('function');
    expect(mod.checkPermission).toBeTypeOf('function');
    expect(mod.authorize).toBeTypeOf('function');
    expect(mod.createTokenAuthenticator).toBeTypeOf('function');
    expect(mod.applyMutatingGates).toBeTypeOf('function');
    expect(mod.createSimpleExpressionEvaluator).toBeTypeOf('function');
    expect(mod.evaluateLLMRule).toBeTypeOf('function');
    expect(mod.admitResource).toBeTypeOf('function');
    expect(mod.createRegoEvaluator).toBeTypeOf('function');
    expect(mod.createCELEvaluator).toBeTypeOf('function');
    expect(mod.createABACAuthorizationHook).toBeTypeOf('function');
  });

  it('adapters exports interfaces, registry, scanner, stubs', async () => {
    const mod = await import('./adapters.js');
    expect(mod.createAdapterRegistry).toBeTypeOf('function');
    expect(mod.validateAdapterMetadata).toBeTypeOf('function');
    expect(mod.parseMetadataYaml).toBeTypeOf('function');
    expect(mod.scanLocalAdapters).toBeTypeOf('function');
    expect(mod.resolveSecret).toBeTypeOf('function');
    expect(mod.createStubCodeAnalysis).toBeTypeOf('function');
    expect(mod.createStubMessenger).toBeTypeOf('function');
    expect(mod.createStubDeploymentTarget).toBeTypeOf('function');
    expect(mod.createWebhookBridge).toBeTypeOf('function');
    expect(mod.createStubGitLabCI).toBeTypeOf('function');
    expect(mod.createStubJira).toBeTypeOf('function');
    expect(mod.createStubBitbucket).toBeTypeOf('function');
    expect(mod.createStubSonarQube).toBeTypeOf('function');
    expect(mod.createStubSemgrep).toBeTypeOf('function');
  });

  it('reconciler exports loop, domain reconcilers, diff', async () => {
    const mod = await import('./reconciler.js');
    expect(mod.ReconcilerLoop).toBeTypeOf('function');
    expect(mod.reconcileOnce).toBeTypeOf('function');
    expect(mod.calculateBackoff).toBeTypeOf('function');
    expect(mod.createPipelineReconciler).toBeTypeOf('function');
    expect(mod.createGateReconciler).toBeTypeOf('function');
    expect(mod.createAutonomyReconciler).toBeTypeOf('function');
    expect(mod.resourceFingerprint).toBeTypeOf('function');
    expect(mod.hasSpecChanged).toBeTypeOf('function');
    expect(mod.createResourceCache).toBeTypeOf('function');
  });

  it('agents exports orchestration, executor, memory, discovery', async () => {
    const mod = await import('./agents.js');
    expect(mod.sequential).toBeTypeOf('function');
    expect(mod.parallel).toBeTypeOf('function');
    expect(mod.router).toBeTypeOf('function');
    expect(mod.hierarchical).toBeTypeOf('function');
    expect(mod.collaborative).toBeTypeOf('function');
    expect(mod.executeOrchestration).toBeTypeOf('function');
    expect(mod.validateHandoff).toBeTypeOf('function');
    expect(mod.createAgentMemory).toBeTypeOf('function');
    expect(mod.createAgentDiscovery).toBeTypeOf('function');
    expect(mod.matchAgentBySkill).toBeTypeOf('function');
  });

  it('audit exports logging and file sink', async () => {
    const mod = await import('./audit.js');
    expect(mod.createAuditLog).toBeTypeOf('function');
    expect(mod.computeEntryHash).toBeTypeOf('function');
    expect(mod.createFileSink).toBeTypeOf('function');
    expect(mod.loadEntriesFromFile).toBeTypeOf('function');
    expect(mod.verifyFileIntegrity).toBeTypeOf('function');
    expect(mod.rotateAuditFile).toBeTypeOf('function');
  });

  it('metrics exports store, standard metrics, instrumentation', async () => {
    const mod = await import('./metrics.js');
    expect(mod.createMetricStore).toBeTypeOf('function');
    expect(mod.STANDARD_METRICS).toBeDefined();
    expect(mod.instrumentEnforcement).toBeTypeOf('function');
    expect(mod.instrumentExecutor).toBeTypeOf('function');
    expect(mod.instrumentReconciler).toBeTypeOf('function');
    expect(mod.instrumentAutonomy).toBeTypeOf('function');
  });

  it('telemetry exports semantic conventions and loggers', async () => {
    const mod = await import('./telemetry.js');
    expect(mod.SPAN_NAMES).toBeDefined();
    expect(mod.METRIC_NAMES).toBeDefined();
    expect(mod.ATTRIBUTE_KEYS).toBeDefined();
    expect(mod.AI_SDLC_PREFIX).toBeTypeOf('string');
    expect(mod.getTracer).toBeTypeOf('function');
    expect(mod.getMeter).toBeTypeOf('function');
    expect(mod.withSpan).toBeTypeOf('function');
    expect(mod.createNoOpLogger).toBeTypeOf('function');
    expect(mod.createBufferLogger).toBeTypeOf('function');
    expect(mod.createConsoleLogger).toBeTypeOf('function');
  });

  it('security exports interfaces, approval tiers, stubs', async () => {
    const mod = await import('./security.js');
    expect(mod.classifyApprovalTier).toBeTypeOf('function');
    expect(mod.compareTiers).toBeTypeOf('function');
    expect(mod.createStubSandbox).toBeTypeOf('function');
    expect(mod.createStubJITCredentialIssuer).toBeTypeOf('function');
    expect(mod.createStubKillSwitch).toBeTypeOf('function');
    expect(mod.createStubApprovalWorkflow).toBeTypeOf('function');
    expect(mod.createGitHubSandbox).toBeTypeOf('function');
    expect(mod.createGitHubJITCredentialIssuer).toBeTypeOf('function');
  });

  it('compliance exports mappings and checker', async () => {
    const mod = await import('./compliance.js');
    expect(mod.AI_SDLC_CONTROLS).toBeDefined();
    expect(mod.EU_AI_ACT_MAPPINGS).toBeDefined();
    expect(mod.NIST_AI_RMF_MAPPINGS).toBeDefined();
    expect(mod.ISO_42001_MAPPINGS).toBeDefined();
    expect(mod.ISO_12207_MAPPINGS).toBeDefined();
    expect(mod.OWASP_ASI_MAPPINGS).toBeDefined();
    expect(mod.CSA_ATF_MAPPINGS).toBeDefined();
    expect(mod.REGULATORY_FRAMEWORKS).toBeDefined();
    expect(mod.getMappingsForFramework).toBeTypeOf('function');
    expect(mod.checkCompliance).toBeTypeOf('function');
    expect(mod.checkAllFrameworks).toBeTypeOf('function');
    expect(mod.getAllControlIds).toBeTypeOf('function');
  });

  it('main index re-exports core and builders', async () => {
    const mod = await import('./index.js');
    // Core exports
    expect(mod.API_VERSION).toBeDefined();
    expect(mod.validate).toBeTypeOf('function');
    // Builder exports
    expect(mod.PipelineBuilder).toBeTypeOf('function');
    expect(mod.parseBuilderManifest).toBeTypeOf('function');
  });
});
