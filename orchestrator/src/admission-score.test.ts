import { describe, it, expect } from 'vitest';
import {
  scoreIssueForAdmission,
  mapIssueToPriorityInput,
  type AdmissionInput,
  type AdmissionThresholds,
} from './admission-score.js';

const DEFAULT_THRESHOLDS: AdmissionThresholds = {
  minimumScore: 0.05,
  minimumConfidence: 0.2,
};

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    issueNumber: 42,
    title: 'Fix widget alignment on dashboard',
    body: [
      '### Description',
      'The widget is misaligned on the dashboard page.',
      '',
      '### Complexity',
      '2',
      '',
      '### Acceptance Criteria',
      '- [ ] Widget renders centered',
      '- [ ] No regression on mobile',
    ].join('\n'),
    labels: ['bug'],
    reactionCount: 3,
    commentCount: 2,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('mapIssueToPriorityInput', () => {
  it('extracts complexity from issue body', () => {
    const result = mapIssueToPriorityInput(makeInput());
    expect(result.complexity).toBe(2);
  });

  it('returns undefined complexity when section is missing', () => {
    const result = mapIssueToPriorityInput(makeInput({ body: 'No complexity section here' }));
    expect(result.complexity).toBeUndefined();
  });

  it('maps bug label to bug severity', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['bug'] }));
    expect(result.bugSeverity).toBe(3);
  });

  it('maps critical label to severity 5', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['critical'] }));
    expect(result.bugSeverity).toBe(5);
  });

  it('maps P0 label to severity 5', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['P0'] }));
    expect(result.bugSeverity).toBe(5);
  });

  it('maps spec label to high soul alignment', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['spec'] }));
    expect(result.soulAlignment).toBe(0.9);
  });

  it('maps governance label to high soul alignment', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['governance'] }));
    expect(result.soulAlignment).toBe(0.85);
  });

  it('maps reactions to team consensus', () => {
    const result = mapIssueToPriorityInput(makeInput({ reactionCount: 5 }));
    expect(result.teamConsensus).toBe(1);
  });

  it('caps team consensus at 1', () => {
    const result = mapIssueToPriorityInput(makeInput({ reactionCount: 100 }));
    expect(result.teamConsensus).toBe(1);
  });

  it('maps comment count to demand signal', () => {
    const result = mapIssueToPriorityInput(makeInput({ commentCount: 5 }));
    expect(result.demandSignal).toBe(1);
  });

  it('maps ai-eligible label to high builder conviction', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['ai-eligible'] }));
    expect(result.builderConviction).toBe(0.8);
  });

  it('maps high label to explicit priority 0.8', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['high'] }));
    expect(result.explicitPriority).toBe(0.8);
  });

  it('maps low label to explicit priority 0.2', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['low'] }));
    expect(result.explicitPriority).toBe(0.2);
  });

  it('vetoes security-rejected issues with soulAlignment=0', () => {
    const result = mapIssueToPriorityInput(makeInput({ labels: ['security-rejected'] }));
    expect(result.soulAlignment).toBe(0);
  });

  it('computes competitive drift for old issues', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const result = mapIssueToPriorityInput(makeInput({ createdAt: ninetyDaysAgo }));
    expect(result.competitiveDrift).toBeGreaterThan(0);
  });

  it('has zero drift for fresh issues', () => {
    const result = mapIssueToPriorityInput(makeInput());
    expect(result.competitiveDrift).toBe(0);
  });

  describe('trust-based boosting', () => {
    it('boosts builder conviction for OWNER', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'OWNER', labels: [], reactionCount: 0 }),
      );
      expect(result.builderConviction).toBe(0.8);
    });

    it('boosts builder conviction for MEMBER', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'MEMBER', labels: [], reactionCount: 0 }),
      );
      expect(result.builderConviction).toBe(0.8);
    });

    it('boosts builder conviction for COLLABORATOR', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'COLLABORATOR', labels: [], reactionCount: 0 }),
      );
      expect(result.builderConviction).toBe(0.8);
    });

    it('gives moderate conviction to CONTRIBUTOR', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'CONTRIBUTOR', labels: [], reactionCount: 0 }),
      );
      expect(result.builderConviction).toBe(0.6);
    });

    it('gives low conviction to NONE', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'NONE', labels: [], reactionCount: 0 }),
      );
      expect(result.builderConviction).toBe(0.4);
    });

    it('gives baseline team consensus for trusted sources', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'OWNER', reactionCount: 0 }),
      );
      expect(result.teamConsensus).toBeGreaterThanOrEqual(0.5);
    });

    it('gives baseline demand signal for trusted sources', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'OWNER', commentCount: 0 }),
      );
      expect(result.demandSignal).toBeGreaterThanOrEqual(0.4);
    });

    it('does not boost demand signal for untrusted sources', () => {
      const result = mapIssueToPriorityInput(
        makeInput({ authorAssociation: 'NONE', commentCount: 0, reactionCount: 0 }),
      );
      expect(result.demandSignal).toBe(0);
      expect(result.teamConsensus).toBe(0);
    });

    it('sets soul alignment floor for trusted sources', () => {
      const result = mapIssueToPriorityInput(makeInput({ authorAssociation: 'OWNER', labels: [] }));
      expect(result.soulAlignment).toBeGreaterThanOrEqual(0.6);
    });

    it('admits trusted source issue with no reactions/comments', () => {
      const input = makeInput({
        authorAssociation: 'OWNER',
        reactionCount: 0,
        commentCount: 0,
      });
      const result = scoreIssueForAdmission(input, DEFAULT_THRESHOLDS);
      expect(result.admitted).toBe(true);
    });

    it('may reject untrusted source issue with no signals', () => {
      const input = makeInput({
        authorAssociation: 'NONE',
        reactionCount: 0,
        commentCount: 0,
        labels: [],
      });
      const strictThresholds: AdmissionThresholds = {
        minimumScore: 0.1,
        minimumConfidence: 0.2,
      };
      const result = scoreIssueForAdmission(input, strictThresholds);
      // Untrusted with no signals should score lower than trusted
      const trustedInput = makeInput({
        authorAssociation: 'OWNER',
        reactionCount: 0,
        commentCount: 0,
        labels: [],
      });
      const trustedResult = scoreIssueForAdmission(trustedInput, strictThresholds);
      expect(trustedResult.score.composite).toBeGreaterThan(result.score.composite);
    });
  });
});

describe('scoreIssueForAdmission', () => {
  it('admits a well-formed issue', () => {
    const result = scoreIssueForAdmission(makeInput(), DEFAULT_THRESHOLDS);
    expect(result.admitted).toBe(true);
    expect(result.score.composite).toBeGreaterThan(DEFAULT_THRESHOLDS.minimumScore);
    expect(result.score.confidence).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minimumConfidence);
    expect(result.suggestions).toBeUndefined();
  });

  it('rejects an issue with no body when confidence threshold is higher', () => {
    const input = makeInput({ body: '', commentCount: 0, reactionCount: 0, labels: [] });
    // The default thresholds (0.05 score, 0.2 confidence) are very low,
    // so even a minimal issue can pass. Use stricter thresholds to test rejection.
    const strictThresholds: AdmissionThresholds = {
      minimumScore: 0.3,
      minimumConfidence: 0.4,
    };
    const result = scoreIssueForAdmission(input, strictThresholds);
    expect(result.admitted).toBe(false);
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions!.length).toBeGreaterThan(0);
  });

  it('vetoes security-rejected issue (score = 0)', () => {
    const input = makeInput({ labels: ['security-rejected'] });
    const result = scoreIssueForAdmission(input, DEFAULT_THRESHOLDS);
    expect(result.admitted).toBe(false);
    expect(result.score.composite).toBe(0);
  });

  it('rejects when score is below minimum', () => {
    const highThresholds: AdmissionThresholds = {
      minimumScore: 100,
      minimumConfidence: 0,
    };
    const result = scoreIssueForAdmission(makeInput(), highThresholds);
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('below minimum');
  });

  it('rejects when confidence is below minimum', () => {
    const highConfidence: AdmissionThresholds = {
      minimumScore: 0,
      minimumConfidence: 1.0,
    };
    // Minimal input = low confidence
    const input = makeInput({ body: '', commentCount: 0, reactionCount: 0 });
    const result = scoreIssueForAdmission(input, highConfidence);
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('confidence');
  });

  it('generates suggestion for missing complexity section', () => {
    const input = makeInput({ body: 'Just a description' });
    const result = scoreIssueForAdmission(input, {
      minimumScore: 100,
      minimumConfidence: 0,
    });
    const hasSuggestion = result.suggestions?.some((s) => s.includes('Complexity'));
    expect(hasSuggestion).toBe(true);
  });

  it('generates suggestion for missing acceptance criteria', () => {
    const input = makeInput({ body: '### Complexity\n2' });
    const result = scoreIssueForAdmission(input, {
      minimumScore: 100,
      minimumConfidence: 0,
    });
    const hasSuggestion = result.suggestions?.some((s) => s.includes('Acceptance Criteria'));
    expect(hasSuggestion).toBe(true);
  });

  it('generates suggestion for short description', () => {
    const input = makeInput({ body: 'short' });
    const result = scoreIssueForAdmission(input, {
      minimumScore: 100,
      minimumConfidence: 0,
    });
    const hasSuggestion = result.suggestions?.some((s) => s.includes('detailed description'));
    expect(hasSuggestion).toBe(true);
  });

  it('returns reason string for both score and confidence failure', () => {
    const result = scoreIssueForAdmission(makeInput({ body: '', labels: ['security-rejected'] }), {
      minimumScore: 0.5,
      minimumConfidence: 0.5,
    });
    expect(result.reason).toContain('score');
    expect(result.reason).toContain('confidence');
  });

  it('passes custom priority config through', () => {
    const result = scoreIssueForAdmission(makeInput(), DEFAULT_THRESHOLDS, {
      calibrationCoefficient: 1.3,
    });
    expect(result.score.dimensions.calibration).toBe(1.3);
  });
});

describe('mapIssueToPriorityInput — backlog context', () => {
  function backlogInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
    return {
      issueNumber: 68,
      title: 'Documentation consolidation',
      body: 'Two parallel doc trees diverge.',
      labels: ['docs', 'infrastructure'],
      reactionCount: 0,
      commentCount: 0,
      createdAt: '2026-04-26T19:20:00Z',
      authorAssociation: 'OWNER',
      backlogContext: {
        priority: 'medium',
        dependencyCount: 0,
        referenceCount: 3,
        acceptanceCriteriaCount: 6,
        status: 'To Do',
      },
      ...overrides,
    };
  }

  it('vetoes Draft tasks via soulAlignment=0', () => {
    const out = mapIssueToPriorityInput(backlogInput({ backlogContext: { status: 'Draft' } }));
    expect(out.soulAlignment).toBe(0);
  });

  it('uses backlog priority for explicitPriority when no high/low label set', () => {
    const high = mapIssueToPriorityInput(backlogInput({ backlogContext: { priority: 'high' } }));
    expect(high.explicitPriority).toBe(0.8);

    const critical = mapIssueToPriorityInput(
      backlogInput({ backlogContext: { priority: 'critical' } }),
    );
    expect(critical.explicitPriority).toBe(1.0);

    const low = mapIssueToPriorityInput(backlogInput({ backlogContext: { priority: 'low' } }));
    expect(low.explicitPriority).toBe(0.2);
  });

  it('label `high` still wins over backlog priority (explicit > frontmatter)', () => {
    const out = mapIssueToPriorityInput(
      backlogInput({
        labels: ['docs', 'high'],
        backlogContext: { priority: 'low' },
      }),
    );
    expect(out.explicitPriority).toBe(0.8);
  });

  it('derives complexity from acceptance-criteria count when no Complexity header', () => {
    const out = mapIssueToPriorityInput(
      backlogInput({ backlogContext: { acceptanceCriteriaCount: 6 } }),
    );
    // 6 ACs * 1.2 = 7.2, ceil = 8
    expect(out.complexity).toBe(8);
  });

  it('explicit ### Complexity header still wins over AC-derived complexity', () => {
    const out = mapIssueToPriorityInput(
      backlogInput({
        body: '### Complexity\n3\n',
        backlogContext: { acceptanceCriteriaCount: 6 },
      }),
    );
    expect(out.complexity).toBe(3);
  });

  it('penalizes builderConviction when task has dependencies (blocked)', () => {
    const blocked = mapIssueToPriorityInput(
      backlogInput({ backlogContext: { dependencyCount: 2 } }),
    );
    const unblocked = mapIssueToPriorityInput(
      backlogInput({ backlogContext: { dependencyCount: 0 } }),
    );
    expect(blocked.builderConviction!).toBeLessThan(unblocked.builderConviction!);
  });

  it('boosts soulAlignment for rfc-process / architecture labels', () => {
    const rfc = mapIssueToPriorityInput(backlogInput({ labels: ['docs', 'rfc-process'] }));
    expect(rfc.soulAlignment).toBe(0.85);

    const arch = mapIssueToPriorityInput(backlogInput({ labels: ['architecture'] }));
    expect(arch.soulAlignment).toBe(0.85);
  });

  it('AISDLC-68 vs AISDLC-69 score differently when their labels diverge (the original bug)', () => {
    const aisdlc68 = mapIssueToPriorityInput(
      backlogInput({
        issueNumber: 68,
        title: 'Docs consolidation',
        labels: ['docs', 'infrastructure', 'tech-debt', 'triage-passed'],
        backlogContext: {
          priority: 'medium',
          dependencyCount: 0,
          acceptanceCriteriaCount: 6,
          status: 'To Do',
        },
      }),
    );
    const aisdlc69 = mapIssueToPriorityInput(
      backlogInput({
        issueNumber: 69,
        title: 'RFC drift detection',
        labels: ['docs', 'infrastructure', 'rfc-process', 'triage-passed'],
        backlogContext: {
          priority: 'medium',
          dependencyCount: 0,
          acceptanceCriteriaCount: 4,
          status: 'To Do',
        },
      }),
    );
    // AISDLC-69 (rfc-process) gets soulAlignment 0.85, AISDLC-68 (tech-debt) gets 0.6
    expect(aisdlc69.soulAlignment).toBeGreaterThan(aisdlc68.soulAlignment!);
  });
});
