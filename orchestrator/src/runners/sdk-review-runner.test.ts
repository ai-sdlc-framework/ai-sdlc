import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVIEW_CONFIGS,
  type SdkReviewConfig,
  type SdkParallelReviewOptions,
  runParallelSdkReviews,
  buildReviewPrompt,
  parseReviewVerdict,
} from './sdk-review-runner.js';

// ── DEFAULT_REVIEW_CONFIGS ──────────────────────────────────────────

describe('DEFAULT_REVIEW_CONFIGS', () => {
  it('has 3 reviewer configurations', () => {
    expect(DEFAULT_REVIEW_CONFIGS).toHaveLength(3);
  });

  it('covers testing, security, and critic types', () => {
    const types = DEFAULT_REVIEW_CONFIGS.map((c) => c.type);
    expect(types).toContain('testing');
    expect(types).toContain('security');
    expect(types).toContain('critic');
  });

  it('security reviewer cannot use Bash', () => {
    const security = DEFAULT_REVIEW_CONFIGS.find((c) => c.type === 'security')!;
    expect(security.disallowedTools).toContain('Bash');
  });

  it('no reviewer can use Edit or Write', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.disallowedTools).toContain('Edit');
      expect(config.disallowedTools).toContain('Write');
    }
  });

  it('no reviewer can spawn sub-agents', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.disallowedTools).toContain('AgentTool');
    }
  });

  it('all reviewers have Read access', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.allowedTools).toContain('Read');
    }
  });

  it('all reviewers have Grep and Glob access', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.allowedTools).toContain('Grep');
      expect(config.allowedTools).toContain('Glob');
    }
  });

  it('testing reviewer can run pnpm test and npm test', () => {
    const testing = DEFAULT_REVIEW_CONFIGS.find((c) => c.type === 'testing')!;
    expect(testing.allowedTools).toContain('Bash(pnpm test*)');
    expect(testing.allowedTools).toContain('Bash(npm test*)');
  });

  it('critic reviewer can run pnpm lint', () => {
    const critic = DEFAULT_REVIEW_CONFIGS.find((c) => c.type === 'critic')!;
    expect(critic.allowedTools).toContain('Bash(pnpm lint*)');
  });

  it('security reviewer has no Bash access at all', () => {
    const security = DEFAULT_REVIEW_CONFIGS.find((c) => c.type === 'security')!;
    const hasBash = security.allowedTools.some((t) => t.startsWith('Bash'));
    expect(hasBash).toBe(false);
    expect(security.disallowedTools).toContain('Bash');
  });

  it('none of the configs set optional fields (maxBudgetUsd, maxTurns, model)', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.maxBudgetUsd).toBeUndefined();
      expect(config.maxTurns).toBeUndefined();
      expect(config.model).toBeUndefined();
    }
  });
});

// ── buildReviewPrompt ───────────────────────────────────────────────

describe('buildReviewPrompt', () => {
  const baseOptions: SdkParallelReviewOptions = {
    diff: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
    prTitle: 'Fix authentication bug',
    prNumber: 123,
    workDir: '/tmp/repo',
  };

  it('includes the PR number and title in the prompt', () => {
    const prompt = buildReviewPrompt('testing', baseOptions);
    expect(prompt).toContain('Pull Request #123');
    expect(prompt).toContain('Fix authentication bug');
  });

  it('includes the diff content', () => {
    const prompt = buildReviewPrompt('testing', baseOptions);
    expect(prompt).toContain('--- a/file.ts');
    expect(prompt).toContain('+++ b/file.ts');
    expect(prompt).toContain('-old');
    expect(prompt).toContain('+new');
  });

  it('wraps the diff in a code fence', () => {
    const prompt = buildReviewPrompt('testing', baseOptions);
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('```');
  });

  it('asks for a JSON response', () => {
    const prompt = buildReviewPrompt('testing', baseOptions);
    expect(prompt).toContain('JSON object');
  });

  it('works for all review types', () => {
    for (const type of ['testing', 'security', 'critic'] as const) {
      const prompt = buildReviewPrompt(type, baseOptions);
      expect(prompt).toContain('#123');
    }
  });

  it('handles large diff content', () => {
    const largeDiff = 'x'.repeat(50000);
    const prompt = buildReviewPrompt('testing', { ...baseOptions, diff: largeDiff });
    expect(prompt).toContain(largeDiff);
  });

  it('handles special characters in PR title', () => {
    const prompt = buildReviewPrompt('testing', {
      ...baseOptions,
      prTitle: 'Fix "escaping" & <html> bugs',
    });
    expect(prompt).toContain('Fix "escaping" & <html> bugs');
  });
});

// ── parseReviewVerdict ──────────────────────────────────────────────

describe('parseReviewVerdict', () => {
  it('parses valid JSON with approved: true', () => {
    const json = JSON.stringify({
      approved: true,
      findings: [],
      summary: 'All tests pass',
    });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.type).toBe('testing');
    expect(verdict.approved).toBe(true);
    expect(verdict.findings).toEqual([]);
    expect(verdict.summary).toBe('All tests pass');
  });

  it('parses valid JSON with approved: false and findings', () => {
    const json = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          file: 'src/auth.ts',
          line: 42,
          message: 'Missing input validation',
        },
        {
          severity: 'minor',
          message: 'Consider adding more tests',
        },
      ],
      summary: 'Critical security issue found',
    });

    const verdict = parseReviewVerdict('security', json);
    expect(verdict.type).toBe('security');
    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(2);
    expect(verdict.findings[0]).toEqual({
      severity: 'critical',
      file: 'src/auth.ts',
      line: 42,
      message: 'Missing input validation',
    });
    expect(verdict.findings[1]).toEqual({
      severity: 'minor',
      file: undefined,
      line: undefined,
      message: 'Consider adding more tests',
    });
    expect(verdict.summary).toBe('Critical security issue found');
  });

  it('handles markdown-wrapped JSON (```json ... ```)', () => {
    const text = '```json\n{"approved": true, "findings": [], "summary": "LGTM"}\n```';

    const verdict = parseReviewVerdict('critic', text);
    expect(verdict.approved).toBe(true);
    expect(verdict.summary).toBe('LGTM');
  });

  it('handles markdown-wrapped JSON without language specifier (``` ... ```)', () => {
    const text = '```\n{"approved": false, "findings": [], "summary": "Needs work"}\n```';

    const verdict = parseReviewVerdict('testing', text);
    expect(verdict.approved).toBe(false);
    expect(verdict.summary).toBe('Needs work');
  });

  it('returns not approved with critical finding on invalid JSON', () => {
    const text = 'This is not JSON at all, just some prose.';

    const verdict = parseReviewVerdict('testing', text);
    expect(verdict.type).toBe('testing');
    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].severity).toBe('critical');
    expect(verdict.findings[0].message).toContain('Failed to parse');
  });

  it('includes truncated response text in summary on parse failure', () => {
    const text = 'Invalid response from the model';

    const verdict = parseReviewVerdict('security', text);
    expect(verdict.summary).toContain('not valid JSON');
    expect(verdict.summary).toContain('Invalid response');
  });

  it('normalizes unknown severity values to "minor"', () => {
    const json = JSON.stringify({
      approved: true,
      findings: [
        { severity: 'unknown-severity', message: 'Something' },
        { severity: 'CRITICAL', message: 'Uppercased' },
        { severity: 'blocker', message: 'Not a valid severity' },
      ],
      summary: 'Test',
    });

    const verdict = parseReviewVerdict('testing', json);
    // All invalid severities should become 'minor'
    for (const f of verdict.findings) {
      expect(f.severity).toBe('minor');
    }
  });

  it('accepts all valid severity values', () => {
    const json = JSON.stringify({
      approved: true,
      findings: [
        { severity: 'critical', message: 'a' },
        { severity: 'major', message: 'b' },
        { severity: 'minor', message: 'c' },
        { severity: 'suggestion', message: 'd' },
      ],
      summary: 'Test',
    });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.findings[0].severity).toBe('critical');
    expect(verdict.findings[1].severity).toBe('major');
    expect(verdict.findings[2].severity).toBe('minor');
    expect(verdict.findings[3].severity).toBe('suggestion');
  });

  it('handles missing findings array gracefully', () => {
    const json = JSON.stringify({ approved: true, summary: 'No findings' });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.approved).toBe(true);
    expect(verdict.findings).toEqual([]);
    expect(verdict.summary).toBe('No findings');
  });

  it('handles missing summary gracefully', () => {
    const json = JSON.stringify({ approved: true, findings: [] });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.summary).toBe('');
  });

  it('coerces non-boolean approved to boolean', () => {
    const json = JSON.stringify({ approved: 1, findings: [], summary: 'ok' });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.approved).toBe(true);

    const json2 = JSON.stringify({ approved: 0, findings: [], summary: 'nope' });
    const verdict2 = parseReviewVerdict('testing', json2);
    expect(verdict2.approved).toBe(false);
  });

  it('handles findings with non-number line values', () => {
    const json = JSON.stringify({
      approved: true,
      findings: [{ severity: 'minor', line: 'not-a-number', message: 'test' }],
      summary: 'ok',
    });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.findings[0].line).toBeUndefined();
  });

  it('converts finding message to string even if not a string', () => {
    const json = JSON.stringify({
      approved: true,
      findings: [{ severity: 'minor', message: 12345 }],
      summary: 'ok',
    });

    const verdict = parseReviewVerdict('testing', json);
    expect(verdict.findings[0].message).toBe('12345');
  });

  it('truncates long response text in error summary at 200 chars', () => {
    const longText = 'A'.repeat(500);

    const verdict = parseReviewVerdict('testing', longText);
    expect(verdict.summary.length).toBeLessThan(500);
    // The slice(0, 200) should keep summary manageable
  });
});

// ── runParallelSdkReviews ───────────────────────────────────────────

describe('runParallelSdkReviews', () => {
  it('returns error when SDK is not installed', async () => {
    const result = await runParallelSdkReviews({
      diff: 'some diff content',
      prTitle: 'Fix bug',
      prNumber: 42,
      workDir: '/tmp/test',
    });

    expect(result.allApproved).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('claude-agent-sdk');
  });

  it('returns zero token usage when SDK is not installed', async () => {
    const result = await runParallelSdkReviews({
      diff: 'diff',
      prTitle: 'Test',
      prNumber: 1,
      workDir: '/tmp',
    });

    expect(result.totalTokenUsage.inputTokens).toBe(0);
    expect(result.totalTokenUsage.outputTokens).toBe(0);
    expect(result.totalTokenUsage.model).toBe('unknown');
  });

  it('returns empty verdicts when SDK is not installed', async () => {
    const result = await runParallelSdkReviews({
      diff: 'diff',
      prTitle: 'Test',
      prNumber: 1,
      workDir: '/tmp',
    });

    expect(result.verdicts).toEqual([]);
  });

  it('accepts custom review configs', async () => {
    const custom: SdkReviewConfig[] = [
      {
        type: 'testing',
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        maxBudgetUsd: 0.25,
        maxTurns: 10,
      },
    ];

    const result = await runParallelSdkReviews({
      diff: 'diff',
      prTitle: 'Test',
      prNumber: 1,
      workDir: '/tmp',
      reviewConfigs: custom,
    });

    // Will fail on SDK import, but shouldn't crash
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts reviewPolicy without crashing', async () => {
    const result = await runParallelSdkReviews({
      diff: 'diff',
      prTitle: 'Test',
      prNumber: 1,
      workDir: '/tmp',
      reviewPolicy: 'Be strict about security.',
    });

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts model override without crashing', async () => {
    const result = await runParallelSdkReviews({
      diff: 'diff',
      prTitle: 'Test',
      prNumber: 1,
      workDir: '/tmp',
      model: 'claude-opus-4-6',
    });

    expect(result.errors.length).toBeGreaterThan(0);
  });
});
