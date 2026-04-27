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
  /** Self-assessed confidence score (0-1). Findings below 0.5 are suppressed. */
  confidence?: number;
  /** Category of the finding. */
  category?: 'logic-error' | 'security' | 'design' | 'performance' | 'testing' | 'other';
  /** Evidence supporting the finding. Required for critical/major. */
  evidence?: {
    codePathTraced?: string;
    failureScenario?: string;
  };
}

/** Minimum confidence to include a finding in the verdict. */
const CONFIDENCE_THRESHOLD = 0.5;

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
  /**
   * Model to escalate to when the input exceeds the large-context threshold.
   * Defaults to AI_SDLC_REVIEW_LARGE_MODEL env var, then claude-opus-4-7.
   */
  largeContextModel?: string;
  /**
   * Char-count threshold above which the runner switches to `largeContextModel`
   * and sets the Anthropic 1M-context beta header. Default ~150k tokens
   * (the standard Anthropic context limit) at the 4-chars-per-token heuristic.
   */
  largeContextThresholdChars?: number;
  /** Request timeout in ms. Defaults to 120_000. */
  timeoutMs?: number;
  /** Which review perspective to use. */
  reviewType: ReviewType;
  /** Project-specific review policy to prepend to the system prompt (calibration context). */
  reviewPolicy?: string;
}

/**
 * Default escalation threshold. Anthropic's standard context window is 200k tokens;
 * we leave headroom for the system prompt + response and trigger escalation around
 * 150k tokens (≈ 600k chars at the 4-char/token heuristic). The user's recurring
 * "PR too large for review" failure on PR #67 happened above this threshold.
 */
const DEFAULT_LARGE_CONTEXT_THRESHOLD_CHARS = 600_000;
const DEFAULT_LARGE_CONTEXT_MODEL = process.env.AI_SDLC_REVIEW_LARGE_MODEL ?? 'claude-opus-4-7';
/** Anthropic 1M-context beta header. Required when sending > 200k tokens. */
const ANTHROPIC_LONG_CONTEXT_BETA = 'context-1m-2025-08-07';

// ── CI boundary ─────────────────────────────────────────────────────

/**
 * Declarative CI boundary — tells review agents what CI already validates.
 * Agents MUST NOT duplicate findings for issues CI catches deterministically.
 * Prepended to every REVIEW_PROMPTS entry.
 */
const CI_BOUNDARY_PREAMBLE = `## CI Boundary — What You Must NOT Flag

The following checks run deterministically in CI on every PR. They are authoritative.
Do NOT flag issues that these checks catch — they run independently and will pass or fail
on their own. If CI covers it, it is OUT OF YOUR SCOPE.

**CI checks (deterministic, authoritative):**
- **Lint (ESLint)**: All lint violations, unused imports, naming conventions
- **Format (Prettier)**: All formatting — whitespace, semicolons, commas, line length
- **TypeScript typecheck (pnpm build)**: Type errors, missing types, generics
- **Unit tests (Vitest)**: Test failures, broken assertions
- **Coverage (Codecov patch)**: Line coverage on changed code (80% patch target)
- **Schema validation**: YAML/JSON schema conformance

**Your job is to find issues CI CANNOT catch:**
- Logic errors that pass type checking but produce wrong results
- Security vulnerabilities (injection, auth bypass, credential exposure)
- Missing error handling for edge cases that tests don't cover
- Design problems (wrong abstraction, pattern violations)
- Race conditions and concurrency issues
- Performance anti-patterns (N+1 queries, unbounded allocations)
- Acceptance criteria not addressed by the implementation

**If unsure whether CI catches something, do NOT flag it.**

`;

// ── System prompts ───────────────────────────────────────────────────

const REVIEW_PROMPTS: Record<ReviewType, string> = {
  testing: `${CI_BOUNDARY_PREAMBLE}You are a testing review agent analyzing a pull request diff. Your job is to verify that the changes are well-tested and that acceptance criteria are met.

Analyze the diff and any provided acceptance criteria. Check for:
1. **Untested logic paths**: Are there logic branches that existing tests don't exercise? (Do NOT flag coverage percentages — Codecov handles that.)
2. **Acceptance criteria**: If provided, are all acceptance criteria addressed?
3. **Edge cases**: Are boundary conditions and error paths tested?
4. **Test quality**: Are tests meaningful (not just asserting true)?
5. **Missing edge-case tests**: Are there missing tests for error paths and boundary conditions that the test suite cannot catch?

Do NOT flag: coverage percentages, missing tests for config/YAML files, type-only files, or barrel exports. Codecov and CI handle these.

## Structured Output Format

Respond with ONLY a JSON object (no markdown, no code fences).

Each finding MUST include a confidence score (0.0-1.0) and a category.
For critical/major findings, you MUST include evidence with a concrete failure scenario.
**No evidence = no critical/major finding.** If you cannot trace the code path to a failure, downgrade to minor/suggestion.
Findings below 0.5 confidence will be automatically suppressed.

{
  "approved": true/false,
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "confidence": 0.0-1.0,
      "category": "testing|logic-error|security|design|performance|other",
      "file": "path/to/file.ts",
      "line": 42,
      "evidence": {
        "codePathTraced": "Function X calls Y which can return null when Z",
        "failureScenario": "When input is empty, line 42 throws TypeError"
      },
      "message": "Concise description of the issue"
    }
  ],
  "summary": "1-2 sentence overall assessment"
}

Severity guide:
- critical: Missing tests for critical logic paths, acceptance criteria not met. MUST have failureScenario.
- major: Significant untested logic branches. MUST have failureScenario.
- minor: Minor test improvements possible
- suggestion: Nice-to-have test additions`,

  critic: `${CI_BOUNDARY_PREAMBLE}You are a code quality review agent analyzing a pull request diff. Your job is to identify logic errors and design problems.

Analyze the diff for:
1. **Logic errors**: Incorrect conditions, off-by-one errors, race conditions
2. **Design issues**: Wrong abstraction, unnecessary complexity, pattern violations
3. **Error handling**: Missing error cases at system boundaries
4. **Performance**: Obvious inefficiencies (N+1 queries, unbounded allocations)

Do NOT flag: style issues (formatting, whitespace, import order), type errors, lint violations, or naming conventions. ESLint, Prettier, and TypeScript handle these deterministically.

## Structured Output Format

Respond with ONLY a JSON object (no markdown, no code fences).

Each finding MUST include a confidence score (0.0-1.0) and a category.
For critical/major findings, you MUST include evidence with a concrete failure scenario.
**No evidence = no critical/major finding.** If you cannot trace the code path to a failure, downgrade to minor/suggestion.
Findings below 0.5 confidence will be automatically suppressed.

{
  "approved": true/false,
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "confidence": 0.0-1.0,
      "category": "logic-error|design|performance|other",
      "file": "path/to/file.ts",
      "line": 42,
      "evidence": {
        "codePathTraced": "Function X calls Y which can return null when Z",
        "failureScenario": "When input is empty, line 42 throws TypeError"
      },
      "message": "Concise description of the issue"
    }
  ],
  "summary": "1-2 sentence overall assessment"
}

Severity guide:
- critical: Logic errors, data loss risks, broken functionality. MUST have failureScenario.
- major: Significant design issues that should be fixed before merge. MUST have failureScenario.
- minor: Improvements that would make the code better
- suggestion: Optional enhancements`,

  security: `${CI_BOUNDARY_PREAMBLE}You are a security review agent analyzing a pull request diff. Your job is to identify security vulnerabilities in the changed code.

Analyze the diff for:
1. **Injection vulnerabilities**: SQL injection, command injection, XSS, template injection
2. **Authentication/authorization**: Missing auth checks, privilege escalation
3. **Credential exposure**: Hardcoded secrets, API keys, tokens in code
4. **Path traversal**: Unsanitized file paths, directory traversal
5. **Unsafe deserialization**: JSON.parse on untrusted input without validation
6. **Dependency issues**: Known vulnerable patterns, unsafe API usage

Do NOT flag: type safety issues (TypeScript handles these), or issues in trusted internal code paths (config files, env vars set by the platform).

## Structured Output Format

Respond with ONLY a JSON object (no markdown, no code fences).

Each finding MUST include a confidence score (0.0-1.0) and a category.
For critical/major findings, you MUST include evidence with a concrete failure scenario.
**No evidence = no critical/major finding.** If you cannot describe a realistic attack vector, downgrade to minor/suggestion.
Findings below 0.5 confidence will be automatically suppressed.

{
  "approved": true/false,
  "findings": [
    {
      "severity": "critical|major|minor|suggestion",
      "confidence": 0.0-1.0,
      "category": "security|other",
      "file": "path/to/file.ts",
      "line": 42,
      "evidence": {
        "codePathTraced": "User input flows from X to Y without sanitization",
        "failureScenario": "Attacker sends malicious input via Z, causing command injection at line 42"
      },
      "message": "Concise description of the vulnerability"
    }
  ],
  "summary": "1-2 sentence overall assessment"
}

Severity guide:
- critical: Exploitable vulnerability (injection, credential leak, auth bypass). MUST have failureScenario with attack vector.
- major: Security weakness that should be fixed (missing validation, unsafe patterns). MUST have failureScenario.
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
    const baseModel = this.config.model ?? DEFAULT_ANTHROPIC_MODEL;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

    const system = this.config.reviewPolicy
      ? `${this.config.reviewPolicy}\n\n---\n\n${REVIEW_PROMPTS[this.config.reviewType]}`
      : REVIEW_PROMPTS[this.config.reviewType];

    // Escalate to a 1M-context model when the input is large enough to risk
    // overflowing the standard 200k-token window. The signal we use is char count
    // of (system + user) since precise tokenization isn't available client-side.
    const threshold =
      this.config.largeContextThresholdChars ?? DEFAULT_LARGE_CONTEXT_THRESHOLD_CHARS;
    const inputChars = system.length + userContent.length;
    const escalate = inputChars > threshold;
    const model = escalate
      ? (this.config.largeContextModel ?? DEFAULT_LARGE_CONTEXT_MODEL)
      : baseModel;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
      if (escalate) headers['anthropic-beta'] = ANTHROPIC_LONG_CONTEXT_BETA;

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system,
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

      const rawFindings: ReviewFinding[] = Array.isArray(parsed.findings)
        ? parsed.findings.map((f: Record<string, unknown>) => {
            const evidence = f.evidence as Record<string, unknown> | undefined;
            return {
              severity: ['critical', 'major', 'minor', 'suggestion'].includes(String(f.severity))
                ? (String(f.severity) as ReviewFinding['severity'])
                : 'minor',
              file: f.file ? String(f.file) : undefined,
              line: typeof f.line === 'number' ? f.line : undefined,
              message: String(f.message ?? ''),
              confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
              category: f.category ? (String(f.category) as ReviewFinding['category']) : undefined,
              evidence: evidence
                ? {
                    codePathTraced: evidence.codePathTraced
                      ? String(evidence.codePathTraced)
                      : undefined,
                    failureScenario: evidence.failureScenario
                      ? String(evidence.failureScenario)
                      : undefined,
                  }
                : undefined,
            };
          })
        : [];

      // Filter out low-confidence findings
      const findings = rawFindings.filter(
        (f) => f.confidence === undefined || f.confidence >= CONFIDENCE_THRESHOLD,
      );

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
