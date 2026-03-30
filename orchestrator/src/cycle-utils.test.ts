import { describe, it, expect, vi } from 'vitest';
import { checkAndHandleCycle, createCycleDetectorFromConfig } from './cycle-utils.js';
import { PipelineCycleDetector, createStageMarker } from './pipeline-cycle-detector.js';
import type { IssueTracker } from '@ai-sdlc/reference';

function makeMockTracker(comments: string[] = []): IssueTracker {
  return {
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({ id: '1', title: '', status: 'open' }),
    createIssue: vi.fn().mockResolvedValue({ id: '1', title: '', status: 'open' }),
    updateIssue: vi.fn().mockResolvedValue({ id: '1', title: '', status: 'open' }),
    transitionIssue: vi.fn().mockResolvedValue({ id: '1', title: '', status: 'open' }),
    addComment: vi.fn().mockResolvedValue(undefined),
    getComments: vi
      .fn()
      .mockResolvedValue(
        comments.map((body) => ({ body, author: 'bot', createdAt: new Date().toISOString() })),
      ),
    watchIssues: vi.fn(),
  } as unknown as IssueTracker;
}

describe('checkAndHandleCycle()', () => {
  it('returns no cycle when invocation counts are below limits', async () => {
    const tracker = makeMockTracker([]);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
    });

    expect(result.cycleDetected).toBe(false);
    expect(result.marker).toContain('ai-sdlc-cycle:agent:');
    expect(result.cycleMessage).toBeUndefined();
  });

  it('detects cycle when existing markers + pending invocation >= limit', async () => {
    // Limit 3: 2 existing + 1 pending = 3 >= 3 → cycle
    const markers = Array.from({ length: 2 }, () => `Comment\n${createStageMarker('agent')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
    });

    expect(result.cycleDetected).toBe(true);
    expect(result.cycleMessage).toContain('Pipeline Cycle Detected');
    expect(result.cycleMessage).toContain('agent');
  });

  it('does not detect cycle when below threshold (existing + pending < limit)', async () => {
    // Limit 3: 1 existing + 1 pending = 2 < 3 → no cycle
    const markers = [createStageMarker('agent')];
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
    });

    expect(result.cycleDetected).toBe(false);
  });

  it('posts comment on issue when cycle detected', async () => {
    const markers = Array.from({ length: 3 }, () => `Comment\n${createStageMarker('fix-ci')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        'fix-ci': 2,
        admission: 3,
        triage: 3,
        agent: 3,
        review: 2,
        'fix-review': 2,
      },
    });

    await checkAndHandleCycle({
      issueOrPrId: '99',
      stage: 'fix-ci',
      tracker,
      detector,
    });

    expect(tracker.addComment).toHaveBeenCalledWith(
      '99',
      expect.stringContaining('Cycle Detected'),
    );
  });

  it('sends Slack notification when cycle detected and notifySlack provided', async () => {
    const markers = Array.from({ length: 2 }, () => `Comment\n${createStageMarker('agent')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });
    const notifySlack = vi.fn().mockResolvedValue(undefined);

    await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
      notifySlack,
    });

    expect(notifySlack).toHaveBeenCalledWith(expect.stringContaining('Pipeline Cycle Detected'));
  });

  it('does not send Slack notification when no cycle', async () => {
    const tracker = makeMockTracker([]);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });
    const notifySlack = vi.fn().mockResolvedValue(undefined);

    await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
      notifySlack,
    });

    expect(notifySlack).not.toHaveBeenCalled();
  });

  it('does not post comment when no cycle', async () => {
    const tracker = makeMockTracker([]);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
    });

    expect(tracker.addComment).not.toHaveBeenCalled();
  });

  it('uses custom cycle template when provided', async () => {
    const markers = Array.from({ length: 2 }, () => `Comment\n${createStageMarker('agent')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
      cycleTemplate: { title: 'Custom Title', body: 'Custom body text' },
    });

    expect(result.cycleMessage).toContain('Custom Title');
    expect(result.cycleMessage).toContain('Custom body text');
  });

  it('sanitizes HTML in custom cycle templates to prevent injection', async () => {
    const markers = Array.from({ length: 2 }, () => `Comment\n${createStageMarker('agent')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
      cycleTemplate: {
        title: 'Title <script>alert("xss")</script>',
        body: 'Body <img src=x onerror=alert(1)>',
      },
    });

    expect(result.cycleMessage).not.toContain('<script>');
    expect(result.cycleMessage).not.toContain('<img');
    expect(result.cycleMessage).toContain('Title alert("xss")');
  });

  it('handles Slack notification failure gracefully', async () => {
    const markers = Array.from({ length: 2 }, () => `Comment\n${createStageMarker('agent')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });
    const notifySlack = vi.fn().mockRejectedValue(new Error('Slack down'));

    // Should not throw even when Slack fails
    const result = await checkAndHandleCycle({
      issueOrPrId: '42',
      stage: 'agent',
      tracker,
      detector,
      notifySlack,
    });

    expect(result.cycleDetected).toBe(true);
    expect(notifySlack).toHaveBeenCalled();
  });
});

describe('createCycleDetectorFromConfig()', () => {
  it('creates detector with default limits when no stages configured', () => {
    const detector = createCycleDetectorFromConfig({});
    expect(detector.getMaxInvocations('agent')).toBe(5);
    expect(detector.getMaxInvocations('fix-ci')).toBe(4);
  });

  it('maps code stage maxRetries to fix-ci limit', () => {
    const detector = createCycleDetectorFromConfig({
      stages: [{ name: 'code', onFailure: { maxRetries: 5 } }],
    });
    expect(detector.getMaxInvocations('fix-ci')).toBe(5);
  });

  it('maps review stage maxRetries to fix-review limit', () => {
    const detector = createCycleDetectorFromConfig({
      stages: [{ name: 'review', onFailure: { maxRetries: 4 } }],
    });
    expect(detector.getMaxInvocations('fix-review')).toBe(4);
  });

  it('maps agent stage maxRetries directly', () => {
    const detector = createCycleDetectorFromConfig({
      stages: [{ name: 'agent', onFailure: { maxRetries: 7 } }],
    });
    expect(detector.getMaxInvocations('agent')).toBe(7);
  });

  it('maps admission and triage stages directly', () => {
    const detector = createCycleDetectorFromConfig({
      stages: [
        { name: 'admission', onFailure: { maxRetries: 1 } },
        { name: 'triage', onFailure: { maxRetries: 2 } },
      ],
    });
    expect(detector.getMaxInvocations('admission')).toBe(1);
    expect(detector.getMaxInvocations('triage')).toBe(2);
  });

  it('ignores stages without maxRetries', () => {
    const detector = createCycleDetectorFromConfig({
      stages: [{ name: 'code' }],
    });
    expect(detector.getMaxInvocations('fix-ci')).toBe(4); // default
  });

  it('ignores unknown stage names', () => {
    const detector = createCycleDetectorFromConfig({
      stages: [{ name: 'unknown-stage', onFailure: { maxRetries: 10 } }],
    });
    // Defaults should be unchanged
    expect(detector.getMaxInvocations('agent')).toBe(5);
    expect(detector.getMaxInvocations('fix-ci')).toBe(4);
  });
});

describe('PipelineCycleDetector.detectCycle() with IssueTracker', () => {
  it('fetches comments and detects cycle', async () => {
    const markers = Array.from({ length: 3 }, () => `Comment\n${createStageMarker('agent')}`);
    const tracker = makeMockTracker(markers);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await detector.detectCycle(tracker, '42');

    expect(result.cycleDetected).toBe(true);
    expect(result.loopingStages).toHaveLength(1);
    expect(result.loopingStages[0].stage).toBe('agent');
    expect(tracker.getComments).toHaveBeenCalledWith('42');
  });

  it('returns no cycle when below limits', async () => {
    const tracker = makeMockTracker([`Comment\n${createStageMarker('agent')}`]);
    const detector = new PipelineCycleDetector({
      maxInvocations: {
        admission: 5,
        triage: 5,
        agent: 3,
        review: 4,
        'fix-ci': 4,
        'fix-review': 4,
      },
    });

    const result = await detector.detectCycle(tracker, '42');

    expect(result.cycleDetected).toBe(false);
    expect(result.loopingStages).toHaveLength(0);
  });
});
