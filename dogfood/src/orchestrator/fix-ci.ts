/**
 * Fix-CI orchestrator — detects CI failures on agent-created PRs,
 * fetches failure logs, and re-invokes the agent with error context.
 * Capped at MAX_FIX_ATTEMPTS to prevent infinite loops.
 */

import {
  evaluateDemotion,
  withSpan,
  getMeter,
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  type IssueTracker,
  type AuditLog,
  type AgentMetrics,
  type MetricStore,
  type AgentMemory,
} from '@ai-sdlc/reference';
import { loadConfig, type AiSdlcConfig } from './load-config.js';
import { createLogger, type Logger } from './logger.js';
import { createStructuredConsoleLogger } from './structured-logger.js';
import type { AgentRunner } from '../runner/types.js';
import { GitHubActionsRunner } from '../runner/github-actions.js';
import {
  execFileAsync,
  extractIssueNumber,
  resolveRepoRoot,
  createDefaultAuditLog,
  resolveAutonomyLevel,
  resolveConstraints,
  recordMetric,
  validateAndAuditOutput,
  authorizeFilesChanged,
} from './shared.js';
import { renderTemplate } from './notifications.js';
import {
  checkKillSwitch,
  issueAgentCredentials,
  revokeAgentCredentials,
  type SecurityContext,
} from './security.js';

export const MAX_FIX_ATTEMPTS = 2;
export const MAX_LOG_LINES = 150;
export const RETRY_MARKER = '<!-- ai-sdlc-fix-ci-attempt -->';

export interface FixCIOptions {
  /** Override the config directory (defaults to `.ai-sdlc`). */
  configDir?: string;
  /** Override the working directory (defaults to repo root). */
  workDir?: string;
  /** Inject a custom runner (for testing). */
  runner?: AgentRunner;
  /** Inject a custom logger (for testing). */
  logger?: Logger;
  /** Inject PR comments for testing (bypasses IssueTracker call). */
  _prComments?: string[];
  /** Inject CI logs for testing (bypasses `gh` CLI call). */
  _ciLogs?: string;
  /** Inject a custom audit log (for testing). */
  auditLog?: AuditLog;
  /** Inject a custom issue tracker (for testing). */
  tracker?: IssueTracker;
  /** In-process metric store for testable telemetry. */
  metricStore?: MetricStore;
  /** Agent memory for episodic recall. */
  memory?: AgentMemory;
  /** Security context for kill switch and JIT credentials. */
  security?: SecurityContext;
  /** Use the reference structured logger instead of the plain console logger. */
  useStructuredLogger?: boolean;
}

/**
 * Count how many fix-CI retry attempts have been made on a PR
 * by scanning comments for the hidden retry marker.
 */
export function countRetryAttempts(comments: string[]): number {
  let count = 0;
  for (const body of comments) {
    const matches = body.match(
      new RegExp(RETRY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    );
    if (matches) {
      count += matches.length;
    }
  }
  return count;
}

/**
 * Fetch CI failure logs for a given workflow run ID.
 * Truncates to the last MAX_LOG_LINES lines.
 */
export async function fetchCILogs(runId: number, injectedLogs?: string): Promise<string> {
  if (injectedLogs !== undefined) {
    return truncateLogs(injectedLogs);
  }

  const { stdout } = await execFileAsync('gh', ['run', 'view', String(runId), '--log-failed'], {
    timeout: 30_000,
  });
  return truncateLogs(stdout);
}

function truncateLogs(logs: string): string {
  const lines = logs.split('\n');
  if (lines.length <= MAX_LOG_LINES) {
    return logs;
  }
  return lines.slice(-MAX_LOG_LINES).join('\n');
}

/**
 * Execute the fix-CI pipeline for a failing PR.
 *
 * Returns gracefully (no throw) when the retry limit is reached.
 * Throws on agent failure or guardrail violations.
 */
export async function executeFixCI(
  prNumber: number,
  runId: number,
  options: FixCIOptions = {},
): Promise<void> {
  const workDir = options.workDir ?? (await resolveRepoRoot());
  const configDir = options.configDir ?? `${workDir}/.ai-sdlc`;
  const log =
    options.logger ??
    (options.useStructuredLogger ? createStructuredConsoleLogger() : createLogger());
  const auditLog = options.auditLog ?? createDefaultAuditLog(workDir);
  const metricStore = options.metricStore;

  // 1. Load config
  log.stage('load-config');
  const config: AiSdlcConfig = loadConfig(configDir);
  log.stageEnd('load-config');

  // Kill switch check (before any work)
  if (options.security) {
    await checkKillSwitch(options.security);
  }

  if (!config.agentRole) {
    throw new Error('No AgentRole resource found in .ai-sdlc/');
  }
  if (!config.autonomyPolicy) {
    throw new Error('No AutonomyPolicy resource found in .ai-sdlc/');
  }

  const agentRole = config.agentRole;
  const autonomyPolicy = config.autonomyPolicy;

  // Derive max fix attempts from pipeline config (code stage onFailure.maxRetries)
  const codeStage = config.pipeline?.spec.stages.find((s) => s.name === 'code');
  const maxFixAttempts = codeStage?.onFailure?.maxRetries ?? MAX_FIX_ATTEMPTS;

  // Notification templates
  const notifTemplates = config.pipeline?.spec.notifications?.templates;

  // 2. Count retry attempts (via injected comments or IssueTracker)
  log.stage('check-retries');
  let comments: string[];
  if (options._prComments !== undefined) {
    comments = options._prComments;
  } else if (options.tracker) {
    const issueComments = await options.tracker.getComments(String(prNumber));
    comments = issueComments.map((c) => c.body);
  } else {
    comments = [];
  }
  const attempts = countRetryAttempts(comments);
  log.info(`Fix-CI attempt ${attempts + 1} of ${maxFixAttempts}`);
  log.stageEnd('check-retries');

  // Helper to add a comment (via tracker or no-op)
  const addComment = async (body: string): Promise<void> => {
    if (options.tracker) {
      await options.tracker.addComment(String(prNumber), body);
    }
  };

  if (attempts >= maxFixAttempts) {
    log.info(`Fix-CI retry limit reached (${maxFixAttempts}). Commenting and stopping.`);
    auditLog.record({
      actor: 'system',
      action: 'evaluate',
      resource: `pr#${prNumber}`,
      decision: 'denied',
      details: { reason: 'retry-limit-reached', attempts, max: maxFixAttempts },
    });
    const limitTpl = notifTemplates?.['fix-ci-limit'];
    const limitComment = limitTpl
      ? renderTemplate(limitTpl, {
          attempts: String(attempts),
          max: String(maxFixAttempts),
        })
      : {
          title: 'AI-SDLC: Fix-CI Retry Limit Reached',
          body: `This PR has reached the maximum number of automated fix attempts (${maxFixAttempts}). Manual intervention is needed.`,
        };
    await addComment(`## ${limitComment.title}\n\n${limitComment.body}`);
    return;
  }

  // 3. Fetch CI logs
  log.stage('fetch-logs');
  const ciLogs = await fetchCILogs(runId, options._ciLogs);
  log.stageEnd('fetch-logs');

  // 4. Determine branch and issue number
  const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], {
    cwd: workDir,
  });
  const currentBranch = branchStdout.trim();
  const issueNumber = extractIssueNumber(currentBranch);
  if (issueNumber === null) {
    throw new Error(`Branch "${currentBranch}" does not match ai-sdlc/issue-N pattern`);
  }

  // 5. Resolve autonomy level and constraints
  const currentLevel = resolveAutonomyLevel(autonomyPolicy);
  const resolved = resolveConstraints(agentRole.spec.constraints, currentLevel);

  // 6. Fetch issue data (via tracker if available)
  let issueTitle = `Issue #${issueNumber}`;
  let issueBody = '';
  if (options.tracker) {
    const issueData = await options.tracker.getIssue(String(issueNumber));
    issueTitle = issueData.title;
    issueBody = issueData.description ?? '';
  }

  // Query episodic memory for previous fix-CI attempts
  if (options.memory) {
    const previousAttempts = options.memory.episodic.search('fix-ci-execution');
    if (previousAttempts.length > 0) {
      log.info(`Found ${previousAttempts.length} previous fix-CI episodes in memory`);
    }
  }

  const meter = getMeter();

  // 7. Invoke agent with CI error context (with JIT credential lifecycle)
  log.stage('agent');
  const runner = options.runner ?? new GitHubActionsRunner();

  // Issue JIT credentials before agent execution
  const jitCred = options.security
    ? await issueAgentCredentials(options.security, agentRole.metadata.name)
    : undefined;

  let result;
  try {
    result = await withSpan(
      SPAN_NAMES.AGENT_TASK,
      {
        [ATTRIBUTE_KEYS.AGENT]: agentRole.metadata.name,
        [ATTRIBUTE_KEYS.RESOURCE_NAME]: `pr#${prNumber}`,
      },
      async () => {
        const r = await runner.run({
          issueNumber,
          issueTitle,
          issueBody,
          workDir,
          branch: currentBranch,
          constraints: {
            maxFilesPerChange: resolved.maxFiles,
            requireTests: resolved.requireTests,
            blockedPaths: resolved.blockedPaths,
          },
          ciErrors: ciLogs,
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

          // Evaluate demotion on agent failure
          const agentMetrics: AgentMetrics = {
            name: agentRole.metadata.name,
            currentLevel: currentLevel.level,
            totalTasksCompleted: 0,
            metrics: {},
            approvals: [],
          };
          const demotion = evaluateDemotion(autonomyPolicy, agentMetrics, 'failed-test');
          log.info(
            `Demotion evaluation: ${demotion.demoted ? `demoted from ${demotion.fromLevel} to ${demotion.toLevel}` : 'no demotion'}`,
          );
          auditLog.record({
            actor: 'system',
            action: 'evaluate',
            resource: `agent/${agentRole.metadata.name}`,
            policy: 'demotion',
            decision: demotion.demoted ? 'denied' : 'allowed',
            details: {
              trigger: demotion.trigger,
              fromLevel: demotion.fromLevel,
              toLevel: demotion.toLevel,
            },
          });

          const agentFailTpl = notifTemplates?.['agent-failure'];
          const errorDetail = r.error ?? 'Unknown error';
          const agentFailComment = agentFailTpl
            ? renderTemplate(agentFailTpl, { stageName: 'fix-ci', details: errorDetail })
            : { title: 'AI-SDLC: Fix-CI Agent Failed', body: errorDetail };
          await addComment(
            `## ${agentFailComment.title}\n\n${agentFailComment.body}\n\n${RETRY_MARKER}`,
          );
          throw new Error(`Fix-CI agent failed on PR #${prNumber}: ${r.error}`);
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
  } finally {
    // Revoke JIT credentials after agent execution (success or failure)
    if (jitCred && options.security) {
      await revokeAgentCredentials(options.security, jitCred.id);
    }
  }

  // 8. ABAC authorization check (if write permissions are defined)
  if (currentLevel.permissions.write.length > 0) {
    authorizeFilesChanged(
      result.filesChanged,
      currentLevel.permissions,
      agentRole.spec.constraints,
      auditLog,
      agentRole.metadata.name,
    );
  }

  // 9. Validate agent output against guardrails
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
          await addComment(
            `## AI-SDLC: Fix-CI Guardrail Violations\n\n${violationList}\n\n${RETRY_MARKER}`,
          );
        },
      });
    },
  );

  // 10. Push to the same branch (CI re-runs automatically)
  log.stage('push');
  await execFileAsync('git', ['push', 'origin', currentBranch], { cwd: workDir });
  log.stageEnd('push');

  auditLog.record({
    actor: 'system',
    action: 'create',
    resource: `push/${currentBranch}`,
    decision: 'allowed',
    details: { prNumber, attempt: attempts + 1 },
  });

  // 11. Comment on PR with success details
  await addComment(
    [
      '## AI-SDLC: Fix-CI Applied',
      '',
      `Attempt ${attempts + 1} of ${MAX_FIX_ATTEMPTS} — pushed fixes to \`${currentBranch}\`.`,
      '',
      '### Changes',
      result.filesChanged.map((f) => `- \`${f}\``).join('\n'),
      '',
      RETRY_MARKER,
    ].join('\n'),
  );

  // 12. Record episodic memory
  if (options.memory) {
    options.memory.episodic.append({
      key: 'fix-ci-execution',
      value: {
        prNumber,
        issueNumber,
        filesChanged: result.filesChanged.length,
        outcome: 'success',
      },
      metadata: { summary: `Fix-CI for PR #${prNumber} (attempt ${attempts + 1})` },
    });
  }

  log.summary();
}
