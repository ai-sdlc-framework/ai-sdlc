/**
 * Centralized default values for the dogfood pipeline.
 *
 * All magic numbers, fallback strings, and environment-driven defaults live
 * here so they can be tuned from a single location.  Every value can be
 * overridden by an environment variable, a Pipeline/AgentRole YAML field,
 * or an explicit function parameter — these are only the last-resort
 * fallbacks.
 */

import type { NetworkPolicy, SandboxConstraints } from '@ai-sdlc/reference';
import { parseDuration } from '@ai-sdlc/reference';

// ── LLM Model ────────────────────────────────────────────────────────

/**
 * Default model name (literal fallback).
 * Consumers should read `AI_SDLC_MODEL` env var at call time and fall back
 * to this constant, so tests that set env vars at runtime see the override.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

// ── GitHub ───────────────────────────────────────────────────────────

/**
 * Literal fallback values for GitHub org/repo.
 * Consumers should read `GITHUB_REPOSITORY_OWNER` / `GITHUB_REPOSITORY`
 * at call time and fall back to these constants.
 */
export const DEFAULT_GITHUB_ORG = 'ai-sdlc-framework';
export const DEFAULT_GITHUB_REPO = 'ai-sdlc';
export const DEFAULT_GITHUB_REPOSITORY = `${DEFAULT_GITHUB_ORG}/${DEFAULT_GITHUB_REPO}`;

// ── Config directory ─────────────────────────────────────────────────

export const DEFAULT_CONFIG_DIR_NAME = process.env.AI_SDLC_CONFIG_DIR ?? '.ai-sdlc';

// ── Sandbox constraints ──────────────────────────────────────────────

export const DEFAULT_SANDBOX_MEMORY_MB = 512;
export const DEFAULT_SANDBOX_CPU_PERCENT = 80;
export const DEFAULT_SANDBOX_NETWORK_POLICY: NetworkPolicy = 'egress-only';
export const DEFAULT_SANDBOX_TIMEOUT_MS = process.env.AI_SDLC_SANDBOX_TIMEOUT
  ? parseDuration(process.env.AI_SDLC_SANDBOX_TIMEOUT) || 1_800_000
  : 1_800_000; // 30 minutes

/** Build a SandboxConstraints object from defaults, optionally overriding timeout and workDir. */
export function defaultSandboxConstraints(workDir: string, timeoutMs?: number): SandboxConstraints {
  return {
    maxMemoryMb: DEFAULT_SANDBOX_MEMORY_MB,
    maxCpuPercent: DEFAULT_SANDBOX_CPU_PERCENT,
    networkPolicy: DEFAULT_SANDBOX_NETWORK_POLICY,
    timeoutMs: timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    allowedPaths: [workDir],
  };
}

// ── Runner ───────────────────────────────────────────────────────────

export const DEFAULT_RUNNER_TIMEOUT_MS = process.env.AI_SDLC_RUNNER_TIMEOUT
  ? parseDuration(process.env.AI_SDLC_RUNNER_TIMEOUT) || 900_000
  : 900_000; // 15 minutes
export const DEFAULT_ALLOWED_TOOLS = 'Edit,Write,Read,Glob,Grep,Bash';

// ── Agent constraints ────────────────────────────────────────────────

export const DEFAULT_MAX_FILES_PER_CHANGE = 15;
export const DEFAULT_REQUIRE_TESTS = true;
export const DEFAULT_BLOCKED_PATHS = ['.github/workflows/**', `${DEFAULT_CONFIG_DIR_NAME}/**`];

// ── Fix-CI ───────────────────────────────────────────────────────────

export const DEFAULT_MAX_FIX_ATTEMPTS = 2;
export const DEFAULT_MAX_LOG_LINES = 150;
export const DEFAULT_GH_CLI_TIMEOUT_MS = process.env.AI_SDLC_GH_CLI_TIMEOUT
  ? parseDuration(process.env.AI_SDLC_GH_CLI_TIMEOUT) || 30_000
  : 30_000;

// ── JIT credentials ──────────────────────────────────────────────────

export const DEFAULT_JIT_TTL_MS = process.env.AI_SDLC_JIT_TTL
  ? parseDuration(process.env.AI_SDLC_JIT_TTL) || 600_000
  : 600_000; // 10 minutes
export const DEFAULT_JIT_SCOPE = ['repo:read', 'repo:write'];

// ── Branch naming ────────────────────────────────────────────────────

export const DEFAULT_BRANCH_TEMPLATE = 'ai-sdlc/issue-{issueNumber}';
export const DEFAULT_BRANCH_PATTERN = /^ai-sdlc\/issue-(\d+)$/;

// ── PR templates ─────────────────────────────────────────────────────

export const DEFAULT_PR_TITLE_TEMPLATE = 'fix: {issueTitle} (#{issueNumber})';

// ── Complexity routing ───────────────────────────────────────────────

export const DEFAULT_COMPLEXITY_THRESHOLDS = {
  'fully-autonomous': { min: 1, max: 3, strategy: 'fully-autonomous' as const },
  'ai-with-review': { min: 4, max: 5, strategy: 'ai-with-review' as const },
  'ai-assisted': { min: 6, max: 8, strategy: 'ai-assisted' as const },
  'human-led': { min: 9, max: 10, strategy: 'human-led' as const },
};

// ── Autonomy guardrails ──────────────────────────────────────────────

export const DEFAULT_MAX_LINES_PER_PR = {
  level0: 100,
  level1: 300,
  level2: 500,
} as const;

// ── Notification titles ──────────────────────────────────────────────

export const NOTIFICATION_TITLES = {
  issueValidationFailed: 'AI-SDLC: Issue Validation Failed',
  complexityTooHigh: 'AI-SDLC: Complexity Too High',
  agentFailed: 'AI-SDLC: Agent Failed',
  guardrailViolations: 'AI-SDLC: Guardrail Violations',
  prCreated: 'AI-SDLC: PR Created',
  fixCIRetryLimit: 'AI-SDLC: Fix-CI Retry Limit Reached',
  fixCIAgentFailed: 'AI-SDLC: Fix-CI Agent Failed',
  fixCIGuardrailViolations: 'AI-SDLC: Fix-CI Guardrail Violations',
  fixCIApplied: 'AI-SDLC: Fix-CI Applied',
} as const;
