/**
 * Main pipeline execution — the heart of the dogfood loop.
 *
 * Flow:
 *   load config -> fetch issue -> validate -> check autonomy ->
 *   create branch -> invoke agent -> push -> create PR -> comment
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createGitHubIssueTracker,
  createGitHubSourceControl,
  type IssueTracker,
  type SourceControl,
} from '@ai-sdlc/reference';
import { loadConfig, type AiSdlcConfig } from './load-config.js';
import { validateIssue, parseComplexity } from './validate-issue.js';
import { validateAgentOutput } from './validate-agent-output.js';
import { createLogger, type Logger } from './logger.js';
import type { AgentRunner } from '../runner/types.js';
import { GitHubActionsRunner } from '../runner/github-actions.js';

const execFileAsync = promisify(execFile);

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
}

async function commentOnIssue(
  _tracker: IssueTracker,
  issueId: string,
  body: string,
): Promise<void> {
  // The IssueTracker interface doesn't expose comments, so we use the
  // GitHub API directly via GITHUB_TOKEN.
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;

  const org = process.env.GITHUB_REPOSITORY_OWNER ?? 'ai-sdlc-framework';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'ai-sdlc';

  const url = `https://api.github.com/repos/${org}/${repo}/issues/${issueId}/comments`;
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
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

/**
 * Execute the full AI-SDLC dogfood pipeline for a given issue number.
 */
export async function executePipeline(
  issueNumber: number,
  options: ExecuteOptions = {},
): Promise<void> {
  const workDir = options.workDir ?? (await resolveRepoRoot());
  const configDir = options.configDir ?? `${workDir}/.ai-sdlc`;
  const log = options.logger ?? createLogger();

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

  // 2. Create adapters (or use injected ones)
  const ghConfig = {
    org: process.env.GITHUB_REPOSITORY_OWNER ?? 'ai-sdlc-framework',
    repo: process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'ai-sdlc',
    token: { secretRef: 'github-token' },
  };

  const tracker = options.tracker ?? createGitHubIssueTracker(ghConfig);
  const sc = options.sourceControl ?? createGitHubSourceControl(ghConfig);

  // 3. Fetch issue
  log.stage('validate-issue');
  const issue = await tracker.getIssue(String(issueNumber));

  // 4. Validate issue against quality gates
  const enforcement = validateIssue(issue, config.qualityGate);
  if (!enforcement.allowed) {
    const failures = enforcement.results
      .filter((r) => r.verdict === 'fail')
      .map((r) => `- ${r.gate}: ${r.message ?? 'failed'}`)
      .join('\n');

    await commentOnIssue(
      tracker,
      String(issueNumber),
      `## AI-SDLC: Issue Validation Failed\n\nThis issue did not pass quality gate checks:\n\n${failures}`,
    );
    throw new Error(`Issue #${issueNumber} failed quality gate validation`);
  }

  // 5. Parse complexity and check autonomy policy
  const complexity = parseComplexity(issue.description);
  const maxAllowedComplexity = 3;
  if (complexity > maxAllowedComplexity) {
    await commentOnIssue(
      tracker,
      String(issueNumber),
      `## AI-SDLC: Complexity Too High\n\nIssue complexity (${complexity}) exceeds the maximum allowed for autonomous processing (${maxAllowedComplexity}).`,
    );
    throw new Error(
      `Issue #${issueNumber} complexity ${complexity} exceeds max ${maxAllowedComplexity}`,
    );
  }

  // 6. Check autonomy level allows coding
  const currentLevel = config.autonomyPolicy.spec.levels.find((l) => l.level <= 1);
  log.stageEnd('validate-issue');
  if (!currentLevel) {
    throw new Error('No autonomy level 0 or 1 found in policy');
  }

  // 7. Create branch and checkout locally
  const branchName = `ai-sdlc/issue-${issueNumber}`;
  await sc.createBranch({ name: branchName });
  await execFileAsync('git', ['fetch', 'origin', branchName], { cwd: workDir });
  await execFileAsync('git', ['checkout', branchName], { cwd: workDir });

  // 9. Invoke agent
  log.stage('agent');
  const runner = options.runner ?? new GitHubActionsRunner();
  const constraints = config.agentRole.spec.constraints ?? {
    maxFilesPerChange: 15,
    requireTests: true,
    blockedPaths: [],
  };

  const result = await runner.run({
    issueNumber,
    issueTitle: issue.title,
    issueBody: issue.description ?? '',
    workDir,
    branch: branchName,
    constraints: {
      maxFilesPerChange: constraints.maxFilesPerChange ?? 15,
      requireTests: constraints.requireTests ?? true,
      blockedPaths: constraints.blockedPaths ?? [],
    },
  });

  if (!result.success) {
    log.stageEnd('agent');
    await commentOnIssue(
      tracker,
      String(issueNumber),
      `## AI-SDLC: Agent Failed\n\n${result.error ?? 'Unknown error'}`,
    );
    throw new Error(`Agent failed on issue #${issueNumber}: ${result.error}`);
  }
  log.stageEnd('agent');

  // 10. Validate agent output against guardrails
  log.stage('validate-output');
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
    await commentOnIssue(
      tracker,
      String(issueNumber),
      `## AI-SDLC: Guardrail Violations\n\n${violationList}`,
    );
    throw new Error('Agent output failed guardrail validation');
  }

  // 11. Push branch
  log.stage('push');
  await execFileAsync('git', ['push', 'origin', branchName], { cwd: workDir });
  log.stageEnd('push');

  // 12. Create PR
  log.stage('create-pr');
  const pr = await sc.createPR({
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

  // 13. Comment on issue with success
  await commentOnIssue(
    tracker,
    String(issueNumber),
    `## AI-SDLC: PR Created\n\nPull request created: ${pr.url}\n\nFiles changed: ${result.filesChanged.length}\n\nPlease review and merge.`,
  );

  log.summary();
}
