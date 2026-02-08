/**
 * Fix-CI orchestrator — detects CI failures on agent-created PRs,
 * fetches failure logs, and re-invokes the agent with error context.
 * Capped at MAX_FIX_ATTEMPTS to prevent infinite loops.
 */

import { execFile } from 'node:child_process';
import { loadConfig, type AiSdlcConfig } from './load-config.js';
import { validateAgentOutput } from './validate-agent-output.js';
import { createLogger, type Logger } from './logger.js';
import type { AgentRunner } from '../runner/types.js';
import { GitHubActionsRunner } from '../runner/github-actions.js';

function exec(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

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
  /** Inject PR comments for testing (bypasses GitHub API call). */
  _prComments?: string[];
  /** Inject CI logs for testing (bypasses `gh` CLI call). */
  _ciLogs?: string;
}

/**
 * Count how many fix-CI retry attempts have been made on a PR
 * by scanning comments for the hidden retry marker.
 */
export function countRetryAttempts(comments: string[]): number {
  let count = 0;
  for (const body of comments) {
    // Count each occurrence of the marker in each comment
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

  const stdout = await exec('gh', ['run', 'view', String(runId), '--log-failed'], {
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

async function fetchPRComments(prNumber: number): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];

  const org = process.env.GITHUB_REPOSITORY_OWNER ?? 'ai-sdlc-framework';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'ai-sdlc';

  const url = `https://api.github.com/repos/${org}/${repo}/issues/${prNumber}/comments?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ body?: string }>;
  return data.map((c) => c.body ?? '');
}

async function commentOnPR(prNumber: number, body: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  const org = process.env.GITHUB_REPOSITORY_OWNER ?? 'ai-sdlc-framework';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'ai-sdlc';

  const url = `https://api.github.com/repos/${org}/${repo}/issues/${prNumber}/comments`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
}

async function resolveRepoRoot(): Promise<string> {
  return exec('git', ['rev-parse', '--show-toplevel']);
}

function extractIssueNumber(branch: string): number | null {
  const match = branch.match(/^ai-sdlc\/issue-(\d+)$/);
  return match ? Number(match[1]) : null;
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
  const log = options.logger ?? createLogger();

  // 1. Load config
  log.stage('load-config');
  const config: AiSdlcConfig = loadConfig(configDir);
  log.stageEnd('load-config');

  if (!config.agentRole) {
    throw new Error('No AgentRole resource found in .ai-sdlc/');
  }
  if (!config.autonomyPolicy) {
    throw new Error('No AutonomyPolicy resource found in .ai-sdlc/');
  }

  // 2. Count retry attempts
  log.stage('check-retries');
  const comments = options._prComments ?? (await fetchPRComments(prNumber));
  const attempts = countRetryAttempts(comments);
  log.info(`Fix-CI attempt ${attempts + 1} of ${MAX_FIX_ATTEMPTS}`);
  log.stageEnd('check-retries');

  if (attempts >= MAX_FIX_ATTEMPTS) {
    log.info(`Fix-CI retry limit reached (${MAX_FIX_ATTEMPTS}). Commenting and stopping.`);
    await commentOnPR(
      prNumber,
      `## AI-SDLC: Fix-CI Retry Limit Reached\n\nThis PR has reached the maximum number of automated fix attempts (${MAX_FIX_ATTEMPTS}). Manual intervention is needed.`,
    );
    return;
  }

  // 3. Fetch CI logs
  log.stage('fetch-logs');
  const ciLogs = await fetchCILogs(runId, options._ciLogs);
  log.stageEnd('fetch-logs');

  // 4. Determine branch and issue number
  const currentBranch = await exec('git', ['branch', '--show-current'], { cwd: workDir });
  const issueNumber = extractIssueNumber(currentBranch);
  if (issueNumber === null) {
    throw new Error(`Branch "${currentBranch}" does not match ai-sdlc/issue-N pattern`);
  }

  // 5. Invoke agent with CI error context
  log.stage('agent');
  const runner = options.runner ?? new GitHubActionsRunner();
  const constraints = config.agentRole.spec.constraints ?? {
    maxFilesPerChange: 15,
    requireTests: true,
    blockedPaths: [],
  };

  // Fetch issue title/body from GitHub for full context
  const issueData = await fetchIssueData(issueNumber);

  const result = await runner.run({
    issueNumber,
    issueTitle: issueData.title,
    issueBody: issueData.body,
    workDir,
    branch: currentBranch,
    constraints: {
      maxFilesPerChange: constraints.maxFilesPerChange ?? 15,
      requireTests: constraints.requireTests ?? true,
      blockedPaths: constraints.blockedPaths ?? [],
    },
    ciErrors: ciLogs,
  });

  if (!result.success) {
    log.stageEnd('agent');
    await commentOnPR(
      prNumber,
      `## AI-SDLC: Fix-CI Agent Failed\n\n${result.error ?? 'Unknown error'}\n\n${RETRY_MARKER}`,
    );
    throw new Error(`Fix-CI agent failed on PR #${prNumber}: ${result.error}`);
  }
  log.stageEnd('agent');

  // 6. Validate agent output against guardrails
  log.stage('validate-output');
  const currentLevel = config.autonomyPolicy.spec.levels.find((l) => l.level <= 1);
  if (!currentLevel) {
    throw new Error('No autonomy level 0 or 1 found in policy');
  }

  const validation = await validateAgentOutput({
    filesChanged: result.filesChanged,
    workDir,
    constraints: {
      maxFilesPerChange: constraints.maxFilesPerChange ?? 15,
      requireTests: constraints.requireTests ?? true,
      blockedPaths: constraints.blockedPaths ?? [],
    },
    guardrails: { maxLinesPerPR: currentLevel.guardrails.maxLinesPerPR },
  });
  log.stageEnd('validate-output');

  if (!validation.passed) {
    const violationList = validation.violations
      .map((v) => `- **${v.rule}**: ${v.message}`)
      .join('\n');
    await commentOnPR(
      prNumber,
      `## AI-SDLC: Fix-CI Guardrail Violations\n\n${violationList}\n\n${RETRY_MARKER}`,
    );
    throw new Error('Fix-CI agent output failed guardrail validation');
  }

  // 7. Push to the same branch (CI re-runs automatically)
  log.stage('push');
  await exec('git', ['push', 'origin', currentBranch], { cwd: workDir });
  log.stageEnd('push');

  // 8. Comment on PR with success details
  await commentOnPR(
    prNumber,
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

  log.summary();
}

async function fetchIssueData(issueNumber: number): Promise<{ title: string; body: string }> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { title: `Issue #${issueNumber}`, body: '' };
  }

  const org = process.env.GITHUB_REPOSITORY_OWNER ?? 'ai-sdlc-framework';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'ai-sdlc';

  const url = `https://api.github.com/repos/${org}/${repo}/issues/${issueNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!res.ok) {
    return { title: `Issue #${issueNumber}`, body: '' };
  }

  const data = (await res.json()) as { title?: string; body?: string };
  return { title: data.title ?? `Issue #${issueNumber}`, body: data.body ?? '' };
}
