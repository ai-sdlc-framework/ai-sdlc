/**
 * Fix-Review orchestrator — detects review findings on agent-created PRs,
 * fetches review comments, and re-invokes the agent with review context.
 * Capped at MAX_FIX_ATTEMPTS to prevent infinite loops.
 */

import {
  createGitHubIssueTracker,
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
  type SecretStore,
} from '@ai-sdlc/reference';
import { loadConfig, type AiSdlcConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createStructuredConsoleLogger } from './structured-logger.js';
import type { AgentRunner } from './runners/types.js';
import { ClaudeCodeRunner } from './runners/claude-code.js';
import {
  execFileAsync,
  getGitHubConfig,
  extractIssueId,
  resolveRepoRoot,
  createDefaultAuditLog,
  resolveAutonomyLevel,
  resolveConstraints,
  recordMetric,
  validateAndAuditOutput,
  authorizeFilesChanged,
  issueIdToNumber,
} from './shared.js';
import { renderTemplate } from './notifications.js';
import { parseDuration } from './policy-evaluators.js';
import {
  checkKillSwitch,
  issueAgentCredentials,
  revokeAgentCredentials,
  type SecurityContext,
} from './security.js';
import {
  DEFAULT_GH_CLI_TIMEOUT_MS,
  DEFAULT_CONFIG_DIR_NAME,
  defaultSandboxConstraints,
  NOTIFICATION_TITLES,
} from './defaults.js';

// Default max review-fix attempts (lower than CI-fix since reviews are more deterministic)
export const MAX_REVIEW_FIX_ATTEMPTS = 2;
export const RETRY_MARKER = '<!-- ai-sdlc-fix-review-attempt -->';

export interface FixReviewOptions {
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
  /** Inject review findings for testing (bypasses GitHub API call). */
  _reviewFindings?: string;
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
  /** Secret store adapter for resolving credentials (defaults to process.env). */
  secretStore?: SecretStore;
}

/**
 * Count how many fix-review retry attempts have been made on a PR
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
 * Validate that a PR number is a positive integer.
 */
export function validatePrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber} (must be a positive integer)`);
  }
}

/**
 * Sanitize a git branch name to prevent command injection.
 * Allows only alphanumeric characters, slashes, dashes, underscores, and dots.
 */
export function sanitizeBranchName(branch: string): string {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: "${branch}" (only alphanumeric, /, -, _, . allowed)`);
  }
  return branch;
}

/**
 * Fetch review findings from PR reviews that requested changes.
 * Returns a formatted string with all findings from review agents.
 */
export async function fetchReviewFindings(
  prNumber: number,
  injectedFindings?: string,
  _secretStore?: SecretStore,
): Promise<string> {
  if (injectedFindings !== undefined) {
    return injectedFindings;
  }

  // Validate PR number to prevent command injection
  validatePrNumber(prNumber);

  // Fetch reviews using gh CLI
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'review', String(prNumber), '--json', 'state,body,author'],
    { timeout: DEFAULT_GH_CLI_TIMEOUT_MS },
  );

  interface Review {
    state: string;
    body: string;
    author: { login: string };
  }

  let reviews: Review[];
  try {
    reviews = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse review data from gh CLI: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const changesRequestedReviews = reviews.filter((r) => r.state === 'CHANGES_REQUESTED');

  if (changesRequestedReviews.length === 0) {
    return 'No review findings (all reviews approved or pending)';
  }

  // Format findings from all reviews
  const findings = changesRequestedReviews
    .map((r) => `### Review by ${r.author.login}\n\n${r.body}\n\n---\n`)
    .join('\n');

  return findings;
}

/**
 * Execute the fix-review pipeline for a PR with review findings.
 *
 * Returns gracefully (no throw) when the retry limit is reached.
 * Throws on agent failure or guardrail violations.
 */
export async function executeFixReview(
  prNumber: number,
  options: FixReviewOptions = {},
): Promise<void> {
  const workDir = options.workDir ?? (await resolveRepoRoot());
  const configDir = options.configDir ?? `${workDir}/${DEFAULT_CONFIG_DIR_NAME}`;
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

  // Derive max fix attempts from pipeline config (review stage onFailure.maxRetries)
  const reviewStage = config.pipeline?.spec.stages.find((s) => s.name === 'review');
  const maxFixAttempts = reviewStage?.onFailure?.maxRetries ?? MAX_REVIEW_FIX_ATTEMPTS;

  // Notification templates
  const notifTemplates = config.pipeline?.spec.notifications?.templates;

  // Create default tracker when needed (lazy to avoid resolving secrets in test environments).
  // In production (no _prComments injected), the tracker is always available.
  let _tracker: IssueTracker | undefined = options.tracker;
  function getTracker(): IssueTracker {
    if (!_tracker) {
      const { org, repo } = getGitHubConfig(options.secretStore);
      const ghConfig = { org, repo, token: { secretRef: 'github-token' } };
      _tracker = createGitHubIssueTracker(ghConfig);
    }
    return _tracker;
  }
  // Tracker is available if injected directly or if we're not in test mode
  const trackerAvailable = !!options.tracker || options._prComments === undefined;

  // 2. Count retry attempts (via injected comments or IssueTracker)
  log.stage('check-retries');
  let comments: string[];
  if (options._prComments !== undefined) {
    comments = options._prComments;
  } else {
    const issueComments = await getTracker().getComments(String(prNumber));
    comments = issueComments.map((c) => c.body);
  }
  const attempts = countRetryAttempts(comments);
  log.info(`Fix-review attempt ${attempts + 1} of ${maxFixAttempts}`);
  log.stageEnd('check-retries');

  // Helper to add a comment via tracker (uses default tracker in production)
  const addComment = async (body: string): Promise<void> => {
    if (trackerAvailable) {
      await getTracker().addComment(String(prNumber), body);
    }
  };

  if (attempts >= maxFixAttempts) {
    log.info(`Fix-review retry limit reached (${maxFixAttempts}). Commenting and stopping.`);
    auditLog.record({
      actor: 'system',
      action: 'evaluate',
      resource: `pr#${prNumber}`,
      decision: 'denied',
      details: { reason: 'retry-limit-reached', attempts, max: maxFixAttempts },
    });
    const limitTpl = notifTemplates?.['fix-review-limit'];
    const limitComment = limitTpl
      ? renderTemplate(limitTpl, {
          attempts: String(attempts),
          max: String(maxFixAttempts),
        })
      : {
          title: NOTIFICATION_TITLES.fixReviewRetryLimit,
          body: `This PR has reached the maximum number of automated review-fix attempts (${maxFixAttempts}). Manual intervention is needed.`,
        };
    await addComment(`## ${limitComment.title}\n\n${limitComment.body}`);
    return;
  }

  // 3. Fetch review findings
  log.stage('fetch-findings');
  const reviewFindings = await fetchReviewFindings(
    prNumber,
    options._reviewFindings,
    options.secretStore,
  );
  log.stageEnd('fetch-findings');

  // Check if review findings are actionable (not a generic "no findings" message)
  const isActionable =
    reviewFindings &&
    !reviewFindings.startsWith('No review findings') &&
    reviewFindings.trim().length > 0;

  if (!isActionable) {
    log.info('No actionable review findings. Skipping fix-review execution.');
    auditLog.record({
      actor: 'system',
      action: 'evaluate',
      resource: `pr#${prNumber}`,
      decision: 'allowed',
      details: { reason: 'no-actionable-findings', reviewFindings },
    });
    return;
  }

  // 4. Determine branch and issue number
  const { stdout: branchStdout } = await execFileAsync('git', ['branch', '--show-current'], {
    cwd: workDir,
  });
  const currentBranch = sanitizeBranchName(branchStdout.trim());
  const issueId = extractIssueId(currentBranch);
  if (issueId === null) {
    throw new Error(`Branch "${currentBranch}" does not match ai-sdlc/issue-<id> pattern`);
  }
  const issueNumber = issueIdToNumber(issueId);

  // 5. Resolve autonomy level and constraints
  const currentLevel = resolveAutonomyLevel(autonomyPolicy);
  const resolved = resolveConstraints(agentRole.spec.constraints, currentLevel);

  // 6. Fetch issue data (via tracker when available)
  let issueTitle = `Issue ${issueId}`;
  let issueBody = '';
  if (trackerAvailable) {
    const issueData = await getTracker().getIssue(issueId);
    issueTitle = issueData.title;
    issueBody = issueData.description ?? '';
  }

  // Store issue context in working memory
  if (options.memory) {
    options.memory.working.set('currentIssue', { prNumber, issueId, currentBranch });
  }

  // Query episodic memory for previous fix-review attempts
  if (options.memory) {
    const previousAttempts = options.memory.episodic.search('fix-review-execution');
    if (previousAttempts.length > 0) {
      log.info(`Found ${previousAttempts.length} previous fix-review episodes in memory`);
    }
  }

  const meter = getMeter();

  // Wrap agent+validation+push in try/catch for failure episodes
  try {
    // 7. Invoke agent with review findings (with sandbox + JIT credential lifecycle)
    log.stage('agent');
    const runner = options.runner ?? new ClaudeCodeRunner();

    // Sandbox isolation around agent execution
    let sandboxId: string | undefined;
    let result;
    try {
      if (options.security) {
        const timeoutMs = reviewStage?.timeout ? parseDuration(reviewStage.timeout) : undefined;
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
        result = await withSpan(
          SPAN_NAMES.AGENT_TASK,
          {
            [ATTRIBUTE_KEYS.AGENT]: agentRole.metadata.name,
            [ATTRIBUTE_KEYS.RESOURCE_NAME]: `pr#${prNumber}`,
          },
          async () => {
            const r = await runner.run({
              issueId,
              issueNumber: issueNumber ?? undefined,
              issueTitle,
              issueBody,
              workDir,
              branch: currentBranch,
              constraints: {
                maxFilesPerChange: resolved.maxFiles,
                requireTests: resolved.requireTests,
                blockedPaths: resolved.blockedPaths,
              },
              reviewFindings,
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
                ? renderTemplate(agentFailTpl, { stageName: 'fix-review', details: errorDetail })
                : { title: NOTIFICATION_TITLES.fixReviewAgentFailed, body: errorDetail };
              await addComment(
                `## ${agentFailComment.title}\n\n${agentFailComment.body}\n\n${RETRY_MARKER}`,
              );
              throw new Error(`Fix-review agent failed on PR #${prNumber}: ${r.error}`);
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
    } finally {
      // Destroy sandbox after agent execution
      if (sandboxId && options.security) {
        await options.security.sandbox.destroy(sandboxId);
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
              `## ${NOTIFICATION_TITLES.fixReviewGuardrailViolations}\n\n${violationList}\n\n${RETRY_MARKER}`,
            );
          },
        });
      },
    );

    // 10. Push to the same branch (review agents re-run automatically via pull_request.synchronize)
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
    const successTpl = notifTemplates?.['fix-review-success'];
    const successComment = successTpl
      ? renderTemplate(successTpl, {
          attempt: String(attempts + 1),
          max: String(maxFixAttempts),
          branch: currentBranch,
        })
      : {
          title: NOTIFICATION_TITLES.fixReviewApplied,
          body: `Attempt ${attempts + 1} of ${maxFixAttempts} — pushed review fixes to \`${currentBranch}\`.`,
        };
    await addComment(
      [
        `## ${successComment.title}`,
        '',
        successComment.body,
        '',
        '### Changes',
        result.filesChanged.map((f) => `- \`${f}\``).join('\n'),
        '',
        RETRY_MARKER,
      ].join('\n'),
    );

    // 12. Record episodic memory (success)
    if (options.memory) {
      options.memory.episodic.append({
        key: 'fix-review-execution',
        value: {
          prNumber,
          issueId,
          filesChanged: result.filesChanged.length,
          outcome: 'success',
        },
        metadata: { summary: `Fix-review for PR #${prNumber} (attempt ${attempts + 1})` },
      });
      options.memory.working.clear();
    }
  } catch (err) {
    // Record failure episode before rethrowing
    if (options.memory) {
      options.memory.episodic.append({
        key: 'fix-review-execution',
        value: {
          prNumber,
          issueId,
          outcome: 'failure',
          error: err instanceof Error ? err.message : String(err),
        },
        metadata: { summary: `Failed fix-review for PR #${prNumber}` },
      });
      options.memory.working.clear();
    }
    throw err;
  }

  log.summary();
}
