import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeTriage } from './triage.js';
import {
  FakeJudgmentProvider,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
  type IssueTracker,
} from '@ai-sdlc/reference';

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

describe('executeTriage injection screen', () => {
  const verdictData = {
    safe: true,
    riskScore: 1,
    findings: ['existing finding'],
    sanitizedDescription: 'x',
    rationale: 'ok',
  };

  function mockTriageFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify(verdictData) }],
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'claude-sonnet-4-5-20250929',
          }),
          { status: 200 },
        ),
    );
  }

  function screenCtx(prob: number): EvaluateJudgmentContext {
    const fake = new FakeJudgmentProvider();
    for (const id of ['addressesModel', 'requestsSecrets', 'requestsDisable']) {
      fake.script(id, { type: 'noul', probability: id === 'requestsSecrets' ? prob : 0 });
    }
    return {
      config: resolveJudgmentConfig({
        spec: {
          provider: 'fake',
          model: 'fake-1',
          judgments: {
            'triage.injection-screen': {
              mode: 'enforce',
              thresholds: { 'fake@fake-1': { flag: 0.7 } },
              promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed' } },
            },
          },
        },
      }),
      getProvider: () => fake,
    };
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a finding and the suspicious flag, and still runs the existing triage', async () => {
    const fetchSpy = mockTriageFetch();
    const result = await executeTriage('42', {
      tracker: createMockTracker(),
      dryRun: true,
      judgment: screenCtx(0.95),
    });
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.suspicious).toBe(true);
    expect(result.verdict.findings[0]).toBe('existing finding');
    expect(result.verdict.findings).toHaveLength(2);
    expect(result.verdict.safe).toBe(true);
    expect(result.verdict.riskScore).toBe(1);
    expect(result.rejected).toBe(false);
  });

  it('low probability and no judgment both leave the result byte-identical', async () => {
    mockTriageFetch();
    const plain = await executeTriage('42', { tracker: createMockTracker(), dryRun: true });
    const low = await executeTriage('42', {
      tracker: createMockTracker(),
      dryRun: true,
      judgment: screenCtx(0.1),
    });
    expect(JSON.stringify(low)).toBe(JSON.stringify(plain));
    expect('suspicious' in low).toBe(false);
  });

  it('carries the flag onto the posted comment, the applied label result and the error path', async () => {
    mockTriageFetch();
    const tracker = createMockTracker();
    const result = await executeTriage('42', { tracker, judgment: screenCtx(0.95) });
    expect(result.suspicious).toBe(true);
    expect(result.labelApplied).toBe('triage-passed');
    expect((tracker.addComment as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain(
      'Injection screen',
    );
    const failing = createMockTracker({
      updateIssue: vi.fn().mockRejectedValue(new Error('nope')),
    });
    const r2 = await executeTriage('42', { tracker: failing, judgment: screenCtx(0.95) });
    expect(r2.suspicious).toBe(true);
    expect(r2.error).toContain('Label application failed');

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const r3 = await executeTriage('42', {
      tracker: createMockTracker(),
      dryRun: true,
      judgment: screenCtx(0.95),
    });
    expect(r3.rejected).toBe(true);
    expect(r3.suspicious).toBe(true);
  });
});
