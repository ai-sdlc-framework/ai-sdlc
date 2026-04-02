/**
 * SDK-orchestrated parallel review runner.
 *
 * Spawns 3 concurrent Claude Code SDK queries — testing, security, and quality —
 * each with per-reviewer tool restrictions and budget caps. Uses the Agent SDK
 * query() API instead of the Anthropic Messages API directly.
 *
 * Advantages over ReviewAgentRunner:
 * - Reviewers have tool access (can read files, run tests, grep for patterns)
 * - Per-reviewer tool restrictions (security reviewer can't run Bash)
 * - Budget cap per reviewer ($0.50 default)
 * - Turn limit per reviewer (20 default)
 * - Review policy injected via appendSystemPrompt
 */

import type { TokenUsage } from './types.js';
import {
  REVIEW_PROMPTS,
  type ReviewType,
  type ReviewVerdict,
  type ReviewFinding,
} from './review-agent.js';

/** Configuration for a single review perspective. */
export interface SdkReviewConfig {
  type: ReviewType;
  /** SDK tools the reviewer can use. */
  allowedTools: string[];
  /** SDK tools the reviewer cannot use. */
  disallowedTools: string[];
  /** Budget cap in USD. Default: 0.50 */
  maxBudgetUsd?: number;
  /** Turn limit. Default: 20 */
  maxTurns?: number;
  /** Model override. */
  model?: string;
}

/** Default per-reviewer configurations. */
export const DEFAULT_REVIEW_CONFIGS: SdkReviewConfig[] = [
  {
    type: 'testing',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash(pnpm test*)', 'Bash(npm test*)'],
    disallowedTools: ['Edit', 'Write', 'AgentTool'],
  },
  {
    type: 'security',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Bash', 'Edit', 'Write', 'AgentTool'],
  },
  {
    type: 'critic',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash(pnpm lint*)'],
    disallowedTools: ['Edit', 'Write', 'AgentTool'],
  },
];

const DEFAULT_REVIEW_BUDGET_USD = 0.5;
const DEFAULT_REVIEW_MAX_TURNS = 20;
const DEFAULT_REVIEW_MODEL = 'claude-sonnet-4-6';

export interface SdkParallelReviewOptions {
  /** PR diff content. */
  diff: string;
  /** PR title for context. */
  prTitle: string;
  /** PR number. */
  prNumber: number;
  /** Review policy content (from .ai-sdlc/review-policy.md). */
  reviewPolicy?: string;
  /** Working directory (for tool access). */
  workDir: string;
  /** Per-reviewer configurations. Defaults to DEFAULT_REVIEW_CONFIGS. */
  reviewConfigs?: SdkReviewConfig[];
  /** Model override for all reviewers. */
  model?: string;
}

export interface SdkParallelReviewResult {
  verdicts: ReviewVerdict[];
  allApproved: boolean;
  totalTokenUsage: TokenUsage;
  errors: string[];
}

/**
 * Run parallel SDK-orchestrated reviews.
 *
 * Returns combined verdicts from all reviewers.
 */
export async function runParallelSdkReviews(
  options: SdkParallelReviewOptions,
): Promise<SdkParallelReviewResult> {
  // Dynamic import — SDK is an optional peer dependency
  let query: (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }) => AsyncIterable<Record<string, unknown>>;

  /* v8 ignore start — dynamic import fails in unit tests (SDK not installed) */
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    query = sdk.query;
  } catch {
    return {
      verdicts: [],
      allApproved: false,
      totalTokenUsage: { inputTokens: 0, outputTokens: 0, model: 'unknown' },
      errors: ['@anthropic-ai/claude-agent-sdk is not installed. Install it to use SDK reviews.'],
    };
  }
  /* v8 ignore stop */

  const configs = options.reviewConfigs ?? DEFAULT_REVIEW_CONFIGS;
  const model = options.model ?? DEFAULT_REVIEW_MODEL;

  // Launch all reviews in parallel
  const reviewPromises = configs.map((config) => runSingleReview(query, config, options, model));

  const results = await Promise.allSettled(reviewPromises);

  const verdicts: ReviewVerdict[] = [];
  const errors: string[] = [];
  let totalInput = 0;
  let totalOutput = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      verdicts.push(result.value.verdict);
      if (result.value.tokenUsage) {
        totalInput += result.value.tokenUsage.inputTokens;
        totalOutput += result.value.tokenUsage.outputTokens;
      }
    } else {
      errors.push(result.reason?.message ?? String(result.reason));
    }
  }

  return {
    verdicts,
    allApproved: verdicts.length > 0 && verdicts.every((v) => v.approved),
    totalTokenUsage: { inputTokens: totalInput, outputTokens: totalOutput, model },
    errors,
  };
}

/* v8 ignore start — SDK streaming loop requires real SDK connection */
async function runSingleReview(
  query: (params: {
    prompt: string;
    options?: Record<string, unknown>;
  }) => AsyncIterable<Record<string, unknown>>,
  config: SdkReviewConfig,
  options: SdkParallelReviewOptions,
  model: string,
): Promise<{ verdict: ReviewVerdict; tokenUsage?: TokenUsage }> {
  const prompt = buildReviewPrompt(config.type, options);
  const systemPrompt = options.reviewPolicy
    ? `${options.reviewPolicy}\n\n---\n\n${REVIEW_PROMPTS[config.type]}`
    : REVIEW_PROMPTS[config.type];

  let responseText = '';
  let tokenUsage: TokenUsage | undefined;

  const result = query({
    prompt,
    options: {
      model: config.model ?? model,
      maxTurns: config.maxTurns ?? DEFAULT_REVIEW_MAX_TURNS,
      maxBudgetUsd: config.maxBudgetUsd ?? DEFAULT_REVIEW_BUDGET_USD,
      appendSystemPrompt: systemPrompt,
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
      permissionMode: 'acceptEdits',
      cwd: options.workDir,
    },
  });

  for await (const msg of result) {
    const msgType = msg.type as string;

    if (msgType === 'assistant') {
      const blocks = (msg.message as Record<string, unknown>)?.content as
        | Array<Record<string, unknown>>
        | undefined;
      if (blocks) {
        for (const block of blocks) {
          if (block.type === 'text') {
            responseText = (block.text as string) ?? '';
          }
        }
      }
    }

    if (msgType === 'result') {
      const usage = msg.usage as Record<string, number> | undefined;
      if (usage) {
        tokenUsage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          model: (msg.model as string) ?? model,
        };
      }
    }
  }

  const verdict = parseReviewVerdict(config.type, responseText);
  return { verdict, tokenUsage };
}
/* v8 ignore stop */

/** @internal Exported for testing. */
export function buildReviewPrompt(type: ReviewType, options: SdkParallelReviewOptions): string {
  return [
    `## Pull Request #${options.prNumber}: ${options.prTitle}`,
    '',
    'Review the following diff and use your available tools to inspect the codebase for additional context.',
    '',
    '```diff',
    options.diff,
    '```',
    '',
    'Respond with ONLY a JSON object containing your verdict (approved, findings, summary).',
  ].join('\n');
}

/** @internal Exported for testing. */
export function parseReviewVerdict(type: ReviewType, text: string): ReviewVerdict {
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '');

  try {
    const parsed = JSON.parse(cleaned);

    const findings: ReviewFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.map((f: Record<string, unknown>) => ({
          severity: ['critical', 'major', 'minor', 'suggestion'].includes(String(f.severity))
            ? (String(f.severity) as ReviewFinding['severity'])
            : 'minor',
          file: f.file ? String(f.file) : undefined,
          line: typeof f.line === 'number' ? f.line : undefined,
          message: String(f.message ?? ''),
        }))
      : [];

    return {
      type,
      approved: Boolean(parsed.approved),
      findings,
      summary: String(parsed.summary ?? ''),
    };
  } catch {
    return {
      type,
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'Failed to parse review verdict — treating as not approved',
        },
      ],
      summary: `Review agent response was not valid JSON: ${text.slice(0, 200)}`,
    };
  }
}
