import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeTriage } from './triage.js';
import type { IssueTracker } from '@ai-sdlc/reference';

function createMockTracker(overrides: Partial<IssueTracker> = {}): IssueTracker {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({
      id: '42',
      title: 'Fix login page',
      description: 'The login button is misaligned.',
      status: 'open',
      labels: ['bug'],
      url: 'https://github.com/test/repo/issues/42',
    }),
    createIssue: vi.fn(),
    updateIssue: vi.fn().mockResolvedValue({
      id: '42',
      title: 'Fix login page',
      description: 'The login button is misaligned.',
      status: 'open',
      labels: ['bug', 'triage-passed'],
      url: 'https://github.com/test/repo/issues/42',
    }),
    transitionIssue: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    getComments: vi.fn().mockResolvedValue([]),
    watchIssues: vi.fn(),
    ...overrides,
  };
}

describe('executeTriage', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('runs triage and returns verdict for safe issue', async () => {
    const tracker = createMockTracker();
    const verdictData = {
      safe: true,
      riskScore: 1,
      findings: [],
      sanitizedDescription: 'Fix login page CSS',
      rationale: 'Standard bug report.',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(verdictData) }],
          usage: { input_tokens: 200, output_tokens: 50 },
          model: 'claude-sonnet-4-5-20250929',
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker, dryRun: true });

    expect(result.issueId).toBe('42');
    expect(result.verdict.safe).toBe(true);
    expect(result.verdict.riskScore).toBe(1);
    expect(result.rejected).toBe(false);
    expect(tracker.getIssue).toHaveBeenCalledWith('42');
  });

  it('posts comment and applies triage-passed label for safe issue', async () => {
    const tracker = createMockTracker();
    const verdictData = {
      safe: true,
      riskScore: 2,
      findings: [],
      sanitizedDescription: 'Test',
      rationale: 'Clean issue.',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(verdictData) }],
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker });

    expect(result.rejected).toBe(false);
    expect(result.labelApplied).toBe('triage-passed');
    expect(tracker.addComment).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Security Triage: PASSED'),
    );
    expect(tracker.updateIssue).toHaveBeenCalledWith('42', {
      labels: ['bug', 'triage-passed'],
    });
  });

  it('auto-rejects issues above risk threshold', async () => {
    const tracker = createMockTracker();
    const verdictData = {
      safe: false,
      riskScore: 8,
      findings: ['Direct injection detected'],
      sanitizedDescription: 'Suspicious',
      rationale: 'Contains injection patterns.',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(verdictData) }],
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker });

    expect(result.rejected).toBe(true);
    expect(result.labelApplied).toBe('security-rejected');
    expect(tracker.addComment).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Security Triage: REJECTED'),
    );
    expect(tracker.updateIssue).toHaveBeenCalledWith('42', {
      labels: ['bug', 'security-rejected'],
    });
  });

  it('never applies ai-ready label (asymmetric model)', async () => {
    const tracker = createMockTracker();
    const verdictData = {
      safe: true,
      riskScore: 0,
      findings: [],
      sanitizedDescription: 'Perfectly safe issue',
      rationale: 'Completely benign.',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(verdictData) }],
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker });

    // Even for riskScore=0, we never apply ai-ready — only triage-passed
    expect(result.labelApplied).toBe('triage-passed');
    expect(result.labelApplied).not.toBe('ai-ready');
    expect(tracker.addComment).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('must still manually apply the `ai-ready` label'),
    );
  });

  it('replaces existing triage labels instead of stacking', async () => {
    const tracker = createMockTracker({
      getIssue: vi.fn().mockResolvedValue({
        id: '42',
        title: 'Re-triaged issue',
        description: 'Previously rejected, now re-submitted.',
        status: 'open',
        labels: ['bug', 'security-rejected'],
        url: 'https://github.com/test/repo/issues/42',
      }),
      updateIssue: vi.fn().mockResolvedValue({
        id: '42',
        title: 'Re-triaged issue',
        status: 'open',
        labels: ['bug', 'triage-passed'],
        url: 'https://github.com/test/repo/issues/42',
      }),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                safe: true,
                riskScore: 1,
                findings: [],
                sanitizedDescription: 'test',
                rationale: 'clean',
              }),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker });

    expect(result.labelApplied).toBe('triage-passed');
    // Should have removed security-rejected and added triage-passed
    expect(tracker.updateIssue).toHaveBeenCalledWith('42', {
      labels: ['bug', 'triage-passed'],
    });
  });

  it('handles triage runner failure gracefully', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const tracker = createMockTracker();
    const result = await executeTriage('42', { tracker, dryRun: true });

    expect(result.rejected).toBe(true);
    expect(result.verdict.riskScore).toBe(7);
    expect(result.error).toContain('ANTHROPIC_API_KEY');
  });

  it('handles comment posting failure gracefully', async () => {
    const tracker = createMockTracker({
      addComment: vi.fn().mockRejectedValue(new Error('API rate limit')),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                safe: true,
                riskScore: 0,
                findings: [],
                sanitizedDescription: 'test',
                rationale: 'clean',
              }),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    // Should not throw — comment failure is non-fatal
    const result = await executeTriage('42', { tracker });

    expect(result.labelApplied).toBe('triage-passed');
  });

  it('handles label application failure gracefully', async () => {
    const tracker = createMockTracker({
      updateIssue: vi.fn().mockRejectedValue(new Error('Permission denied')),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                safe: true,
                riskScore: 0,
                findings: [],
                sanitizedDescription: 'test',
                rationale: 'clean',
              }),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker });

    expect(result.labelApplied).toBeUndefined();
    expect(result.error).toContain('Label application failed');
  });

  it('respects custom reject threshold from triageConfig', async () => {
    const tracker = createMockTracker();
    const verdictData = {
      safe: false,
      riskScore: 5,
      findings: ['Minor concern'],
      sanitizedDescription: 'test',
      rationale: 'Ambiguous language.',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(verdictData) }],
        }),
        { status: 200 },
      ),
    );

    // Default threshold is 6, so riskScore=5 passes
    const resultDefault = await executeTriage('42', { tracker, dryRun: true });
    expect(resultDefault.rejected).toBe(false);

    // Custom threshold of 4 would reject riskScore=5
    const resultStrict = await executeTriage('42', {
      tracker,
      triageConfig: { rejectThreshold: 4 },
      dryRun: true,
    });
    expect(resultStrict.rejected).toBe(true);
  });

  it('skips comment and label in dryRun mode', async () => {
    const tracker = createMockTracker();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                safe: true,
                riskScore: 0,
                findings: [],
                sanitizedDescription: 'test',
                rationale: 'clean',
              }),
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await executeTriage('42', { tracker, dryRun: true });

    expect(result.rejected).toBe(false);
    expect(result.labelApplied).toBeUndefined();
    expect(tracker.addComment).not.toHaveBeenCalled();
    expect(tracker.updateIssue).not.toHaveBeenCalled();
  });
});
