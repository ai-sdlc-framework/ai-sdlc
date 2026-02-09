/**
 * Shared utilities extracted from execute.ts and fix-ci.ts.
 * Eliminates ~400 lines of duplicated logic across orchestrators.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import {
  createAuditLog,
  createFileSink,
  authorize,
  checkAllFrameworks,
  createAgentMemory,
  createFileLongTermMemory,
  createFileEpisodicMemory,
  type AuditLog,
  type AgentConstraints,
  type AutonomyLevel,
  type AutonomyPolicy,
  type Permissions,
  type MetricStore,
  type AgentMemory,
  type ComplianceCoverageReport,
} from '@ai-sdlc/reference';

function execFileAsync(
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

// ── Template interpolation ────────────────────────────────────────────

/**
 * Interpolate a branch name pattern by replacing `{key}` placeholders.
 * Falls back to `ai-sdlc/issue-{issueNumber}` when no pattern is provided.
 */
export function interpolateBranchPattern(
  pattern: string | undefined,
  vars: Record<string, string>,
): string {
  const p = pattern ?? 'ai-sdlc/issue-{issueNumber}';
  return p.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

/**
 * Interpolate a PR title template by replacing `{key}` placeholders.
 * Falls back to `fix: {issueTitle} (#{issueNumber})` when no template is provided.
 */
export function interpolatePRTitle(
  template: string | undefined,
  vars: Record<string, string>,
): string {
  const t = template ?? 'fix: {issueTitle} (#{issueNumber})';
  return t.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

// ── Branch pattern ───────────────────────────────────────────────────

export const BRANCH_PATTERN = /^ai-sdlc\/issue-(\d+)$/;

/**
 * Extract the issue number from an `ai-sdlc/issue-N` branch name.
 * Returns null if the branch doesn't match the pattern.
 */
export function extractIssueNumber(branch: string): number | null {
  const match = branch.match(BRANCH_PATTERN);
  return match ? Number(match[1]) : null;
}

// ── GitHub config ────────────────────────────────────────────────────

export interface GitHubEnvConfig {
  org: string;
  repo: string;
  token: string | undefined;
}

/**
 * Read GitHub org/repo/token from standard environment variables.
 */
export function getGitHubConfig(): GitHubEnvConfig {
  const org = process.env.GITHUB_REPOSITORY_OWNER ?? 'ai-sdlc-framework';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'ai-sdlc';
  const token = process.env.GITHUB_TOKEN || undefined;
  return { org, repo, token };
}

// ── Repo root ────────────────────────────────────────────────────────

/**
 * Resolve the repository root directory using `git rev-parse`.
 */
export async function resolveRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

// ── Audit log factory ────────────────────────────────────────────────

/**
 * Create the default JSONL-backed audit log for a work directory.
 */
export function createDefaultAuditLog(workDir: string): AuditLog {
  return createAuditLog(createFileSink(join(workDir, '.ai-sdlc', 'audit.jsonl')));
}

// ── Autonomy helpers ─────────────────────────────────────────────────

/**
 * Find the applicable autonomy level from the policy.
 * @param maxLevel Maximum level to search for (default 1).
 */
export function resolveAutonomyLevel(policy: AutonomyPolicy, maxLevel = 1): AutonomyLevel {
  const level = policy.spec.levels.find((l) => l.level <= maxLevel);
  if (!level) {
    throw new Error(`No autonomy level 0 or ${maxLevel} found in policy`);
  }
  return level;
}

/**
 * Merge blocked paths from agent constraints and autonomy guardrails,
 * deduplicating the result.
 */
export function mergeBlockedPaths(
  constraints: AgentConstraints,
  guardrails: { blockedPaths?: string[] },
): string[] {
  const agentBlocked = constraints.blockedPaths ?? [];
  const autonomyBlocked = guardrails.blockedPaths ?? [];
  return [...new Set([...agentBlocked, ...autonomyBlocked])];
}

/**
 * Resolve the effective agent constraints from an AgentRole and autonomy level.
 */
export function resolveConstraints(
  agentConstraints: AgentConstraints | undefined,
  autonomyLevel: AutonomyLevel,
): { maxFiles: number; requireTests: boolean; blockedPaths: string[] } {
  const constraints = agentConstraints ?? {
    maxFilesPerChange: 15,
    requireTests: true,
    blockedPaths: [],
  };
  return {
    maxFiles: constraints.maxFilesPerChange ?? 15,
    requireTests: constraints.requireTests ?? true,
    blockedPaths: mergeBlockedPaths(constraints, autonomyLevel.guardrails),
  };
}

// ── Routing strategy ─────────────────────────────────────────────────

/**
 * Check if a routing strategy allows fully autonomous execution.
 */
export function isAutonomousStrategy(strategy: string): boolean {
  return strategy === 'fully-autonomous' || strategy === 'ai-with-review';
}

// ── Metric store helper ──────────────────────────────────────────────

/**
 * Record a metric to an optional MetricStore (no-ops if store is undefined).
 */
export function recordMetric(store: MetricStore | undefined, metric: string, value: number): void {
  if (store) store.record({ metric, value });
}

// ── Output validation (shared block) ─────────────────────────────────

import { validateAgentOutput } from './validate-agent-output.js';
import type { Logger } from './logger.js';

export interface ValidateAndAuditParams {
  filesChanged: string[];
  workDir: string;
  constraints: { maxFilesPerChange: number; requireTests: boolean; blockedPaths: string[] };
  guardrails: { maxLinesPerPR?: number };
  auditLog: AuditLog;
  log: Logger;
  /** Optional callback to post a comment on validation failure. */
  onViolation?: (violationList: string) => Promise<void>;
}

/**
 * Validate agent output against guardrails and record audit entries.
 * Throws on guardrail violations.
 */
export async function validateAndAuditOutput(params: ValidateAndAuditParams): Promise<void> {
  const { filesChanged, workDir, constraints, guardrails, auditLog, log, onViolation } = params;

  log.stage('validate-output');

  const validation = await validateAgentOutput({
    filesChanged,
    workDir,
    constraints,
    guardrails,
  });
  log.stageEnd('validate-output');

  if (!validation.passed) {
    auditLog.record({
      actor: 'system',
      action: 'check',
      resource: 'agent-output',
      decision: 'denied',
      details: { violations: validation.violations.map((v) => v.rule) },
    });
    const violationList = validation.violations
      .map((v) => `- **${v.rule}**: ${v.message}`)
      .join('\n');
    if (onViolation) {
      await onViolation(violationList);
    }
    throw new Error('Agent output failed guardrail validation');
  }

  auditLog.record({
    actor: 'system',
    action: 'check',
    resource: 'agent-output',
    decision: 'allowed',
  });
}

// ── Agent memory ─────────────────────────────────────────────────────

/**
 * Create a pipeline agent memory backed by local files.
 */
export function createPipelineMemory(workDir: string): AgentMemory {
  const base = createAgentMemory();
  return {
    ...base,
    longTerm: createFileLongTermMemory(join(workDir, '.ai-sdlc', 'memory', 'long-term.json')),
    episodic: createFileEpisodicMemory(join(workDir, '.ai-sdlc', 'memory', 'episodes.json')),
  };
}

// ── Compliance reporting ─────────────────────────────────────────────

/**
 * Evaluate pipeline compliance across all regulatory frameworks.
 */
export function evaluatePipelineCompliance(hasMemory: boolean): ComplianceCoverageReport[] {
  const controls = new Set([
    'quality-gates',
    'audit-logging',
    'autonomy-governance',
    'human-review',
    'metrics-collection',
    'complexity-routing',
  ]);
  if (hasMemory) controls.add('agent-memory');
  return checkAllFrameworks(controls);
}

// ── ABAC authorization ───────────────────────────────────────────────

/**
 * Authorize a list of files against ABAC permissions and agent constraints.
 * Throws on the first denied file.
 */
export function authorizeFilesChanged(
  files: string[],
  permissions: Permissions,
  constraints: AgentConstraints | undefined,
  auditLog: AuditLog,
  actor: string,
): void {
  for (const file of files) {
    const result = authorize(permissions, constraints, 'write', file);
    if (!result.allowed) {
      auditLog.record({
        actor,
        action: 'write',
        resource: file,
        decision: 'denied',
        details: { reason: result.reason, layer: result.layer },
      });
      throw new Error(`Authorization denied for ${file}: ${result.reason}`);
    }
  }
}
