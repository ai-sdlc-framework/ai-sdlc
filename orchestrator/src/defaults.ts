/**
 * Centralized default values for the AI-SDLC orchestrator.
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
 * Fallback values for GitHub org/repo — empty strings require explicit config.
 * Consumers should read `GITHUB_REPOSITORY_OWNER` / `GITHUB_REPOSITORY`
 * at call time and fall back to these constants.
 */
export const DEFAULT_GITHUB_ORG = '';
export const DEFAULT_GITHUB_REPO = '';
export const DEFAULT_GITHUB_REPOSITORY = '';

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

// ── Agent prompt commands ────────────────────────────────────────────

/**
 * Lint command injected into agent prompts.
 * Undefined by default — users opt in via AI_SDLC_LINT_COMMAND env var
 * or by passing `lintCommand` in AgentContext.
 */
export const DEFAULT_LINT_COMMAND: string | undefined =
  process.env.AI_SDLC_LINT_COMMAND ?? undefined;

/**
 * Format command injected into agent prompts.
 * Undefined by default — users opt in via AI_SDLC_FORMAT_COMMAND env var
 * or by passing `formatCommand` in AgentContext.
 */
export const DEFAULT_FORMAT_COMMAND: string | undefined =
  process.env.AI_SDLC_FORMAT_COMMAND ?? undefined;

// ── Commit message ──────────────────────────────────────────────────

export const DEFAULT_COMMIT_MESSAGE_TEMPLATE =
  process.env.AI_SDLC_COMMIT_MESSAGE_TEMPLATE ??
  'fix: resolve issue #{issueNumber}\n\n{issueTitle}';

export const DEFAULT_COMMIT_CO_AUTHOR =
  process.env.AI_SDLC_COMMIT_CO_AUTHOR ?? 'Claude <noreply@anthropic.com>';

// ── Runner registry API defaults ────────────────────────────────────

export const DEFAULT_OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export const DEFAULT_OPENAI_MODEL = 'gpt-4';
export const DEFAULT_ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
export const DEFAULT_GENERIC_LLM_MODEL = 'default';

// ── CLI runner model overrides ────────────────────────────────────────
export const DEFAULT_COPILOT_MODEL: string | undefined = process.env.AI_SDLC_COPILOT_MODEL;
export const DEFAULT_CURSOR_MODEL: string | undefined = process.env.AI_SDLC_CURSOR_MODEL;
export const DEFAULT_CODEX_MODEL: string | undefined = process.env.AI_SDLC_CODEX_MODEL;

// ── Generic LLM defaults ───────────────────────────────────────────

export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
export const DEFAULT_LLM_MAX_TOKENS = 4096;
export const DEFAULT_LLM_SYSTEM_PROMPT =
  'You are a software engineering agent. Implement code changes as instructed.';

// ── Docker / CI adapter defaults ────────────────────────────────────

export const DEFAULT_DOCKER_IMAGE = 'node:20-slim';
export const DEFAULT_WORKFLOW_FILE = 'ci.yml';

// ── Discovery ───────────────────────────────────────────────────────

export const DEFAULT_LABEL_TO_SKILL_MAP: Record<string, string> = {
  bug: 'debugging',
  feature: 'implementation',
  docs: 'documentation',
  test: 'testing',
  refactor: 'refactoring',
  security: 'security-analysis',
  performance: 'optimization',
};

// ── Analysis cache ──────────────────────────────────────────────────

export const DEFAULT_ANALYSIS_CACHE_TTL_MS = process.env.AI_SDLC_ANALYSIS_CACHE_TTL
  ? Number(process.env.AI_SDLC_ANALYSIS_CACHE_TTL)
  : 86_400_000; // 24 hours

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

// ── PR footer ────────────────────────────────────────────────────────

export const DEFAULT_PR_FOOTER =
  '*This PR was generated by [AI-SDLC](https://github.com/ai-sdlc-framework/ai-sdlc).*';

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

// ── Codebase analysis ───────────────────────────────────────────

export const DEFAULT_ANALYSIS_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
export const DEFAULT_ANALYSIS_EXCLUDE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '**/*.d.ts',
  '**/*.min.js',
  '**/*.map',
];
export const DEFAULT_GIT_HISTORY_DAYS = 90;
export const DEFAULT_HOTSPOT_THRESHOLD = 0.3;

// ── Notification titles ──────────────────────────────────────────

// ── Model cost mapping ──────────────────────────────────────────

/** Cost per million tokens for known models (input/output/cache-read). */
export const DEFAULT_MODEL_COSTS: Record<
  string,
  { inputPer1M: number; outputPer1M: number; cacheReadPer1M: number }
> = {
  'claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0, cacheReadPer1M: 1.5 },
  'claude-sonnet-4-5-20250929': { inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.8, outputPer1M: 4.0, cacheReadPer1M: 0.08 },
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.3 },
  'claude-3-5-haiku-20241022': { inputPer1M: 1.0, outputPer1M: 5.0, cacheReadPer1M: 0.1 },
};

/** Default monthly cost budget in USD. */
export const DEFAULT_COST_BUDGET_USD = 500;

/** Dashboard refresh interval in milliseconds. */
export const DEFAULT_DASHBOARD_REFRESH_MS = 2_000;

// ── Progressive gate profiles ──────────────────────────────────

export type ComplexityBand = 'trivial' | 'standard' | 'complex' | 'critical';

export interface GateProfile {
  band: ComplexityBand;
  minScore: number;
  maxScore: number;
  defaultEnforcement: string;
  testCoverageThreshold: number;
  reviewRequired: boolean;
  securityScanRequired: boolean;
  documentationRequired: boolean;
}

/** Static gate profiles per complexity band (RFC 217-228). */
export const PROGRESSIVE_GATE_PROFILES: readonly GateProfile[] = [
  {
    band: 'trivial',
    minScore: 1,
    maxScore: 3,
    defaultEnforcement: 'advisory',
    testCoverageThreshold: 60,
    reviewRequired: false,
    securityScanRequired: false,
    documentationRequired: false,
  },
  {
    band: 'standard',
    minScore: 4,
    maxScore: 6,
    defaultEnforcement: 'soft-mandatory',
    testCoverageThreshold: 75,
    reviewRequired: true,
    securityScanRequired: false,
    documentationRequired: false,
  },
  {
    band: 'complex',
    minScore: 7,
    maxScore: 8,
    defaultEnforcement: 'hard-mandatory',
    testCoverageThreshold: 85,
    reviewRequired: true,
    securityScanRequired: true,
    documentationRequired: true,
  },
  {
    band: 'critical',
    minScore: 9,
    maxScore: 10,
    defaultEnforcement: 'hard-mandatory',
    testCoverageThreshold: 90,
    reviewRequired: true,
    securityScanRequired: true,
    documentationRequired: true,
  },
] as const;

// ── Notification titles ──────────────────────────────────────────

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
  fixReviewRetryLimit: 'AI-SDLC: Fix-Review Retry Limit Reached',
  fixReviewAgentFailed: 'AI-SDLC: Fix-Review Agent Failed',
  fixReviewGuardrailViolations: 'AI-SDLC: Fix-Review Guardrail Violations',
  fixReviewApplied: 'AI-SDLC: Fix-Review Applied',
} as const;
