/**
 * PR Review agent runner — analyzes pull request diffs for testing coverage,
 * code quality, and security issues. Read-only: never modifies files.
 *
 * Uses the Anthropic Messages API directly (not Claude Code CLI)
 * to produce a structured review verdict. Follows the SecurityTriageRunner
 * pattern exactly.
 */

import type { AgentRunner, AgentContext, AgentResult, TokenUsage } from './types.js';
import {
  DEFAULT_ANTHROPIC_API_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
} from '../defaults.js';

// ── Types ────────────────────────────────────────────────────────────

export type ReviewType = 'testing' | 'critic' | 'security';

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  file?: string;
  line?: number;
  message: string;
}

export interface ReviewVerdict {
  type: ReviewType;
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
}

export interface ReviewAgentConfig {
  /** Anthropic API URL. Defaults to https://api.anthropic.com/v1/messages */
  apiUrl?: string;
  /** Anthropic API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to claude-sonnet-4-5. */
  model?: string;
  /** Request timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
  /** Which review perspective to use. */
  reviewType: ReviewType;
}

// ── System prompts ───────────────────────────────────────────────────

const REVIEW_PROMPTS: Record<ReviewType, string> = {
  testing: `You are a testing review agent analyzing a pull request diff. Your job is to verify that the changes are well-tested and that acceptance criteria are met.

Analyze the diff and any provided acceptance criteria. Check for:
1. **Test coverage**: Are new/changed code paths covered by tests?
2. **Acceptance criteria**: If provided, are all acceptance criteria addressed?
3. **Edge cases**: Are boundary conditions and error paths tested?
4. **Test quality**: Are tests meaningful (not just asserting true)?
5. **Missing tests**: Are there obvious test gaps for the changed code?

Respond with ONLY a JSON object (no markdown, no code fences):

{
  "approved": true/false,
  "findings": [
    {"severity": "critical|major|minor|suggestion", "file": "path/to/file.ts", "line": 42, "message": "description"}
  ],
  "summary": "1-2 sentence overall assessment"
}

Severity guide:
- critical: Missing tests for critical paths, acceptance criteria not met
- major: Significant test gaps for changed code
- minor: Minor test improvements possible
- suggestion: Nice-to-have test additions`,

  critic: `You are a code quality review agent analyzing a pull request diff. Your job is to identify code quality issues, logic errors, and design problems.

Analyze the diff for:
1. **Logic errors**: Incorrect conditions, off-by-one errors, race conditions
2. **Code quality**: Naming, readability, unnecessary complexity
3. **Error handling**: Missing error cases, swallowed exceptions
4. **Design patterns**: Violations of existing project patterns/conventions
5. **Performance**: Obvious inefficiencies (N+1 queries, unnecessary allocations)

Do NOT flag style-only issues (formatting, trailing whitespace). Focus on substantive issues.

Respond with ONLY a JSON object (no markdown, no code fences):

{
  "approved": true/false,
  "findings": [
    {"severity": "critical|major|minor|suggestion", "file": "path/to/file.ts", "line": 42, "message": "description"}
  ],
  "summary": "1-2 sentence overall assessment"
}

Severity guide:
- critical: Logic errors, data loss risks, broken functionality
- major: Significant quality issues that should be fixed before merge
- minor: Improvements that would make the code better
- suggestion: Optional enhancements`,

  security: `You are a security review agent analyzing a pull request diff. Your job is to identify security vulnerabilities in the changed code.

Analyze the diff for:
1. **Injection vulnerabilities**: SQL injection, command injection, XSS, template injection
2. **Authentication/authorization**: Missing auth checks, privilege escalation
3. **Credential exposure**: Hardcoded secrets, API keys, tokens in code
4. **Path traversal**: Unsanitized file paths, directory traversal
5. **Unsafe deserialization**: JSON.parse on untrusted input without validation
6. **Dependency issues**: Known vulnerable patterns, unsafe API usage
7. **Information disclosure**: Verbose error messages, stack traces in responses

Respond with ONLY a JSON object (no markdown, no code fences):

{
  "approved": true/false,
  "findings": [
    {"severity": "critical|major|minor|suggestion", "file": "path/to/file.ts", "line": 42, "message": "description"}
  ],
  "summary": "1-2 sentence overall assessment"
}

Severity guide:
- critical: Exploitable vulnerability (injection, credential leak, auth bypass)
- major: Security weakness that should be fixed (missing validation, unsafe patterns)
- minor: Defense-in-depth improvement
- suggestion: Security hardening opportunity`,
};

// ── Runner ───────────────────────────────────────────────────────────

export class ReviewAgentRunner implements AgentRunner {
  private config: ReviewAgentConfig;

  constructor(config: ReviewAgentConfig) {
    this.config = config;
  }

  get reviewType(): ReviewType {
    return this.config.reviewType;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    const apiKey = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        success: false,
        filesChanged: [],
        summary: 'Missing ANTHROPIC_API_KEY for PR review',
        error: 'ANTHROPIC_API_KEY environment variable is not set',
      };
    }

    const userContent = [
      `## Pull Request Diff to Review`,
      '',
      ctx.issueBody, // diff is passed via issueBody
      '',
      ...(ctx.ciErrors ? [`## Acceptance Criteria`, '', ctx.ciErrors, ''] : []),
      `## Context`,
      '',
      `**Issue Title:** ${ctx.issueTitle}`,
    ].join('\n');

    try {
      const verdict = await this.callAPI(apiKey, userContent);

      return {
        success: true,
        filesChanged: [], // Read-only — never modifies files
        summary: JSON.stringify(verdict),
        tokenUsage: verdict._tokenUsage,
      };
    } catch (err) {
      return {
        success: false,
        filesChanged: [],
        summary: 'PR review failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async callAPI(
    apiKey: string,
    userContent: string,
  ): Promise<ReviewVerdict & { _tokenUsage?: TokenUsage }> {
    const apiUrl = this.config.apiUrl ?? DEFAULT_ANTHROPIC_API_URL;
    const model = this.config.model ?? DEFAULT_ANTHROPIC_MODEL;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: REVIEW_PROMPTS[this.config.reviewType],
          messages: [{ role: 'user', content: userContent }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
      }

      const body = (await res.json()) as {
        content: Array<{ type: string; text: string }>;
        usage?: { input_tokens: number; output_tokens: number };
        model?: string;
      };

      const text = body.content?.[0]?.text ?? '';
      const verdict = this.parseVerdict(text);

      const tokenUsage: TokenUsage | undefined = body.usage
        ? {
            inputTokens: body.usage.input_tokens,
            outputTokens: body.usage.output_tokens,
            model: body.model ?? model,
          }
        : undefined;

      return { ...verdict, _tokenUsage: tokenUsage };
    } finally {
      clearTimeout(timeout);
    }
  }

  parseVerdict(text: string): ReviewVerdict {
    // Strip markdown fences if the model wraps the JSON
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
        type: this.config.reviewType,
        approved: Boolean(parsed.approved),
        findings,
        summary: String(parsed.summary ?? ''),
      };
    } catch {
      // If JSON parse fails, treat as not approved — conservative
      return {
        type: this.config.reviewType,
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
}

// ── Exported prompts for testing ─────────────────────────────────────

export { REVIEW_PROMPTS };
