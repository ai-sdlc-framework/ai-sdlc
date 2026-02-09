/**
 * Main pipeline execution — the heart of the dogfood loop.
 *
 * Flow:
 *   load config -> fetch issue -> validate -> check autonomy ->
 *   create branch -> invoke agent -> authorize -> validate -> push -> create PR -> comment
 */

import { execFile } from 'node:child_process';
import {
  createGitHubIssueTracker,
  createGitHubSourceControl,
  routeByComplexity,
  evaluatePromotion,
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
} from '@ai-sdlc/reference';
import { loadConfig, type AiSdlcConfig } from './load-config.js';
import { validateIssue, validateIssueWithExtensions, parseComplexity } from './validate-issue.js';
import { createLogger, type Logger } from './logger.js';
import type { AgentRunner } from '../runner/types.js';
import { GitHubActionsRunner } from '../runner/github-actions.js';
import {
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
} from './shared.js';

function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

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
}

/**
 * Execute the full AI-SDLC dogfood pipeline for a given issue number.
 */
export async function executePipeline(
  issueNumber: number,
  options: ExecuteOptions = {},
): Promise<PipelineResult> {
  const workDir = options.workDir ?? (await resolveRepoRoot());
  const configDir = options.configDir ?? `${workDir}/.ai-sdlc`;
  const log = options.logger ?? createLogger();
  const auditLog = options.auditLog ?? createDefaultAuditLog(workDir);
  const metricStore = options.metricStore;

  // 1. Load .ai-sdlc/ config
  log.stage('load-config');
  const config: AiSdlcConfig = loadConfig(configDir);
  log.stageEnd('load-config');

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

  // 2. Create adapters (or use injected ones)
  const { org, repo } = getGitHubConfig();
  const ghConfig = { org, repo, token: { secretRef: 'github-token' } };

  const tracker = options.tracker ?? createGitHubIssueTracker(ghConfig);
  const sc = options.sourceControl ?? createGitHubSourceControl(ghConfig);

  // 3. Fetch issue
  log.stage('validate-issue');
  const issue = await tracker.getIssue(String(issueNumber));

  // Store issue context in working memory if provided
  if (options.memory) {
    options.memory.working.set('currentIssue', {
      number: issueNumber,
      title: issue.title,
      description: issue.description,
    });
  }

  // Wrap pipeline body in try/catch to record failure episodes
  try {
    return await executePipelineBody(
      issueNumber,
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
          issueNumber,
          outcome: 'failure',
          error: err instanceof Error ? err.message : String(err),
        },
        metadata: { summary: `Failed issue #${issueNumber}: ${issue.title}` },
      });
      options.memory.working.clear();
    }
    throw err;
  }
}

async function executePipelineBody(
  issueNumber: number,
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
  const meter = getMeter();

  // 4. Validate issue against quality gates
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
          : validateIssue(issue, qualityGate);
      if (!enforcement.allowed) {
        const failures = enforcement.results
          .filter((r) => r.verdict === 'fail')
          .map((r) => `- ${r.gate}: ${r.message ?? 'failed'}`)
          .join('\n');

        auditLog.record({
          actor: 'system',
          action: 'evaluate',
          resource: `issue#${issueNumber}`,
          policy: qualityGate.metadata.name,
          decision: 'denied',
          details: {
            failures: enforcement.results.filter((r) => r.verdict === 'fail').map((r) => r.gate),
          },
        });

        meter.createCounter(METRIC_NAMES.GATE_FAIL_TOTAL).add(1);
        recordMetric(metricStore, METRIC_NAMES.GATE_FAIL_TOTAL, 1);

        await tracker.addComment(
          String(issueNumber),
          `## AI-SDLC: Issue Validation Failed\n\nThis issue did not pass quality gate checks:\n\n${failures}`,
        );
        throw new Error(`Issue #${issueNumber} failed quality gate validation`);
      }

      auditLog.record({
        actor: 'system',
        action: 'evaluate',
        resource: `issue#${issueNumber}`,
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
    resource: `issue#${issueNumber}`,
    decision: isAutonomousStrategy(strategy) ? 'allowed' : 'denied',
    details: { score: complexity, strategy },
  });

  if (!isAutonomousStrategy(strategy)) {
    await tracker.addComment(
      String(issueNumber),
      `## AI-SDLC: Complexity Too High\n\nIssue complexity (${complexity}) routed as "${strategy}" — requires human involvement.`,
    );
    throw new Error(`Issue #${issueNumber} complexity ${complexity} routed as "${strategy}"`);
  }

  // 6. Check autonomy level allows coding
  const currentLevel = resolveAutonomyLevel(autonomyPolicy);
  log.stageEnd('validate-issue');

  // 7. Create branch and checkout locally
  const branchName = `ai-sdlc/issue-${issueNumber}`;
  await sc.createBranch({ name: branchName });
  await execFileAsync('git', ['fetch', 'origin', branchName], { cwd: workDir });
  await execFileAsync('git', ['checkout', branchName], { cwd: workDir });

  // 8. Resolve agent constraints
  const resolved = resolveConstraints(agentRole.spec.constraints, currentLevel);

  // 9. Invoke agent
  log.stage('agent');
  const runner = options.runner ?? new GitHubActionsRunner();

  const result = await withSpan(
    SPAN_NAMES.AGENT_TASK,
    {
      [ATTRIBUTE_KEYS.AGENT]: agentRole.metadata.name,
      [ATTRIBUTE_KEYS.RESOURCE_NAME]: `issue#${issueNumber}`,
    },
    async () => {
      const r = await runner.run({
        issueNumber,
        issueTitle: issue.title,
        issueBody: issue.description ?? '',
        workDir,
        branch: branchName,
        constraints: {
          maxFilesPerChange: resolved.maxFiles,
          requireTests: resolved.requireTests,
          blockedPaths: resolved.blockedPaths,
        },
      });

      if (!r.success) {
        log.stageEnd('agent');
        auditLog.record({
          actor: 'system',
          action: 'execute',
          resource: `agent/${agentRole.metadata.name}`,
          decision: 'denied',
          details: { error: r.error },
        });
        meter.createCounter(METRIC_NAMES.TASK_FAILURE_TOTAL).add(1);
        recordMetric(metricStore, METRIC_NAMES.TASK_FAILURE_TOTAL, 1);
        await tracker.addComment(
          String(issueNumber),
          `## AI-SDLC: Agent Failed\n\n${r.error ?? 'Unknown error'}`,
        );
        throw new Error(`Agent failed on issue #${issueNumber}: ${r.error}`);
      }
      log.stageEnd('agent');

      auditLog.record({
        actor: 'system',
        action: 'execute',
        resource: `agent/${agentRole.metadata.name}`,
        decision: 'allowed',
        details: { filesChanged: r.filesChanged.length },
      });
      meter.createCounter(METRIC_NAMES.TASK_SUCCESS_TOTAL).add(1);
      recordMetric(metricStore, METRIC_NAMES.TASK_SUCCESS_TOTAL, 1);

      return r;
    },
  );

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
            String(issueNumber),
            `## AI-SDLC: Guardrail Violations\n\n${violationList}`,
          );
        },
      });
    },
  );

  // 12. Push branch
  log.stage('push');
  await execFileAsync('git', ['push', 'origin', branchName], { cwd: workDir });
  log.stageEnd('push');

  // 13. Create PR
  log.stage('create-pr');
  const pr = await withSpan(
    SPAN_NAMES.PIPELINE_STAGE,
    {
      [ATTRIBUTE_KEYS.STAGE]: 'create-pr',
    },
    async () => {
      const prResult = await sc.createPR({
        title: `fix: ${issue.title} (#${issueNumber})`,
        description: [
          '## Summary',
          '',
          result.summary,
          '',
          '## Changes',
          '',
          result.filesChanged.map((f) => `- \`${f}\``).join('\n'),
          '',
          `Closes #${issueNumber}`,
          '',
          '---',
          '*This PR was generated by [AI-SDLC](https://github.com/ai-sdlc-framework/ai-sdlc) dogfood pipeline.*',
        ].join('\n'),
        sourceBranch: branchName,
        targetBranch: 'main',
      });

      log.stageEnd('create-pr');

      auditLog.record({
        actor: 'system',
        action: 'create',
        resource: 'pull-request',
        decision: 'allowed',
        details: { prUrl: prResult.url, issueNumber },
      });

      return prResult;
    },
  );

  // 14. Comment on issue with success
  await tracker.addComment(
    String(issueNumber),
    `## AI-SDLC: PR Created\n\nPull request created: ${pr.url}\n\nFiles changed: ${result.filesChanged.length}\n\nPlease review and merge.`,
  );

  // 15. Evaluate promotion eligibility (observational only)
  const agentMetrics: AgentMetrics = {
    name: agentRole.metadata.name,
    currentLevel: currentLevel.level,
    totalTasksCompleted: 1,
    metrics: {},
    approvals: [],
  };
  const promotion = evaluatePromotion(autonomyPolicy, agentMetrics);
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

  // 17. Record episodic memory (success)
  if (options.memory) {
    options.memory.episodic.append({
      key: 'pipeline-execution',
      value: {
        issueNumber,
        prUrl: pr.url,
        filesChanged: result.filesChanged.length,
        outcome: 'success',
      },
      metadata: { summary: `Completed issue #${issueNumber}: ${issue.title}` },
    });
    options.memory.working.clear();
  }

  log.summary();

  return {
    prUrl: pr.url,
    filesChanged: result.filesChanged,
    promotionEligible: promotion.eligible,
  };
}
