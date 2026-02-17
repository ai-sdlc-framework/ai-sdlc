import { describe, it, expect } from 'vitest';
import * as barrel from './index.js';

describe('orchestrator barrel exports', () => {
  // Core orchestration
  it('exports loadConfig', () => {
    expect(barrel.loadConfig).toBeTypeOf('function');
  });
  it('exports loadConfigAsync', () => {
    expect(barrel.loadConfigAsync).toBeTypeOf('function');
  });
  it('exports executePipeline', () => {
    expect(barrel.executePipeline).toBeTypeOf('function');
  });
  it('exports executeFixCI', () => {
    expect(barrel.executeFixCI).toBeTypeOf('function');
  });
  it('exports startWatch', () => {
    expect(barrel.startWatch).toBeTypeOf('function');
  });
  it('exports validateIssue', () => {
    expect(barrel.validateIssue).toBeTypeOf('function');
  });
  it('exports validateAgentOutput', () => {
    expect(barrel.validateAgentOutput).toBeTypeOf('function');
  });
  it('exports createLogger', () => {
    expect(barrel.createLogger).toBeTypeOf('function');
  });

  // Shared utilities
  it('exports getGitHubConfig', () => {
    expect(barrel.getGitHubConfig).toBeTypeOf('function');
  });
  it('exports resolveRepoRoot', () => {
    expect(barrel.resolveRepoRoot).toBeTypeOf('function');
  });
  it('exports createPipelineMemory', () => {
    expect(barrel.createPipelineMemory).toBeTypeOf('function');
  });

  // Security
  it('exports createPipelineSecurity', () => {
    expect(barrel.createPipelineSecurity).toBeTypeOf('function');
  });
  it('exports checkKillSwitch', () => {
    expect(barrel.checkKillSwitch).toBeTypeOf('function');
  });

  // Subsystems
  it('exports createPipelineProvenance', () => {
    expect(barrel.createPipelineProvenance).toBeTypeOf('function');
  });
  it('exports createPipelineAdmission', () => {
    expect(barrel.createPipelineAdmission).toBeTypeOf('function');
  });
  it('exports createPipelineMetricStore', () => {
    expect(barrel.createPipelineMetricStore).toBeTypeOf('function');
  });
  it('exports createPipelineDiscovery', () => {
    expect(barrel.createPipelineDiscovery).toBeTypeOf('function');
  });
  it('exports createPipelineOrchestration', () => {
    expect(barrel.createPipelineOrchestration).toBeTypeOf('function');
  });

  // Reconcilers
  it('exports createPipelineReconciler', () => {
    expect(barrel.createPipelineReconciler).toBeTypeOf('function');
  });
  it('exports createGateReconciler', () => {
    expect(barrel.createGateReconciler).toBeTypeOf('function');
  });
  it('exports createAutonomyReconciler', () => {
    expect(barrel.createAutonomyReconciler).toBeTypeOf('function');
  });

  // Adapters
  it('exports createPipelineAdapterRegistry', () => {
    expect(barrel.createPipelineAdapterRegistry).toBeTypeOf('function');
  });
  it('exports resolveInfrastructure', () => {
    expect(barrel.resolveInfrastructure).toBeTypeOf('function');
  });

  // Runners
  it('exports ClaudeCodeRunner', () => {
    expect(barrel.ClaudeCodeRunner).toBeTypeOf('function');
  });
  it('exports GitHubActionsRunner as backward-compat alias', () => {
    expect(barrel.GitHubActionsRunner).toBeTypeOf('function');
    expect(barrel.GitHubActionsRunner).toBe(barrel.ClaudeCodeRunner);
  });

  // State store
  it('exports StateStore', () => {
    expect(barrel.StateStore).toBeTypeOf('function');
  });

  // Orchestrator class
  it('exports Orchestrator', () => {
    expect(barrel.Orchestrator).toBeTypeOf('function');
  });

  // Defaults
  it('exports DEFAULT_CONFIG_DIR_NAME', () => {
    expect(barrel.DEFAULT_CONFIG_DIR_NAME).toBeTypeOf('string');
  });
  it('exports DEFAULT_PR_FOOTER', () => {
    expect(barrel.DEFAULT_PR_FOOTER).toBeTypeOf('string');
  });

  // Extended modules
  it('exports createFileAuditLog', () => {
    expect(barrel.createFileAuditLog).toBeTypeOf('function');
  });
  it('exports checkFrameworkCompliance', () => {
    expect(barrel.checkFrameworkCompliance).toBeTypeOf('function');
  });
  it('exports getPipelineTracer', () => {
    expect(barrel.getPipelineTracer).toBeTypeOf('function');
  });

  // Policy evaluators
  it('exports evaluatePipelineGate', () => {
    expect(barrel.evaluatePipelineGate).toBeTypeOf('function');
  });
  it('exports scorePipelineComplexity', () => {
    expect(barrel.scorePipelineComplexity).toBeTypeOf('function');
  });

  // Notifications
  it('exports renderTemplate', () => {
    expect(barrel.renderTemplate).toBeTypeOf('function');
  });

  // Analysis module
  it('exports analyzeCodebase', () => {
    expect(barrel.analyzeCodebase).toBeTypeOf('function');
  });
  it('exports buildCodebaseContext', () => {
    expect(barrel.buildCodebaseContext).toBeTypeOf('function');
  });
  it('exports formatContextForPrompt', () => {
    expect(barrel.formatContextForPrompt).toBeTypeOf('function');
  });
  it('exports walkFiles', () => {
    expect(barrel.walkFiles).toBeTypeOf('function');
  });
  it('exports detectModules', () => {
    expect(barrel.detectModules).toBeTypeOf('function');
  });
  it('exports parseImports', () => {
    expect(barrel.parseImports).toBeTypeOf('function');
  });
  it('exports buildModuleGraph', () => {
    expect(barrel.buildModuleGraph).toBeTypeOf('function');
  });
  it('exports detectConventions', () => {
    expect(barrel.detectConventions).toBeTypeOf('function');
  });
  it('exports detectPatterns', () => {
    expect(barrel.detectPatterns).toBeTypeOf('function');
  });
  it('exports analyzeHotspots', () => {
    expect(barrel.analyzeHotspots).toBeTypeOf('function');
  });
  it('exports computeComplexityScore', () => {
    expect(barrel.computeComplexityScore).toBeTypeOf('function');
  });

  // Check runs
  it('exports createCheckRun', () => {
    expect(barrel.createCheckRun).toBeTypeOf('function');
  });
  it('exports reportGateCheckRuns', () => {
    expect(barrel.reportGateCheckRuns).toBeTypeOf('function');
  });

  // Analysis defaults
  it('exports DEFAULT_ANALYSIS_INCLUDE', () => {
    expect(barrel.DEFAULT_ANALYSIS_INCLUDE).toBeInstanceOf(Array);
  });
  it('exports DEFAULT_GIT_HISTORY_DAYS', () => {
    expect(barrel.DEFAULT_GIT_HISTORY_DAYS).toBeTypeOf('number');
  });
  it('exports DEFAULT_HOTSPOT_THRESHOLD', () => {
    expect(barrel.DEFAULT_HOTSPOT_THRESHOLD).toBeTypeOf('number');
  });

  // New defaults (Sprint 1)
  it('exports DEFAULT_LINT_COMMAND', () => {
    expect('DEFAULT_LINT_COMMAND' in barrel).toBe(true);
  });
  it('exports DEFAULT_FORMAT_COMMAND', () => {
    expect('DEFAULT_FORMAT_COMMAND' in barrel).toBe(true);
  });
  it('exports DEFAULT_COMMIT_MESSAGE_TEMPLATE', () => {
    expect(barrel.DEFAULT_COMMIT_MESSAGE_TEMPLATE).toBeTypeOf('string');
  });
  it('exports DEFAULT_COMMIT_CO_AUTHOR', () => {
    expect(barrel.DEFAULT_COMMIT_CO_AUTHOR).toBeTypeOf('string');
  });
  it('exports DEFAULT_OPENAI_API_URL', () => {
    expect(barrel.DEFAULT_OPENAI_API_URL).toBeTypeOf('string');
  });
  it('exports DEFAULT_OPENAI_MODEL', () => {
    expect(barrel.DEFAULT_OPENAI_MODEL).toBeTypeOf('string');
  });
  it('exports DEFAULT_ANTHROPIC_API_URL', () => {
    expect(barrel.DEFAULT_ANTHROPIC_API_URL).toBeTypeOf('string');
  });
  it('exports DEFAULT_ANTHROPIC_MODEL', () => {
    expect(barrel.DEFAULT_ANTHROPIC_MODEL).toBeTypeOf('string');
  });
  it('exports DEFAULT_GENERIC_LLM_MODEL', () => {
    expect(barrel.DEFAULT_GENERIC_LLM_MODEL).toBeTypeOf('string');
  });
  it('exports DEFAULT_LLM_TIMEOUT_MS', () => {
    expect(barrel.DEFAULT_LLM_TIMEOUT_MS).toBeTypeOf('number');
  });
  it('exports DEFAULT_LLM_MAX_TOKENS', () => {
    expect(barrel.DEFAULT_LLM_MAX_TOKENS).toBeTypeOf('number');
  });
  it('exports DEFAULT_LLM_SYSTEM_PROMPT', () => {
    expect(barrel.DEFAULT_LLM_SYSTEM_PROMPT).toBeTypeOf('string');
  });
  it('exports DEFAULT_DOCKER_IMAGE', () => {
    expect(barrel.DEFAULT_DOCKER_IMAGE).toBeTypeOf('string');
  });
  it('exports DEFAULT_WORKFLOW_FILE', () => {
    expect(barrel.DEFAULT_WORKFLOW_FILE).toBeTypeOf('string');
  });
  it('exports DEFAULT_LABEL_TO_SKILL_MAP', () => {
    expect(barrel.DEFAULT_LABEL_TO_SKILL_MAP).toBeTypeOf('object');
  });
  it('exports DEFAULT_ANALYSIS_CACHE_TTL_MS', () => {
    expect(barrel.DEFAULT_ANALYSIS_CACHE_TTL_MS).toBeTypeOf('number');
  });
});
