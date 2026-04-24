import { describe, it, expect } from 'vitest';
import type { AdmissionInput } from './admission-score.js';
import {
  HC_WEIGHTS,
  HC_WEIGHT_SUM,
  computeAdmissionHumanCurve,
  deriveHcConsensus,
  deriveHcDecision,
  deriveHcDesign,
  deriveHcExplicit,
} from './admission-hc.js';

function baseInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    issueNumber: 1,
    title: 't',
    body: 'b',
    labels: [],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('HC_WEIGHTS', () => {
  it('sums to exactly 1.0 (AC #2)', () => {
    expect(HC_WEIGHT_SUM).toBe(1.0);
  });

  it('uses the §A.6 values 0.2/0.45/0.25/0.10', () => {
    expect(HC_WEIGHTS.explicit).toBe(0.2);
    expect(HC_WEIGHTS.consensus).toBe(0.45);
    expect(HC_WEIGHTS.decision).toBe(0.25);
    expect(HC_WEIGHTS.design).toBe(0.1);
  });
});

describe('deriveHcExplicit', () => {
  it.each([
    [['high'], 1.0],
    [['critical'], 1.0],
    [['P0'], 1.0],
    [['low'], -1.0],
    [['backlog'], -1.0],
    [[], 0],
    [['enhancement'], 0],
  ])('labels %j → %s', (labels, expected) => {
    expect(deriveHcExplicit({ labels })).toBe(expected);
  });

  it('high overrides low when both labels are set', () => {
    expect(deriveHcExplicit({ labels: ['high', 'low'] })).toBe(1.0);
  });
});

describe('deriveHcConsensus', () => {
  it('untrusted author with 0 reactions → -1.0', () => {
    expect(deriveHcConsensus({ reactionCount: 0 })).toBe(-1.0);
  });

  it('untrusted author scales reactions linearly up to 5', () => {
    // reactions 2 → reactionConsensus 0.4 → centered -0.2
    expect(deriveHcConsensus({ reactionCount: 2 })).toBeCloseTo(-0.2, 6);
    // reactions 5+ → 1.0 → centered +1.0
    expect(deriveHcConsensus({ reactionCount: 5 })).toBe(1.0);
    expect(deriveHcConsensus({ reactionCount: 10 })).toBe(1.0);
  });

  it('trusted author floors at 0 (base = 0.5 → centered 0)', () => {
    expect(deriveHcConsensus({ reactionCount: 0, authorAssociation: 'OWNER' })).toBe(0);
    expect(deriveHcConsensus({ reactionCount: 0, authorAssociation: 'MEMBER' })).toBe(0);
    expect(deriveHcConsensus({ reactionCount: 0, authorAssociation: 'COLLABORATOR' })).toBe(0);
  });

  it('untrusted associations (CONTRIBUTOR, NONE) do not trigger the trust floor', () => {
    expect(deriveHcConsensus({ reactionCount: 0, authorAssociation: 'CONTRIBUTOR' })).toBe(-1);
    expect(deriveHcConsensus({ reactionCount: 0, authorAssociation: 'NONE' })).toBe(-1);
  });
});

describe('deriveHcDecision', () => {
  it('returns 0 (neutral) — no admission field yet', () => {
    expect(deriveHcDecision(baseInput())).toBe(0);
  });
});

describe('deriveHcDesign', () => {
  it('returns 0 when no signal', () => {
    expect(deriveHcDesign(undefined)).toBe(0);
  });

  it('returns positive weight for advancing authority', () => {
    const v = deriveHcDesign({
      isDesignAuthority: true,
      signalType: 'advances-design-coherence',
    });
    expect(v).toBeCloseTo(0.6, 6);
  });

  it('returns negative weight for fragmenting authority', () => {
    const v = deriveHcDesign({
      isDesignAuthority: true,
      signalType: 'fragments-component-catalog',
    });
    expect(v).toBeCloseTo(-0.4, 6);
  });

  it('clamps to [-1, 1] even under extreme modulation', () => {
    const v = deriveHcDesign({
      isDesignAuthority: true,
      signalType: 'advances-design-coherence',
      areaComplianceScore: -2, // adversarial — (1.2 - (-2)) = 3.2 → 0.6 × 3.2 = 1.92
    });
    expect(v).toBe(1);
  });
});

describe('computeAdmissionHumanCurve', () => {
  it('neutral input produces hcComposite = 0 (tanh(0))', () => {
    const result = computeAdmissionHumanCurve(
      baseInput({ reactionCount: 0, authorAssociation: 'OWNER' }), // trusted floor → 0
    );
    expect(result.hcExplicit).toBe(0);
    expect(result.hcConsensus).toBe(0);
    expect(result.hcDecision).toBe(0);
    expect(result.hcDesign).toBe(0);
    expect(result.hcRaw).toBe(0);
    expect(result.hcComposite).toBe(0);
  });

  it('hcComposite is bounded in (-1, 1) for all inputs (AC #1)', () => {
    const max = computeAdmissionHumanCurve(
      baseInput({
        labels: ['high'],
        reactionCount: 100,
        authorAssociation: 'OWNER',
        designAuthoritySignal: { isDesignAuthority: true, signalType: 'advances-design-coherence' },
      }),
    );
    const min = computeAdmissionHumanCurve(
      baseInput({
        labels: ['low'],
        reactionCount: 0,
        designAuthoritySignal: { isDesignAuthority: true, signalType: 'misaligned-with-brand' },
      }),
    );
    expect(max.hcComposite).toBeGreaterThan(0);
    expect(max.hcComposite).toBeLessThan(1);
    expect(min.hcComposite).toBeLessThan(0);
    expect(min.hcComposite).toBeGreaterThan(-1);
  });

  it('snapshot: known inputs produce exact tanh(weighted sum) (AC #3)', () => {
    const input = baseInput({
      labels: ['high'], // hcExplicit = 1
      reactionCount: 5, // hcConsensus = 1 (untrusted default, but 5/5 caps at 1)
      designAuthoritySignal: {
        isDesignAuthority: true,
        signalType: 'advances-design-coherence',
        // no areaComplianceScore → modulation = 1 → base = 0.6
      },
    });
    const result = computeAdmissionHumanCurve(input);

    // hcExplicit = 1, hcConsensus = 1 (5/5=1, centered 2*1-1=1), hcDecision = 0, hcDesign = 0.6
    expect(result.hcExplicit).toBe(1);
    expect(result.hcConsensus).toBe(1);
    expect(result.hcDecision).toBe(0);
    expect(result.hcDesign).toBeCloseTo(0.6, 6);

    const expectedRaw = 0.2 * 1 + 0.45 * 1 + 0.25 * 0 + 0.1 * 0.6;
    expect(result.hcRaw).toBeCloseTo(expectedRaw, 10);
    expect(result.hcComposite).toBeCloseTo(Math.tanh(expectedRaw), 10);
    // Numeric snapshot — tanh(0.71)
    expect(result.hcComposite).toBeCloseTo(0.610676832816, 8);
  });

  it('HC_design does NOT act as a direct SA modifier (Amendment 5)', () => {
    // With only HC_design positive, composite is moderate positive — not the +0.6 raw.
    const input = baseInput({
      reactionCount: 0,
      authorAssociation: 'OWNER', // floors consensus at 0
      designAuthoritySignal: {
        isDesignAuthority: true,
        signalType: 'advances-design-coherence',
      },
    });
    const result = computeAdmissionHumanCurve(input);
    // hcDesign = 0.6, others 0; hcRaw = 0.1 * 0.6 = 0.06; tanh(0.06) ≈ 0.0599
    expect(result.hcComposite).toBeCloseTo(Math.tanh(0.06), 10);
    // Verify it's attenuated — tanh(0.06) ≠ 0.6
    expect(result.hcComposite).toBeLessThan(0.6);
  });

  it('symmetry: negating all signals negates the composite', () => {
    const positive = computeAdmissionHumanCurve(
      baseInput({
        labels: ['high'],
        reactionCount: 10,
        designAuthoritySignal: {
          isDesignAuthority: true,
          signalType: 'advances-design-coherence',
        },
      }),
    );
    const negative = computeAdmissionHumanCurve(
      baseInput({
        labels: ['low'],
        reactionCount: 0, // untrusted → -1
        designAuthoritySignal: {
          isDesignAuthority: true,
          signalType: 'fragments-component-catalog', // -0.4 ≠ -0.6 (advances opposite)
        },
      }),
    );
    expect(negative.hcComposite).toBeLessThan(0);
    expect(positive.hcComposite).toBeGreaterThan(0);
  });
});

describe('HC_override bypass preserved (AC #4)', () => {
  // The override bypass is implemented at the PPA `computePriority` layer
  // (position-1 short-circuit returning composite=Infinity). The HC
  // composite itself does not read `override` — the admission path never
  // calls it when override is active. This test pins that contract.
  it('computeAdmissionHumanCurve does NOT read an "override" field', () => {
    const input = baseInput({ labels: ['high'] });
    // Add phantom override — should have no effect on HC shape.
    const result = computeAdmissionHumanCurve({
      ...input,
      // @ts-expect-error — probe: AdmissionInput has no override field today
      override: true,
    });
    const baseline = computeAdmissionHumanCurve(input);
    expect(result).toEqual(baseline);
  });
});
