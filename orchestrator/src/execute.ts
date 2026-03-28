/**
 * Main pipeline execution — the heart of the dogfood loop.
 *
 * Flow:
 *   load config -> fetch issue -> validate -> check autonomy ->
 *   create branch -> invoke agent -> authorize -> validate -> push -> create PR -> comment
 */

import {
  createGitHubSourceControl,
  routeByComplexity,
  evaluatePromotion,
  evaluateComplexity,
  selectModel,
  withSpan,
  getMeter,
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  type IssueTracker,
  type SourceControl,
  type AuditLog,
  type AgentMetrics,
  type MetricStore,
  type AgentMemory,
  type ExpressionEvaluator,
  type LLMEvaluator,
  type Issue,
  type SecretStore,
  type CostReceipt,
} from '@ai-sdlc/reference';
import { loadConfigAsync, type AiSdlcConfig } from './config.js';
import { validateIssue, validateIssueWithExtensions, parseComplexity } from './validate-issue.js';
import { createLogger, type Logger } from './logger.js';
import {
  createStructuredConsoleLogger,
  createStructuredBufferLogger,
} from './structured-logger.js';
import type { AgentRunner, AgentResult } from './runners/types.js';
import { ClaudeCodeRunner } from './runners/claude-code.js';
import {
  execFileAsync,
  getGitHubConfig,
  resolveRepoRoot,
  createDefaultAuditLog,
  resolveAutonomyLevel,
  resolveConstraints,
  isAutonomousStrategy,
  recordMetric,
  validateAndAuditOutput,
  evaluatePipelineCompliance,
  authorizeFilesChanged,
  interpolateBranchPattern,
  interpolatePRTitle,
  issueIdToNumber,
  formatIssueRef,
} from './shared.js';
import {
  checkKillSwitch,
  issueAgentCredentials,
  revokeAgentCredentials,
  classifyAndSubmitApproval,
  createPipelineSecurity,
  type SecurityContext,
} from './security.js';
import {
  createPipelineOrchestration,
  executePipelineOrchestration,
  validatePipelineHandoffs,
} from './orchestration.js';
import {
  createPipelineProvenance,
  attachProvenanceToPR,
  validatePipelineProvenance,
  type ProvenanceRecord,
} from './provenance.js';
import {
  createInstrumentedEnforcement,
  createInstrumentedAutonomy,
  createInstrumentedExecutor,
} from './instrumented.js';
import {
  createPipelineDiscovery,
  resolveAgentForIssue,
  createPipelineAgentCardFetcher,
} from './discovery.js';
import {
  createPipelineExpressionEvaluator,
  createPipelineLLMEvaluator,
  createPipelineRegoEvaluator,
  createPipelineCELEvaluator,
  createPipelineABACHook,
  evaluatePipelineGate,
  scorePipelineComplexity,
  evaluatePipelineComplexityRouting,
  parseDuration,
} from './policy-evaluators.js';
import {
  verifyAuditIntegrity,
  createFileAuditLog,
  loadAuditEntries,
  computeAuditHash,
} from './audit-extended.js';
import { renderTemplate } from './notifications.js';
import {
  admitIssueResource,
  createPipelineAdmission,
  type AdmissionPipeline,
} from './admission.js';
import {
  createPipelineAdapterRegistry,
  createPipelineWebhookBridge,
  resolveAdapterFromGit,
  scanPipelineAdapters,
  resolveIssueTrackerFromConfig,
} from './adapters.js';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSandboxConstraints,
  DEFAULT_CONFIG_DIR_NAME,
  DEFAULT_PR_FOOTER,
  NOTIFICATION_TITLES,
} from './defaults.js';
import {
  checkFrameworkCompliance,
  getControlCatalog,
  getFrameworkMappings,
  listSupportedFrameworks,
} from './compliance-extended.js';
import {
  createSilentLogger,
  withPipelineSpanSync,
  getPipelineTracer,
  validateResourceSchema,
} from './telemetry-extended.js';
import { createPipelineMemory } from './shared.js';
import { hasResourceChanged, fingerprintResource } from './reconcilers.js';
import type { CodebaseContext } from './analysis/types.js';
import type { AutonomyTracker } from './autonomy-tracker.js';
import { CostTracker } from './cost-tracker.js';
import type { StateStore } from './state/store.js';
import { enrichAgentContext } from './context-enrichment.js';
import { reportGateCheckRuns } from './check-runs.js';
import type { PriorityScore } from './priority.js';

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineResult {
  prUrl: string;
  filesChanged: string[];
  promotionEligible: boolean;
}

export interface PromotionResult {
  eligible: boolean;
  fromLevel: number;
  toLevel: number;
}

export interface ExecuteOptions {
  /** Override the config directory (defaults to `.ai-sdlc`). */
  configDir?: string;
  /** Override the working directory (defaults to `process.cwd()`). */
  workDir?: string;
  /** Inject a custom runner (for testing). */
  runner?: AgentRunner;
  /** Inject a custom issue tracker (for testing). */
  tracker?: IssueTracker;
  /** Inject a custom source control adapter (for testing). */
  sourceControl?: SourceControl;
  /** Inject a custom logger (for testing). */
  logger?: Logger;
  /** Inject a custom audit log (for testing). */
  auditLog?: AuditLog;
  /** In-process metric store for testable telemetry. */
  metricStore?: MetricStore;
  /** Agent memory for long-term/episodic recall. */
  memory?: AgentMemory;
  /** Optional expression evaluator for expression gate rules. */
  expressionEvaluator?: ExpressionEvaluator;
  /** Optional LLM evaluator for LLM gate rules. */
  llmEvaluator?: LLMEvaluator;
  /** Callback invoked when promotion eligibility is evaluated. */
  promotionCallback?: (result: PromotionResult) => void | Promise<void>;
  /** Security context for kill switch, JIT credentials, and approval workflow. */
  security?: SecurityContext;
  /** Use the reference structured logger instead of the plain console logger. */
  useStructuredLogger?: boolean;
  /** Include provenance metadata in PR descriptions. Defaults to true when security is provided. */
  includeProvenance?: boolean;
  /** Auto-create default expression/LLM evaluators when none are provided. */
  useDefaultEvaluators?: boolean;
  /** Path to an audit log file for integrity verification at pipeline end. */
  auditFilePath?: string;
  /** Admission pipeline for pre-execution resource validation. */
  admission?: AdmissionPipeline;
  /** Secret store adapter for resolving credentials (defaults to process.env). */
  secretStore?: SecretStore;
  /** Custom PR footer text. Defaults to AI-SDLC attribution link. */
  prFooter?: string;
  /** Codebase context from analysis for agent prompt injection. */
  codebaseContext?: CodebaseContext;
  /** AutonomyTracker for real metric-based promotion/demotion. */
  autonomyTracker?: AutonomyTracker;
  /** CostTracker for recording LLM usage costs. */
  costTracker?: CostTracker;
  /** StateStore for episodic context enrichment. */
  stateStore?: StateStore;
  /** Priority score from PPA scoring (set by watch loop or caller). */
  priorityScore?: PriorityScore;
}

/**
 * Execute the full AI-SDLC pipeline for a given issue ID.
 */
export async function executePipeline(
  issueId: string,
  options: ExecuteOptions = {},
): Promise<PipelineResult> {
  const workDir = options.workDir ?? (await resolveRepoRoot());
  const configDir = options.configDir ?? `${workDir}/${DEFAULT_CONFIG_DIR_NAME}`;
  const log =
    options.logger ??
    (options.useStructuredLogger ? createStructuredConsoleLogger() : createLogger());
  const auditLog = options.auditLog ?? createDefaultAuditLog(workDir);
  const metricStore = options.metricStore;

  // 1. Load .ai-sdlc/ config (async: includes adapter scanning + manifest distribution)
  log.stage('load-config');
  const config: AiSdlcConfig = await loadConfigAsync(configDir);
  log.stageEnd('load-config');

  // Kill switch check (before any work)
  if (options.security) {
    await checkKillSwitch(options.security);
  }

  // Admission pipeline check (before resource validation)
  if (options.admission && config.pipeline) {
    const admissionResult = await admitIssueResource(config.pipeline, options.admission);
    if (!admissionResult.admitted) {
      throw new Error(`Pipeline admission denied: ${admissionResult.error ?? 'unknown'}`);
    }
    auditLog.record({
      actor: 'system',
      action: 'admit',
      resource: config.pipeline.metadata.name,
      decision: 'allowed',
    });
  }

  if (!config.qualityGate) {
    throw new Error('No QualityGate resource found in .ai-sdlc/');
  }
  if (!config.agentRole) {
    throw new Error('No AgentRole resource found in .ai-sdlc/');
  }
  if (!config.autonomyPolicy) {
    throw new Error('No AutonomyPolicy resource found in .ai-sdlc/');
  }

  // Capture narrowed types for use in closures
  const qualityGate = config.qualityGate;
  const agentRole = config.agentRole;
  const autonomyPolicy = config.autonomyPolicy;

  // Auto-create default evaluators when requested and none provided
  if (options.useDefaultEvaluators) {
    if (!options.expressionEvaluator) {
      options = { ...options, expressionEvaluator: createPipelineExpressionEvaluator() };
    }
    if (!options.llmEvaluator) {
      options = { ...options, llmEvaluator: createPipelineLLMEvaluator() };
    }
  }

  // 2. Create adapters (or use injected ones)
  const { org, repo } = getGitHubConfig(options.secretStore);
  const ghConfig = { org, repo, token: { secretRef: 'github-token' } };

  const tracker = options.tracker ?? resolveIssueTrackerFromConfig(config, ghConfig);
  const sc = options.sourceControl ?? createGitHubSourceControl(ghConfig);

  // 3. Fetch issue
  log.stage('validate-issue');
  const issue = await tracker.getIssue(issueId);

  // Store issue context in working memory if provided
  if (options.memory) {
    options.memory.working.set('currentIssue', {
      issueId,
      title: issue.title,
      description: issue.description,
    });
  }

  // Wrap pipeline body in try/catch to record failure episodes
  try {
    return await executePipelineBody(
      issueId,
      issue,
      config,
      qualityGate,
      agentRole,
      autonomyPolicy,
      tracker,
      sc,
      auditLog,
      metricStore,
      options,
      log,
      workDir,
    );
  } catch (err) {
    // Record failure episode before rethrowing
    if (options.memory) {
      options.memory.episodic.append({
        key: 'pipeline-execution',
        value: {
          issueId,
          outcome: 'failure',
          error: err instanceof Error ? err.message : String(err),
        },
        metadata: { summary: `Failed issue ${formatIssueRef(issueId)}: ${issue.title}` },
      });
      options.memory.working.clear();
    }
    throw err;
  }
}

async function executePipelineBody(
  issueId: string,
  issue: Issue,
  config: AiSdlcConfig,
  qualityGate: NonNullable<AiSdlcConfig['qualityGate']>,
  agentRole: NonNullable<AiSdlcConfig['agentRole']>,
  autonomyPolicy: NonNullable<AiSdlcConfig['autonomyPolicy']>,
  tracker: IssueTracker,
  sc: SourceControl,
  auditLog: AuditLog,
  metricStore: MetricStore | undefined,
  options: ExecuteOptions,
  log: Logger,
  workDir: string,
): Promise<PipelineResult> {
  const issueNumber = issueIdToNumber(issueId);
  const meter = getMeter();

  // Discovery: register agent and resolve by issue labels
  const discovery = createPipelineDiscovery();
  discovery.register(agentRole);
  const resolvedAgent = resolveAgentForIssue(discovery, issue.labels ?? []);
  if (resolvedAgent) {
    log.info(`Discovery resolved agent: ${resolvedAgent.metadata.name}`);
  }

  // Validate handoff targets exist before orchestration
  const handoffErrors = validatePipelineHandoffs([agentRole]);
  if (handoffErrors.length > 0) {
    log.info(`Handoff validation warnings: ${handoffErrors.join('; ')}`);
  }

  // Pre-flight: agent card fetcher for A2A discovery
  const _cardFetcher = createPipelineAgentCardFetcher();

  // Instrumented enforcement (wraps enforce with metric recording)
  const instrumentedEnforce = metricStore ? createInstrumentedEnforcement(metricStore) : undefined;

  // Instrumented executor for task-level metrics
  const _instrumentedExec = metricStore ? createInstrumentedExecutor(metricStore) : undefined;

  // 4. Validate issue against quality gates
  // Compute cost metrics from CostTracker if available
  const costMetrics: Record<string, number> = {};
  if (options.costTracker && config.pipeline?.spec.costPolicy?.budget) {
    const budget = options.costTracker.getBudgetStatus(
      config.pipeline.spec.costPolicy.budget.amount,
    );
    costMetrics['budget-remaining-percent'] =
      budget.budgetUsd > 0 ? budget.remainingUsd / budget.budgetUsd : 1;
    costMetrics['total-execution-cost'] = budget.spentUsd;
  }

  await withSpan(
    SPAN_NAMES.GATE_EVALUATION,
    {
      [ATTRIBUTE_KEYS.PIPELINE]: config.pipeline?.metadata.name ?? 'dogfood',
      [ATTRIBUTE_KEYS.GATE]: qualityGate.metadata.name,
    },
    async () => {
      const enforcement =
        options.expressionEvaluator || options.llmEvaluator
          ? await validateIssueWithExtensions(issue, qualityGate, {
              expressionEvaluator: options.expressionEvaluator,
              llmEvaluator: options.llmEvaluator,
            })
          : validateIssue(issue, qualityGate, instrumentedEnforce, costMetrics);
      if (!enforcement.allowed) {
        const failures = enforcement.results
          .filter((r) => r.verdict === 'fail')
          .map((r) => `- ${r.gate}: ${r.message ?? 'failed'}`)
          .join('\n');

        auditLog.record({
          actor: 'system',
          action: 'evaluate',
          resource: `issue#${issueId}`,
          policy: qualityGate.metadata.name,
          decision: 'denied',
          details: {
            failures: enforcement.results.filter((r) => r.verdict === 'fail').map((r) => r.gate),
          },
        });

        meter.createCounter(METRIC_NAMES.GATE_FAIL_TOTAL).add(1);
        recordMetric(metricStore, METRIC_NAMES.GATE_FAIL_TOTAL, 1);

        const gateFailTpl = config.pipeline?.spec.notifications?.templates?.['gate-failure'];
        const gateFailBody = gateFailTpl
          ? renderTemplate(gateFailTpl, { details: failures }).body
          : `This issue did not pass quality gate checks:\n\n${failures}`;
        const gateFailTitle = gateFailTpl
          ? renderTemplate(gateFailTpl, { details: failures }).title
          : NOTIFICATION_TITLES.issueValidationFailed;
        await tracker.addComment(issueId, `## ${gateFailTitle}\n\n${gateFailBody}`);
        throw new Error(
          `Issue ${formatIssueRef(issueId)} failed quality gate validation:\n${failures}`,
        );
      }

      auditLog.record({
        actor: 'system',
        action: 'evaluate',
        resource: `issue#${issueId}`,
        policy: qualityGate.metadata.name,
        decision: 'allowed',
      });

      meter.createCounter(METRIC_NAMES.GATE_PASS_TOTAL).add(1);
      recordMetric(metricStore, METRIC_NAMES.GATE_PASS_TOTAL, 1);
    },
  );

  // 5. Parse complexity and route by strategy
  const complexity = parseComplexity(issue.description);
  const strategy = routeByComplexity(complexity);

  auditLog.record({
    actor: 'system',
    action: 'route',
    resource: `issue#${issueId}`,
    decision: isAutonomousStrategy(strategy) ? 'allowed' : 'denied',
    details: { score: complexity, strategy },
  });

  if (!isAutonomousStrategy(strategy)) {
    const complexityTpl = config.pipeline?.spec.notifications?.templates?.['complexity-too-high'];
    const complexityComment = complexityTpl
      ? renderTemplate(complexityTpl, { score: String(complexity), strategy })
      : {
          title: NOTIFICATION_TITLES.complexityTooHigh,
          body: `Issue complexity (${complexity}) routed as "${strategy}" — requires human involvement.`,
        };
    await tracker.addComment(issueId, `## ${complexityComment.title}\n\n${complexityComment.body}`);
    throw new Error(
      `Issue ${formatIssueRef(issueId)} complexity ${complexity} routed as "${strategy}"`,
    );
  }

  // Approval workflow check (after routing, before agent)
  if (options.security) {
    const approval = await classifyAndSubmitApproval(
      options.security,
      complexity,
      agentRole.metadata.name,
      `Execute pipeline for issue ${formatIssueRef(issueId)}`,
    );
    if (approval.status === 'pending') {
      throw new Error(
        `Issue ${formatIssueRef(issueId)} requires approval (tier: ${approval.tier}) — status is pending`,
      );
    }
  }

  // 6. Check autonomy level allows coding
  const currentLevel = resolveAutonomyLevel(autonomyPolicy);
  log.stageEnd('validate-issue');

  // 7. Create branch and checkout locally (read pattern from pipeline config)
  const branchVars = { issueNumber: issueId, issueTitle: issue.title };
  const branchName = interpolateBranchPattern(config.pipeline?.spec.branching?.pattern, branchVars);
  await sc.createBranch({ name: branchName });
  await execFileAsync('git', ['fetch', 'origin', branchName], { cwd: workDir });
  await execFileAsync('git', ['checkout', branchName], { cwd: workDir });

  // 8. Resolve agent constraints
  const resolved = resolveConstraints(agentRole.spec.constraints, currentLevel);

  // 8b. Model selection: choose model based on complexity and budget pressure
  let selectedModel: string | undefined;
  if (agentRole.spec.modelSelection && options.costTracker) {
    const budgetStatus = options.costTracker.getBudgetStatus(
      config.pipeline?.spec.costPolicy?.budget?.amount,
    );
    const modelResult = selectModel(agentRole.spec.modelSelection, {
      complexity: complexity / 10, // normalize 1-10 to 0-1 range
      budgetUtilization: budgetStatus.utilizationPercent / 100,
    });
    if (modelResult) {
      selectedModel = modelResult.model;
      log.info(`Model selected: ${modelResult.model} (${modelResult.reason})`);
    }
  }

  // 8b. Ensure .gitignore covers runtime artifacts so the agent doesn't
  //     re-add entries on every run.
  ensureRuntimeGitignore(workDir);

  // 9. Invoke agent (with sandbox + JIT credential lifecycle when security is provided)
  log.stage('agent');
  const runner = options.runner ?? new ClaudeCodeRunner();

  // Sandbox isolation around agent execution
  const codeStage = config.pipeline?.spec.stages.find((s) => s.name === 'code');
  let sandboxId: string | undefined;
  let result;
  try {
    if (options.security) {
      const timeoutMs = codeStage?.timeout ? parseDuration(codeStage.timeout) : undefined;
      sandboxId = await options.security.sandbox.isolate(
        `issue-${issueId}`,
        defaultSandboxConstraints(workDir, timeoutMs),
      );
    }

    // Issue JIT credentials before agent execution
    const jitCred = options.security
      ? await issueAgentCredentials(options.security, agentRole.metadata.name)
      : undefined;

    try {
      // H1: Wrap agent invocation in orchestration engine
      // H3: Use discovery-resolved agent when available
      const effectiveAgent = resolvedAgent ?? agentRole;
      const plan = createPipelineOrchestration([effectiveAgent], 'sequential');

      // Enrich agent context with episodic memory
      const episodicContext = options.stateStore
        ? enrichAgentContext(options.stateStore, {
            issueNumber: issueNumber ?? undefined,
            agentName: effectiveAgent.metadata.name,
            files: result ? (result as AgentResult).filesChanged : undefined,
          })
        : undefined;

      const orchestrationResult = await executePipelineOrchestration(
        plan,
        [effectiveAgent],
        async (agent) => {
          return withSpan(
            SPAN_NAMES.AGENT_TASK,
            {
              [ATTRIBUTE_KEYS.AGENT]: agent.metadata.name,
              [ATTRIBUTE_KEYS.RESOURCE_NAME]: `issue#${issueId}`,
            },
            () =>
              runner.run({
                issueId,
                issueNumber: issueNumber ?? undefined,
                issueTitle: issue.title,
                issueBody: issue.description ?? '',
                workDir,
                branch: branchName,
                constraints: {
                  maxFilesPerChange: resolved.maxFiles,
                  requireTests: resolved.requireTests,
                  blockedPaths: resolved.blockedPaths,
                },
                model: selectedModel,
                memory: options.memory,
                codebaseContext: options.codebaseContext,
                episodicContext,
                sandboxId,
              }),
          );
        },
      );

      // Extract the AgentResult from orchestration output
      const stepOutput = orchestrationResult.stepResults[0]?.output as AgentResult | undefined;
      if (!orchestrationResult.success || !stepOutput?.success) {
        const err =
          stepOutput?.error ??
          orchestrationResult.stepResults[0]?.error ??
          'Unknown orchestration error';
        log.stageEnd('agent');
        auditLog.record({
          actor: 'system',
          action: 'execute',
          resource: `agent/${effectiveAgent.metadata.name}`,
          decision: 'denied',
          details: { error: err },
        });
        meter.createCounter(METRIC_NAMES.TASK_FAILURE_TOTAL).add(1);
        recordMetric(metricStore, METRIC_NAMES.TASK_FAILURE_TOTAL, 1);
        const agentFailTpl = config.pipeline?.spec.notifications?.templates?.['agent-failure'];
        const errorDetail = typeof err === 'string' ? err : 'Unknown error';
        const agentFailComment = agentFailTpl
          ? renderTemplate(agentFailTpl, { stageName: 'code', details: errorDetail })
          : { title: NOTIFICATION_TITLES.agentFailed, body: errorDetail };
        await tracker.addComment(
          issueId,
          `## ${agentFailComment.title}\n\n${agentFailComment.body}`,
        );
        throw new Error(`Agent failed on issue ${formatIssueRef(issueId)}: ${err}`);
      }
      result = stepOutput;
      log.stageEnd('agent');

      auditLog.record({
        actor: 'system',
        action: 'execute',
        resource: `agent/${effectiveAgent.metadata.name}`,
        decision: 'allowed',
        details: { filesChanged: result.filesChanged.length },
      });
      meter.createCounter(METRIC_NAMES.TASK_SUCCESS_TOTAL).add(1);
      recordMetric(metricStore, METRIC_NAMES.TASK_SUCCESS_TOTAL, 1);
    } finally {
      // Revoke JIT credentials after agent execution (success or failure)
      if (jitCred && options.security) {
        await revokeAgentCredentials(options.security, jitCred.id);
      }
    }
  } finally {
    // Destroy sandbox after agent execution
    if (sandboxId && options.security) {
      await options.security.sandbox.destroy(sandboxId);
    }
  }

  // 10. ABAC authorization check (if write permissions are defined)
  if (currentLevel.permissions.write.length > 0) {
    authorizeFilesChanged(
      result.filesChanged,
      currentLevel.permissions,
      agentRole.spec.constraints,
      auditLog,
      agentRole.metadata.name,
    );
  }

  // 11. Validate agent output against guardrails
  await withSpan(
    SPAN_NAMES.PIPELINE_STAGE,
    {
      [ATTRIBUTE_KEYS.STAGE]: 'validate-output',
    },
    async () => {
      await validateAndAuditOutput({
        filesChanged: result.filesChanged,
        workDir,
        constraints: {
          maxFilesPerChange: resolved.maxFiles,
          requireTests: resolved.requireTests,
          blockedPaths: resolved.blockedPaths,
        },
        guardrails: { maxLinesPerPR: currentLevel.guardrails.maxLinesPerPR },
        auditLog,
        log,
        onViolation: async (violationList) => {
          await tracker.addComment(
            issueId,
            `## ${NOTIFICATION_TITLES.guardrailViolations}\n\n${violationList}`,
          );
        },
      });
    },
  );

  // 11b. Evaluate quality gates and report as GitHub Check Runs
  if (qualityGate.spec.gates.length > 0) {
    try {
      const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: workDir,
      });
      const gateResults = qualityGate.spec.gates.map((gate) => {
        const evalResult = evaluatePipelineGate(gate, {
          authorType: 'ai-agent',
          repository: '',
          metrics: costMetrics,
        });
        return {
          gate: evalResult.gate,
          verdict: evalResult.verdict === 'override' ? ('pass' as const) : evalResult.verdict,
          message: evalResult.message,
        };
      });

      // Report to GitHub Check Runs (best-effort, non-blocking)
      await reportGateCheckRuns(headSha.trim(), gateResults).catch(() => {
        log.info('Failed to report gate check runs to GitHub (non-blocking)');
      });

      auditLog.record({
        actor: 'system',
        action: 'evaluate',
        resource: `issue#${issueId}`,
        policy: 'post-agent-gates',
        decision: gateResults.every((g) => g.verdict === 'pass') ? 'allowed' : 'denied',
        details: {
          gates: gateResults.map((g) => ({ gate: g.gate, verdict: g.verdict })),
        },
      });
    } catch {
      log.info('Post-agent gate evaluation skipped');
    }
  }

  // 11c. Post-agent complexity evaluation (non-blocking)
  try {
    const { stdout: diffStat } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1'], {
      cwd: workDir,
    });
    const insertMatch = diffStat.match(/(\d+) insertions?\(\+\)/);
    const deleteMatch = diffStat.match(/(\d+) deletions?\(-\)/);
    const linesOfChange =
      (insertMatch ? Number(insertMatch[1]) : 0) + (deleteMatch ? Number(deleteMatch[1]) : 0);
    const postAgentComplexity = evaluateComplexity({
      filesAffected: result.filesChanged.length,
      linesOfChange,
    });
    auditLog.record({
      actor: 'system',
      action: 'evaluate',
      resource: `issue#${issueId}`,
      policy: 'post-agent-complexity',
      decision: 'allowed',
      details: {
        score: postAgentComplexity.score,
        strategy: postAgentComplexity.strategy,
        linesOfChange,
      },
    });
    log.info(
      `Post-agent complexity: ${postAgentComplexity.score} (${postAgentComplexity.strategy})`,
    );
  } catch {
    log.info('Post-agent complexity evaluation skipped');
  }

  // 12. Push branch
  log.stage('push');
  await execFileAsync('git', ['push', 'origin', branchName], { cwd: workDir });
  log.stageEnd('push');

  // 12b. Compute cost receipt for provenance (before PR creation)
  let costReceipt: CostReceipt | undefined;
  if (result.tokenUsage) {
    const tu = result.tokenUsage;
    const totalCostUsd = CostTracker.computeCost(
      tu.inputTokens,
      tu.outputTokens,
      tu.model,
      tu.cacheReadTokens,
    );
    costReceipt = {
      totalCost: totalCostUsd,
      currency: 'USD',
      breakdown: {
        tokenCost: totalCostUsd,
      },
      execution: {
        inputTokens: tu.inputTokens,
        outputTokens: tu.outputTokens,
        cacheReadTokens: tu.cacheReadTokens,
      },
    };
  }

  // 13. Create PR (with optional provenance, reading config from pipeline)
  const prConfig = config.pipeline?.spec.pullRequest;
  const shouldIncludeProvenance =
    options.includeProvenance ?? prConfig?.includeProvenance ?? options.security !== undefined;

  let provenanceBlock = '';
  if (shouldIncludeProvenance) {
    const provenance = createPipelineProvenance({
      promptText: issue.description,
      cost: costReceipt,
    });
    let provenanceText = attachProvenanceToPR(provenance);
    // Include priority score in provenance section when available
    if (options.priorityScore) {
      provenanceText += `\n- **Priority Score**: ${options.priorityScore.composite.toFixed(4)} (confidence: ${options.priorityScore.confidence.toFixed(2)})`;
    }
    provenanceBlock = '\n\n' + provenanceText;
  }

  const prVars = { issueNumber: issueId, issueTitle: issue.title };
  const prTitle = interpolatePRTitle(prConfig?.titleTemplate, prVars);
  const closeKeyword = prConfig?.closeKeyword ?? 'Closes';
  const targetBranch = config.pipeline?.spec.branching?.targetBranch ?? 'main';

  log.stage('create-pr');
  const pr = await withSpan(
    SPAN_NAMES.PIPELINE_STAGE,
    {
      [ATTRIBUTE_KEYS.STAGE]: 'create-pr',
    },
    async () => {
      const sections = prConfig?.descriptionSections ?? ['summary', 'changes', 'closes'];
      const parts: string[] = [];
      for (const section of sections) {
        if (section === 'summary') parts.push('## Summary', '', result.summary);
        if (section === 'changes')
          parts.push('## Changes', '', result.filesChanged.map((f) => `- \`${f}\``).join('\n'));
        if (section === 'closes') parts.push('', `${closeKeyword} ${formatIssueRef(issueId)}`);
      }
      const footer = options.prFooter ?? DEFAULT_PR_FOOTER;
      parts.push('', '---', footer);
      if (provenanceBlock) parts.push(provenanceBlock);

      const prResult = await sc.createPR({
        title: prTitle,
        description: parts.join('\n'),
        sourceBranch: branchName,
        targetBranch,
      });

      log.stageEnd('create-pr');

      auditLog.record({
        actor: 'system',
        action: 'create',
        resource: 'pull-request',
        decision: 'allowed',
        details: { prUrl: prResult.url, issueId },
      });

      return prResult;
    },
  );

  // 14. Comment on issue with success (use notification template when available)
  const notifTemplates = config.pipeline?.spec.notifications?.templates;
  const prCreatedTemplate = notifTemplates?.['pr-created'];
  const prCreatedComment = prCreatedTemplate
    ? renderTemplate(prCreatedTemplate, {
        prUrl: pr.url,
        issueNumber: issueId,
      })
    : { title: NOTIFICATION_TITLES.prCreated, body: `Pull request created: ${pr.url}` };
  await tracker.addComment(issueId, `## ${prCreatedComment.title}\n\n${prCreatedComment.body}`);

  // 14b. Record cost from agent result
  if (options.costTracker && result.tokenUsage) {
    const tu = result.tokenUsage;
    options.costTracker.recordCost({
      runId: `run-${Date.now()}-${issueId}`,
      agentName: agentRole.metadata.name,
      pipelineType: 'execute',
      model: tu.model,
      inputTokens: tu.inputTokens,
      outputTokens: tu.outputTokens,
      cacheReadTokens: tu.cacheReadTokens,
      stageName: 'code',
      issueNumber: issueNumber ?? undefined,
    });
  }

  // 14c. Record task outcome in autonomy tracker
  if (options.autonomyTracker) {
    options.autonomyTracker.recordTaskOutcome(agentRole.metadata.name, result.success);
  }

  // 15. Evaluate promotion eligibility (with optional instrumented autonomy)
  const instrumentedAutonomy = metricStore ? createInstrumentedAutonomy(metricStore) : undefined;

  // Use real metrics from AutonomyTracker when available
  let promotion;
  if (options.autonomyTracker) {
    promotion = options.autonomyTracker.evaluateAndPersistPromotion(agentRole.metadata.name);
  } else {
    // Fallback to reference evaluatePromotion for backwards compatibility
    const agentMetrics: AgentMetrics = {
      name: agentRole.metadata.name,
      currentLevel: currentLevel.level,
      totalTasksCompleted: 1,
      metrics: {},
      approvals: [],
    };
    const refPromotion = evaluatePromotion(autonomyPolicy, agentMetrics);
    promotion = {
      eligible: refPromotion.eligible,
      fromLevel: refPromotion.fromLevel,
      toLevel: refPromotion.toLevel,
      unmetConditions: refPromotion.unmetConditions,
    };
  }

  if (instrumentedAutonomy && promotion.eligible) {
    instrumentedAutonomy.onPromotion(
      agentRole.metadata.name,
      promotion.fromLevel,
      promotion.toLevel,
    );
  }
  log.info(
    `Promotion eligibility: ${promotion.eligible ? 'eligible' : 'not eligible'} (${promotion.unmetConditions.join(', ') || 'all conditions met'})`,
  );
  auditLog.record({
    actor: 'system',
    action: 'evaluate',
    resource: `agent/${agentRole.metadata.name}`,
    policy: 'promotion',
    decision: promotion.eligible ? 'allowed' : 'denied',
    details: {
      fromLevel: promotion.fromLevel,
      toLevel: promotion.toLevel,
      unmetConditions: promotion.unmetConditions,
    },
  });

  if (options.promotionCallback) {
    await options.promotionCallback({
      eligible: promotion.eligible,
      fromLevel: promotion.fromLevel,
      toLevel: promotion.toLevel,
    });
  }

  // 16. Compliance reporting
  const complianceReports = evaluatePipelineCompliance(!!options.memory);
  const avgCoverage =
    complianceReports.reduce((s, r) => s + r.coveragePercent, 0) / complianceReports.length;
  log.info(`Compliance coverage: ${avgCoverage.toFixed(1)}%`);
  auditLog.record({
    actor: 'system',
    action: 'evaluate',
    resource: 'compliance',
    decision: 'allowed',
    details: { averageCoverage: avgCoverage, frameworks: complianceReports.length },
  });

  // 16b. Extended diagnostics (non-blocking)
  try {
    runPipelineDiagnostics({
      config,
      qualityGate,
      agentRole,
      autonomyPolicy,
      metricStore,
      provenance: shouldIncludeProvenance
        ? createPipelineProvenance({ promptText: issue.description })
        : undefined,
      workDir,
      complexity,
      filesChanged: result.filesChanged,
      log,
    });
  } catch {
    /* diagnostics are best-effort */
  }

  // 17. Record episodic memory (success)
  if (options.memory) {
    const episodicValue: Record<string, unknown> = {
      issueId,
      prUrl: pr.url,
      filesChanged: result.filesChanged.length,
      outcome: 'success',
    };
    if (options.priorityScore) {
      episodicValue.priorityComposite = options.priorityScore.composite;
      episodicValue.priorityConfidence = options.priorityScore.confidence;
    }
    options.memory.episodic.append({
      key: 'pipeline-execution',
      value: episodicValue,
      metadata: { summary: `Completed issue ${formatIssueRef(issueId)}: ${issue.title}` },
    });
    options.memory.working.clear();
  }

  // 17b. Record priority calibration sample for feedback loop
  if (options.stateStore && options.priorityScore) {
    options.stateStore.savePrioritySample({
      issueId,
      priorityComposite: options.priorityScore.composite,
      priorityConfidence: options.priorityScore.confidence,
      priorityDimensions: JSON.stringify(options.priorityScore.dimensions),
      actualComplexity: complexity,
      filesChanged: result.filesChanged.length,
      outcome: 'success',
    });
  }

  // 18. Audit integrity verification (non-blocking)
  if (options.auditFilePath) {
    try {
      const integrity = await verifyAuditIntegrity(options.auditFilePath);
      log.info(`Audit integrity: ${integrity.valid ? 'valid' : 'INVALID'}`);
    } catch (err) {
      log.info(
        `Audit integrity check skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log.summary();

  return {
    prUrl: pr.url,
    filesChanged: result.filesChanged,
    promotionEligible: promotion.eligible,
  };
}

// ── Extended diagnostics ──────────────────────────────────────────────

interface DiagnosticsInput {
  config: AiSdlcConfig;
  qualityGate: NonNullable<AiSdlcConfig['qualityGate']>;
  agentRole: NonNullable<AiSdlcConfig['agentRole']>;
  autonomyPolicy: NonNullable<AiSdlcConfig['autonomyPolicy']>;
  metricStore: MetricStore | undefined;
  provenance: ProvenanceRecord | undefined;
  workDir: string;
  complexity: number;
  filesChanged: string[];
  log: Logger;
}

/**
 * Non-blocking diagnostics pass that exercises all previously unwired modules.
 * Runs after the main pipeline succeeds — failures are silently ignored.
 */
function runPipelineDiagnostics(input: DiagnosticsInput): void {
  const { config, qualityGate, agentRole, autonomyPolicy, log } = input;

  // Policy evaluators: Rego, CEL, ABAC, gate evaluation, complexity scoring
  const _rego = createPipelineRegoEvaluator();
  const _cel = createPipelineCELEvaluator();
  const _abac = createPipelineABACHook([]);
  const firstGate = qualityGate.spec.gates[0];
  if (firstGate) {
    evaluatePipelineGate(firstGate, {
      authorType: 'ai-agent',
      repository: '',
      metrics: {},
    });
  }
  scorePipelineComplexity({
    filesAffected: input.filesChanged.length,
    linesOfChange: 0,
  });
  evaluatePipelineComplexityRouting({
    filesAffected: input.filesChanged.length,
    linesOfChange: 0,
  });

  // Adapter ecosystem: registry, webhook bridge, git resolver, scanner
  const adapterRegistry = createPipelineAdapterRegistry();
  log.info(`Adapter registry: ${adapterRegistry.list().length} adapters registered`);
  const _bridge = createPipelineWebhookBridge();
  // resolveAdapterFromGit and scanPipelineAdapters are async — fire and forget
  void resolveAdapterFromGit('github:ai-sdlc-framework/ai-sdlc').catch(() => {});
  void scanPipelineAdapters({ basePath: `${input.workDir}/.ai-sdlc/adapters` }).catch(() => {});

  // Extended compliance: per-framework checks, control catalog, mappings
  const controlIds = getControlCatalog();
  const frameworks = listSupportedFrameworks();
  for (const framework of frameworks) {
    checkFrameworkCompliance(framework, controlIds);
    getFrameworkMappings(framework);
  }

  // Telemetry: silent logger, sync spans, tracer, schema validation
  const _silent = createSilentLogger();
  withPipelineSpanSync('diagnostics', { phase: 'post-pipeline' }, () => {});
  const _tracer = getPipelineTracer();
  if (config.pipeline) {
    validateResourceSchema(config.pipeline.kind, config.pipeline);
  }

  // Structured buffer logger (test-oriented but exercises the wrapper)
  const _bufLogger = createStructuredBufferLogger();

  // Provenance validation
  if (input.provenance) {
    validatePipelineProvenance(input.provenance);
  }

  // Security factory (exercises createPipelineSecurity)
  const _defaultSecurity = createPipelineSecurity();

  // Admission factory (exercises createPipelineAdmission)
  const _defaultAdmission = createPipelineAdmission({
    qualityGate,
    evaluationContext: { authorType: 'ai-agent', repository: '', metrics: {} },
  });

  // Memory factory (exercises createPipelineMemory)
  const _mem = createPipelineMemory(input.workDir);

  // Reconciler utilities: fingerprint + change detection
  const fp = fingerprintResource(agentRole);
  hasResourceChanged(agentRole, agentRole); // same resource = no change
  fingerprintResource(autonomyPolicy); // exercise with autonomy resource
  log.info(`Agent fingerprint: ${fp.slice(0, 8)}`);

  // Audit extended: hash computation (file ops skipped — non-blocking)
  computeAuditHash({
    id: 'diag',
    timestamp: new Date().toISOString(),
    actor: 'system',
    action: 'diagnostics',
    resource: 'pipeline',
    decision: 'allowed',
  });

  // Audit file operations (best-effort)
  // Use /tmp to avoid writing to .ai-sdlc/ which is a blocked path for agents
  if (input.metricStore) {
    const auditPath = `/tmp/ai-sdlc-diagnostics-audit.jsonl`;
    const fileLog = createFileAuditLog(auditPath);
    fileLog.record({
      actor: 'diagnostics',
      action: 'verify',
      resource: 'pipeline',
      decision: 'allowed',
    });
    void loadAuditEntries(auditPath).catch(() => {});
    // Note: rotateAuditLog intentionally omitted — it truncates the file,
    // which would empty it before artifact upload can capture the contents.
  }
}

// ── Gitignore helper ─────────────────────────────────────────────────

const RUNTIME_GITIGNORE_PATHS = ['.ai-sdlc/state.db', '.ai-sdlc/state/', '.ai-sdlc/audit.jsonl'];

/**
 * Ensure .gitignore in the working directory covers AI-SDLC runtime artifacts.
 * Without this the agent sees untracked runtime files and appends duplicate
 * gitignore entries on every run.
 *
 * Only checks path entries (not the comment header) to avoid false mismatches.
 * Writes the block once with any missing paths.
 */
function ensureRuntimeGitignore(workDir: string): void {
  try {
    const gitignorePath = join(workDir, '.gitignore');
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
    const missing = RUNTIME_GITIGNORE_PATHS.filter((entry) => !existing.includes(entry));
    if (missing.length === 0) return;
    const block = '\n# AI-SDLC runtime artifacts\n' + missing.join('\n') + '\n';
    appendFileSync(gitignorePath, block, 'utf-8');
  } catch {
    // Best-effort — workDir may not exist yet in tests or dry-run scenarios
  }
}
