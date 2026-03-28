import { describe, it, expect } from 'vitest';
import { executeReview, type ReviewContext } from './review.js';
import { ReviewAgentRunner } from './runners/review-agent.js';
import type { AgentResult } from './runners/types.js';

function makeRunner(result: Partial<AgentResult> = {}): ReviewAgentRunner {
  const runner = new ReviewAgentRunner({ reviewType: 'testing' });
  runner.run = async () => ({
    success: true,
    filesChanged: [],
    summary: JSON.stringify({
      type: 'testing',
      approved: true,
      findings: [],
      summary: 'All tests pass',
    }),
    ...result,
  });
  return runner;
}

const defaultContext: ReviewContext = {
  issueTitle: 'Fix widget alignment',
  issueBody: 'The widget is misaligned',
  acceptanceCriteria: '- [ ] Widget is centered',
};

describe('executeReview', () => {
  it('returns verdict from successful review', async () => {
    const runner = makeRunner();
    const verdict = await executeReview(1, 'diff content', 'testing', defaultContext, {
      runner,
    });

    expect(verdict.type).toBe('testing');
    expect(verdict.approved).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('returns not-approved when runner fails', async () => {
    const runner = makeRunner({
      success: false,
      error: 'API timeout',
      summary: 'failed',
    });

    const verdict = await executeReview(1, 'diff', 'critic', defaultContext, {
      runner,
    });

    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].message).toContain('API timeout');
  });

  it('returns not-approved when runner output is not valid JSON', async () => {
    const runner = makeRunner({ summary: 'not json' });

    const verdict = await executeReview(1, 'diff', 'security', defaultContext, {
      runner,
    });

    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].message).toContain('review verdict');
  });

  it('preserves review type in verdict', async () => {
    const runner = makeRunner({
      summary: JSON.stringify({
        type: 'wrong-type',
        approved: true,
        findings: [],
        summary: 'ok',
      }),
    });

    // Should override the type from runner output with the requested type
    const verdict = await executeReview(1, 'diff', 'security', defaultContext, {
      runner,
    });

    expect(verdict.type).toBe('security');
  });

  it('works with findings in runner output', async () => {
    const runner = makeRunner({
      summary: JSON.stringify({
        type: 'critic',
        approved: false,
        findings: [{ severity: 'major', file: 'src/foo.ts', line: 10, message: 'Bad pattern' }],
        summary: 'Issues found',
      }),
    });

    const verdict = await executeReview(1, 'diff', 'critic', defaultContext, {
      runner,
    });

    expect(verdict.approved).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].file).toBe('src/foo.ts');
  });
});
