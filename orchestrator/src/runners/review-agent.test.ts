import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ReviewAgentRunner,
  REVIEW_PROMPTS,
  type ReviewType,
  type ReviewVerdict,
} from './review-agent.js';
import type { AgentContext } from './types.js';

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issueId: 'PR-1',
    issueNumber: 1,
    issueTitle: 'Fix alignment bug',
    issueBody: 'diff --git a/src/widget.ts b/src/widget.ts\n...',
    workDir: '/tmp',
    branch: 'ai-sdlc/issue-1',
    constraints: {
      maxFilesPerChange: 0,
      requireTests: false,
      blockedPaths: [],
    },
    ...overrides,
  };
}

function mockFetchResponse(verdict: Partial<ReviewVerdict>) {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(verdict) }],
      usage: { input_tokens: 100, output_tokens: 50 },
      model: 'claude-sonnet-4-5-20250514',
    }),
    text: async () => '',
  };
}

describe('ReviewAgentRunner', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('returns error when API key is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const runner = new ReviewAgentRunner({ reviewType: 'testing' });
    const result = await runner.run(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain('ANTHROPIC_API_KEY');
  });

  for (const type of ['testing', 'critic', 'security'] as ReviewType[]) {
    it(`uses correct system prompt for ${type} review`, async () => {
      let capturedBody: string = '';
      globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
        capturedBody = (init as RequestInit).body as string;
        return mockFetchResponse({
          approved: true,
          findings: [],
          summary: 'All good',
        }) as Response;
      });

      const runner = new ReviewAgentRunner({ reviewType: type });
      await runner.run(makeContext());

      const parsed = JSON.parse(capturedBody);
      expect(parsed.system).toBe(REVIEW_PROMPTS[type]);
    });
  }

  it('prepends reviewPolicy to system prompt when provided', async () => {
    let capturedBody: string = '';
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      capturedBody = (init as RequestInit).body as string;
      return mockFetchResponse({
        approved: true,
        findings: [],
        summary: 'ok',
      }) as Response;
    });

    const runner = new ReviewAgentRunner({
      reviewType: 'security',
      reviewPolicy: '# Project Review Policy\nBounded regex is safe.',
    });
    await runner.run(makeContext());

    const parsed = JSON.parse(capturedBody);
    expect(parsed.system).toContain('# Project Review Policy');
    expect(parsed.system).toContain('Bounded regex is safe.');
    expect(parsed.system).toContain('---');
    expect(parsed.system).toContain(REVIEW_PROMPTS.security);
  });

  it('uses default prompt when reviewPolicy is undefined', async () => {
    let capturedBody: string = '';
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      capturedBody = (init as RequestInit).body as string;
      return mockFetchResponse({
        approved: true,
        findings: [],
        summary: 'ok',
      }) as Response;
    });

    const runner = new ReviewAgentRunner({ reviewType: 'critic' });
    await runner.run(makeContext());

    const parsed = JSON.parse(capturedBody);
    expect(parsed.system).toBe(REVIEW_PROMPTS.critic);
    expect(parsed.system).not.toContain('---');
  });

  it('parses a valid approval verdict', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        mockFetchResponse({
          approved: true,
          findings: [],
          summary: 'Code looks good',
        }) as Response,
    );

    const runner = new ReviewAgentRunner({ reviewType: 'critic' });
    const result = await runner.run(makeContext());

    expect(result.success).toBe(true);
    const verdict = JSON.parse(result.summary) as ReviewVerdict;
    expect(verdict.approved).toBe(true);
    expect(verdict.type).toBe('critic');
    expect(verdict.findings).toEqual([]);
  });

  it('parses findings with file and line info', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        mockFetchResponse({
          approved: false,
          findings: [
            {
              severity: 'major',
              file: 'src/widget.ts',
              line: 42,
              message: 'Missing null check',
            },
          ],
          summary: 'Issues found',
        }) as Response,
    );

    const runner = new ReviewAgentRunner({ reviewType: 'security' });
    const result = await runner.run(makeContext());

    const verdict = JSON.parse(result.summary) as ReviewVerdict;
    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].severity).toBe('major');
    expect(verdict.findings[0].file).toBe('src/widget.ts');
    expect(verdict.findings[0].line).toBe(42);
  });

  it('handles markdown-wrapped JSON response', () => {
    const runner = new ReviewAgentRunner({ reviewType: 'testing' });
    const text = '```json\n{"approved":true,"findings":[],"summary":"ok"}\n```';
    const verdict = runner.parseVerdict(text);
    expect(verdict.approved).toBe(true);
  });

  it('returns not-approved on invalid JSON', () => {
    const runner = new ReviewAgentRunner({ reviewType: 'testing' });
    const verdict = runner.parseVerdict('not json at all');
    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].severity).toBe('critical');
  });

  it('clamps unknown severity to minor', () => {
    const runner = new ReviewAgentRunner({ reviewType: 'critic' });
    const verdict = runner.parseVerdict(
      JSON.stringify({
        approved: true,
        findings: [{ severity: 'unknown-level', message: 'test' }],
        summary: 'ok',
      }),
    );
    expect(verdict.findings[0].severity).toBe('minor');
  });

  it('handles API error response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        }) as Response,
    );

    const runner = new ReviewAgentRunner({ reviewType: 'testing' });
    const result = await runner.run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('includes token usage in result', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        mockFetchResponse({
          approved: true,
          findings: [],
          summary: 'ok',
        }) as Response,
    );

    const runner = new ReviewAgentRunner({ reviewType: 'critic' });
    const result = await runner.run(makeContext());

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.inputTokens).toBe(100);
    expect(result.tokenUsage!.outputTokens).toBe(50);
  });

  it('passes acceptance criteria via ciErrors field', async () => {
    let capturedBody: string = '';
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      capturedBody = (init as RequestInit).body as string;
      return mockFetchResponse({
        approved: true,
        findings: [],
        summary: 'ok',
      }) as Response;
    });

    const runner = new ReviewAgentRunner({ reviewType: 'testing' });
    await runner.run(makeContext({ ciErrors: '- [ ] Widget renders centered' }));

    const parsed = JSON.parse(capturedBody);
    const userMsg = parsed.messages[0].content;
    expect(userMsg).toContain('Acceptance Criteria');
    expect(userMsg).toContain('Widget renders centered');
  });
});

describe('CI boundary preamble', () => {
  const reviewTypes: ReviewType[] = ['testing', 'critic', 'security'];

  for (const type of reviewTypes) {
    it(`${type} prompt includes CI Boundary section`, () => {
      expect(REVIEW_PROMPTS[type]).toContain('CI Boundary');
      expect(REVIEW_PROMPTS[type]).toContain('Do NOT flag issues that these checks catch');
    });

    it(`${type} prompt lists deterministic CI checks`, () => {
      const prompt = REVIEW_PROMPTS[type];
      expect(prompt).toContain('Lint');
      expect(prompt).toContain('Format');
      expect(prompt).toContain('typecheck');
      expect(prompt).toContain('Coverage');
    });

    it(`${type} prompt lists what IS in scope`, () => {
      expect(REVIEW_PROMPTS[type]).toContain('Logic errors');
      expect(REVIEW_PROMPTS[type]).toContain('Security vulnerabilities');
    });
  }

  it('testing prompt tells agents not to flag coverage percentages', () => {
    expect(REVIEW_PROMPTS.testing).toContain('Do NOT flag coverage percentages');
    expect(REVIEW_PROMPTS.testing).toContain('Codecov handles that');
  });

  it('critic prompt tells agents not to flag style or type errors', () => {
    expect(REVIEW_PROMPTS.critic).toContain('Do NOT flag');
    expect(REVIEW_PROMPTS.critic).toContain('ESLint');
    expect(REVIEW_PROMPTS.critic).toContain('Prettier');
    expect(REVIEW_PROMPTS.critic).toContain('TypeScript');
  });

  it('security prompt tells agents not to flag type safety issues', () => {
    expect(REVIEW_PROMPTS.security).toContain('TypeScript handles these');
  });
});

describe('structured reasoning output', () => {
  const reviewTypes: ReviewType[] = ['testing', 'critic', 'security'];

  for (const type of reviewTypes) {
    it(`${type} prompt requires confidence scores`, () => {
      expect(REVIEW_PROMPTS[type]).toContain('confidence');
      expect(REVIEW_PROMPTS[type]).toContain('0.0-1.0');
    });

    it(`${type} prompt requires evidence for critical/major`, () => {
      expect(REVIEW_PROMPTS[type]).toContain('MUST have failureScenario');
      expect(REVIEW_PROMPTS[type]).toContain('No evidence = no critical/major');
    });

    it(`${type} prompt mentions automatic suppression of low confidence`, () => {
      expect(REVIEW_PROMPTS[type]).toContain('below 0.5 confidence');
      expect(REVIEW_PROMPTS[type]).toContain('automatically suppressed');
    });

    it(`${type} prompt includes category field`, () => {
      expect(REVIEW_PROMPTS[type]).toContain('"category"');
    });
  }
});

describe('confidence-based filtering', () => {
  let runner: ReviewAgentRunner;

  beforeEach(() => {
    runner = new ReviewAgentRunner({ reviewType: 'critic' });
  });

  it('filters out findings below 0.5 confidence', () => {
    const verdict = runner.parseVerdict(
      JSON.stringify({
        approved: true,
        findings: [
          { severity: 'minor', confidence: 0.3, message: 'low confidence issue' },
          { severity: 'major', confidence: 0.8, message: 'high confidence issue' },
        ],
        summary: 'Mixed confidence',
      }),
    );

    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].message).toBe('high confidence issue');
  });

  it('keeps findings without confidence score (backward compat)', () => {
    const verdict = runner.parseVerdict(
      JSON.stringify({
        approved: true,
        findings: [{ severity: 'minor', message: 'no confidence field' }],
        summary: 'Legacy format',
      }),
    );

    expect(verdict.findings).toHaveLength(1);
  });

  it('parses evidence fields', () => {
    const verdict = runner.parseVerdict(
      JSON.stringify({
        approved: false,
        findings: [
          {
            severity: 'critical',
            confidence: 0.95,
            category: 'logic-error',
            file: 'src/foo.ts',
            line: 42,
            evidence: {
              codePathTraced: 'Function X calls Y',
              failureScenario: 'Null pointer on empty input',
            },
            message: 'NPE risk',
          },
        ],
        summary: 'Critical bug found',
      }),
    );

    expect(verdict.findings[0].confidence).toBe(0.95);
    expect(verdict.findings[0].category).toBe('logic-error');
    expect(verdict.findings[0].evidence?.codePathTraced).toBe('Function X calls Y');
    expect(verdict.findings[0].evidence?.failureScenario).toBe('Null pointer on empty input');
  });

  it('filters all low-confidence findings and keeps approved status', () => {
    const verdict = runner.parseVerdict(
      JSON.stringify({
        approved: true,
        findings: [
          { severity: 'suggestion', confidence: 0.2, message: 'very low' },
          { severity: 'minor', confidence: 0.4, message: 'below threshold' },
        ],
        summary: 'All filtered',
      }),
    );

    expect(verdict.findings).toHaveLength(0);
    expect(verdict.approved).toBe(true);
  });

  it('keeps findings at exactly 0.5 confidence', () => {
    const verdict = runner.parseVerdict(
      JSON.stringify({
        approved: true,
        findings: [{ severity: 'minor', confidence: 0.5, message: 'at threshold' }],
        summary: 'Edge case',
      }),
    );

    expect(verdict.findings).toHaveLength(1);
  });
});
