import { describe, it, expect } from 'vitest';
import { computePriority, rankWorkItems } from './priority.js';
import type { PriorityInput, PriorityConfig } from './priority.js';

/** Minimal valid input — only required fields, all signals defaulted. */
function makeInput(overrides?: Partial<PriorityInput>): PriorityInput {
  return {
    itemId: 'TEST-1',
    title: 'Test item',
    description: 'A test work item',
    ...overrides,
  };
}

// ── Default scores ──────────────────────────────────────────────────

describe('computePriority — defaults', () => {
  it('produces a positive composite when all inputs are missing', () => {
    const result = computePriority(makeInput());
    expect(result.composite).toBeGreaterThan(0);
    expect(result.composite).toBeLessThan(Infinity);
  });

  it('returns all dimension values within their documented bounds', () => {
    const { dimensions } = computePriority(makeInput());

    expect(dimensions.soulAlignment).toBeGreaterThanOrEqual(0);
    expect(dimensions.soulAlignment).toBeLessThanOrEqual(1);

    expect(dimensions.demandPressure).toBeGreaterThanOrEqual(0);
    expect(dimensions.demandPressure).toBeLessThanOrEqual(1.5);

    expect(dimensions.marketForce).toBeGreaterThanOrEqual(0.5);
    expect(dimensions.marketForce).toBeLessThanOrEqual(3.0);

    expect(dimensions.executionReality).toBeGreaterThanOrEqual(0);
    expect(dimensions.executionReality).toBeLessThanOrEqual(1);

    expect(dimensions.entropyTax).toBeGreaterThanOrEqual(0);
    expect(dimensions.entropyTax).toBeLessThanOrEqual(1);

    expect(dimensions.humanCurve).toBeGreaterThanOrEqual(-1);
    expect(dimensions.humanCurve).toBeLessThanOrEqual(1);

    expect(dimensions.calibration).toBeGreaterThanOrEqual(0.7);
    expect(dimensions.calibration).toBeLessThanOrEqual(1.3);
  });

  it('has a valid ISO timestamp', () => {
    const result = computePriority(makeInput());
    expect(() => new Date(result.timestamp)).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });
});

// ── Individual dimensions ───────────────────────────────────────────

describe('computePriority — soul alignment', () => {
  it('uses provided soulAlignment value', () => {
    const result = computePriority(makeInput({ soulAlignment: 0.9 }));
    expect(result.dimensions.soulAlignment).toBeCloseTo(0.9);
  });

  it('clamps soulAlignment to [0, 1]', () => {
    const over = computePriority(makeInput({ soulAlignment: 1.5 }));
    expect(over.dimensions.soulAlignment).toBe(1);

    const under = computePriority(makeInput({ soulAlignment: -0.3 }));
    expect(under.dimensions.soulAlignment).toBe(0);
  });
});

describe('computePriority — demand pressure', () => {
  it('increases with customer request count', () => {
    const low = computePriority(makeInput({ customerRequestCount: 1 }));
    const high = computePriority(makeInput({ customerRequestCount: 10 }));
    expect(high.dimensions.demandPressure).toBeGreaterThan(low.dimensions.demandPressure);
  });

  it('increases with bug severity', () => {
    const low = computePriority(makeInput({ bugSeverity: 1 }));
    const high = computePriority(makeInput({ bugSeverity: 5 }));
    expect(high.dimensions.demandPressure).toBeGreaterThan(low.dimensions.demandPressure);
  });

  it('stays within [0, 1.5]', () => {
    const max = computePriority(
      makeInput({
        customerRequestCount: 100,
        demandSignal: 1,
        bugSeverity: 5,
        builderConviction: 1,
      }),
    );
    expect(max.dimensions.demandPressure).toBeLessThanOrEqual(1.5);

    const min = computePriority(
      makeInput({
        customerRequestCount: 0,
        demandSignal: 0,
        bugSeverity: 0,
        builderConviction: 0,
      }),
    );
    expect(min.dimensions.demandPressure).toBeGreaterThanOrEqual(0);
  });
});

describe('computePriority — market force', () => {
  it('clamps to [0.5, 3.0] even with extreme inputs', () => {
    const maxInputs = computePriority(
      makeInput({
        techInflection: 1,
        competitivePressure: 1,
        regulatoryUrgency: 1,
      }),
    );
    expect(maxInputs.dimensions.marketForce).toBeLessThanOrEqual(3.0);

    const minInputs = computePriority(
      makeInput({
        techInflection: 0,
        competitivePressure: 0,
        regulatoryUrgency: 0,
      }),
    );
    expect(minInputs.dimensions.marketForce).toBeGreaterThanOrEqual(0.5);
  });

  it('equals 0.5 when all market signals are zero', () => {
    const result = computePriority(
      makeInput({
        techInflection: 0,
        competitivePressure: 0,
        regulatoryUrgency: 0,
      }),
    );
    expect(result.dimensions.marketForce).toBeCloseTo(0.5);
  });

  it('equals 3.0 when all market signals are 1', () => {
    const result = computePriority(
      makeInput({
        techInflection: 1,
        competitivePressure: 1,
        regulatoryUrgency: 1,
      }),
    );
    expect(result.dimensions.marketForce).toBeCloseTo(3.0);
  });
});

describe('computePriority — execution reality', () => {
  it('decreases with higher complexity', () => {
    const easy = computePriority(makeInput({ complexity: 1 }));
    const hard = computePriority(makeInput({ complexity: 10 }));
    expect(easy.dimensions.executionReality).toBeGreaterThan(hard.dimensions.executionReality);
  });

  it('decreases with higher budget utilization', () => {
    const low = computePriority(makeInput({ budgetUtilization: 10 }));
    const high = computePriority(makeInput({ budgetUtilization: 90 }));
    expect(low.dimensions.executionReality).toBeGreaterThan(high.dimensions.executionReality);
  });

  it('stays within [0, 1]', () => {
    const result = computePriority(
      makeInput({
        complexity: 1,
        budgetUtilization: 0,
        dependencyClearance: 1,
      }),
    );
    expect(result.dimensions.executionReality).toBeLessThanOrEqual(1);
    expect(result.dimensions.executionReality).toBeGreaterThanOrEqual(0);
  });
});

describe('computePriority — entropy tax', () => {
  it('defaults to 0 when no drift/divergence signals', () => {
    const result = computePriority(makeInput());
    expect(result.dimensions.entropyTax).toBe(0);
  });

  it('increases composite penalty with higher entropy', () => {
    const noDrift = computePriority(
      makeInput({
        competitiveDrift: 0,
        marketDivergence: 0,
      }),
    );
    const highDrift = computePriority(
      makeInput({
        competitiveDrift: 0.8,
        marketDivergence: 0.8,
      }),
    );
    // (1 - entropyTax) factor makes composite lower with high entropy
    expect(highDrift.composite).toBeLessThan(noDrift.composite);
  });

  it('clamps to [0, 1]', () => {
    const result = computePriority(
      makeInput({
        competitiveDrift: 1,
        marketDivergence: 1,
      }),
    );
    expect(result.dimensions.entropyTax).toBeLessThanOrEqual(1);
    expect(result.dimensions.entropyTax).toBeGreaterThanOrEqual(0);
  });
});

describe('computePriority — human curve', () => {
  it('produces ~0 when all HC inputs are at default (0.5)', () => {
    const result = computePriority(
      makeInput({
        explicitPriority: 0.5,
        teamConsensus: 0.5,
        meetingDecision: 0.5,
      }),
    );
    expect(result.dimensions.humanCurve).toBeCloseTo(0, 5);
  });

  it('is bounded by tanh to [-1, 1] even with extreme inputs', () => {
    const high = computePriority(
      makeInput({
        explicitPriority: 1,
        teamConsensus: 1,
        meetingDecision: 1,
      }),
    );
    expect(high.dimensions.humanCurve).toBeGreaterThan(0);
    expect(high.dimensions.humanCurve).toBeLessThanOrEqual(1);

    const low = computePriority(
      makeInput({
        explicitPriority: 0,
        teamConsensus: 0,
        meetingDecision: 0,
      }),
    );
    expect(low.dimensions.humanCurve).toBeLessThan(0);
    expect(low.dimensions.humanCurve).toBeGreaterThanOrEqual(-1);
  });

  it('respects custom HC weights', () => {
    const config: PriorityConfig = {
      humanCurveWeights: { explicit: 1.0, consensus: 0, decision: 0 },
    };
    const highExplicit = computePriority(
      makeInput({ explicitPriority: 1, teamConsensus: 0, meetingDecision: 0 }),
      config,
    );
    const lowExplicit = computePriority(
      makeInput({ explicitPriority: 0, teamConsensus: 1, meetingDecision: 1 }),
      config,
    );
    // With all weight on explicit, high explicit should dominate
    expect(highExplicit.dimensions.humanCurve).toBeGreaterThan(lowExplicit.dimensions.humanCurve);
  });
});

describe('computePriority — calibration', () => {
  it('defaults to 1.0', () => {
    const result = computePriority(makeInput());
    expect(result.dimensions.calibration).toBe(1.0);
  });

  it('clamps to [0.7, 1.3]', () => {
    const over = computePriority(makeInput(), { calibrationCoefficient: 2.0 });
    expect(over.dimensions.calibration).toBe(1.3);

    const under = computePriority(makeInput(), { calibrationCoefficient: 0.1 });
    expect(under.dimensions.calibration).toBe(0.7);
  });

  it('scales the composite proportionally', () => {
    const base = computePriority(makeInput(), { calibrationCoefficient: 1.0 });
    const boosted = computePriority(makeInput(), { calibrationCoefficient: 1.3 });
    expect(boosted.composite).toBeCloseTo(base.composite * 1.3, 5);
  });
});

// ── Multiplicative zeroing ──────────────────────────────────────────

describe('computePriority — multiplicative zeroing', () => {
  it('soul alignment = 0 makes composite = 0', () => {
    const result = computePriority(makeInput({ soulAlignment: 0 }));
    expect(result.composite).toBe(0);
  });

  it('entropy tax = 1 makes composite = 0 via (1 - Eτ) factor', () => {
    const result = computePriority(
      makeInput({
        competitiveDrift: 1,
        marketDivergence: 1,
      }),
    );
    expect(result.composite).toBe(0);
  });

  it('all demand pressure inputs at zero makes composite = 0', () => {
    const result = computePriority(
      makeInput({
        customerRequestCount: 0,
        demandSignal: 0,
        bugSeverity: 0,
        builderConviction: 0,
      }),
    );
    expect(result.composite).toBe(0);
  });
});

// ── Override ─────────────────────────────────────────────────────────

describe('computePriority — override', () => {
  it('returns composite = Infinity when override is true', () => {
    const result = computePriority(
      makeInput({
        override: true,
        overrideReason: 'CEO said so',
      }),
    );
    expect(result.composite).toBe(Infinity);
  });

  it('includes override metadata in the result', () => {
    const result = computePriority(
      makeInput({
        override: true,
        overrideReason: 'Urgent security fix',
        overrideExpiry: '2026-04-01T00:00:00Z',
      }),
    );
    expect(result.override).toBeDefined();
    expect(result.override!.reason).toBe('Urgent security fix');
    expect(result.override!.expiry).toBe('2026-04-01T00:00:00Z');
  });

  it('uses default reason when overrideReason is not provided', () => {
    const result = computePriority(makeInput({ override: true }));
    expect(result.override!.reason).toBe('No reason provided');
  });

  it('sets confidence to 1 for overrides', () => {
    const result = computePriority(makeInput({ override: true }));
    expect(result.confidence).toBe(1);
  });

  it('does not override when override flag is false', () => {
    const result = computePriority(makeInput({ override: false }));
    expect(result.composite).not.toBe(Infinity);
    expect(result.override).toBeUndefined();
  });
});

// ── Confidence scoring ──────────────────────────────────────────────

describe('computePriority — confidence', () => {
  it('returns 0 confidence when no optional fields are provided', () => {
    const result = computePriority(makeInput());
    expect(result.confidence).toBe(0);
  });

  it('returns 1 confidence when all scorable fields are provided', () => {
    const result = computePriority(
      makeInput({
        soulAlignment: 0.8,
        customerRequestCount: 5,
        demandSignal: 0.6,
        bugSeverity: 3,
        builderConviction: 0.7,
        techInflection: 0.5,
        competitivePressure: 0.4,
        regulatoryUrgency: 0.2,
        complexity: 5,
        budgetUtilization: 40,
        dependencyClearance: 0.9,
        competitiveDrift: 0.1,
        marketDivergence: 0.1,
        explicitPriority: 0.7,
        teamConsensus: 0.6,
        meetingDecision: 0.5,
      }),
    );
    expect(result.confidence).toBe(1);
  });

  it('returns partial confidence for partially-filled inputs', () => {
    const result = computePriority(
      makeInput({
        soulAlignment: 0.8,
        complexity: 5,
        bugSeverity: 3,
      }),
    );
    // 3 out of 16 fields
    expect(result.confidence).toBeCloseTo(3 / 16);
  });
});

// ── rankWorkItems ───────────────────────────────────────────────────

describe('rankWorkItems', () => {
  it('returns items sorted by descending composite score', () => {
    const items: PriorityInput[] = [
      makeInput({ itemId: 'LOW', soulAlignment: 0.1 }),
      makeInput({ itemId: 'HIGH', soulAlignment: 0.9 }),
      makeInput({ itemId: 'MID', soulAlignment: 0.5 }),
    ];

    const ranked = rankWorkItems(items);
    expect(ranked[0].itemId).toBe('HIGH');
    expect(ranked[1].itemId).toBe('MID');
    expect(ranked[2].itemId).toBe('LOW');
  });

  it('places override items first (Infinity)', () => {
    const items: PriorityInput[] = [
      makeInput({ itemId: 'NORMAL', soulAlignment: 1 }),
      makeInput({ itemId: 'OVERRIDE', override: true, overrideReason: 'Urgent' }),
    ];

    const ranked = rankWorkItems(items);
    expect(ranked[0].itemId).toBe('OVERRIDE');
    expect(ranked[0].score.composite).toBe(Infinity);
  });

  it('attaches score property to each item', () => {
    const ranked = rankWorkItems([makeInput()]);
    expect(ranked[0].score).toBeDefined();
    expect(ranked[0].score.composite).toBeGreaterThan(0);
    expect(ranked[0].score.dimensions).toBeDefined();
  });

  it('preserves all original input fields', () => {
    const input = makeInput({ itemId: 'KEEP', labels: ['bug', 'p1'] });
    const ranked = rankWorkItems([input]);
    expect(ranked[0].itemId).toBe('KEEP');
    expect(ranked[0].labels).toEqual(['bug', 'p1']);
  });

  it('handles empty array', () => {
    const ranked = rankWorkItems([]);
    expect(ranked).toEqual([]);
  });

  it('passes config through to each computation', () => {
    const items: PriorityInput[] = [makeInput({ itemId: 'A' }), makeInput({ itemId: 'B' })];

    const config: PriorityConfig = { calibrationCoefficient: 1.3 };
    const ranked = rankWorkItems(items, config);
    for (const item of ranked) {
      expect(item.score.dimensions.calibration).toBe(1.3);
    }
  });
});

// ── Formula integration ─────────────────────────────────────────────

describe('computePriority — formula integration', () => {
  it('composite equals the product of all dimension factors', () => {
    const input = makeInput({
      soulAlignment: 0.8,
      customerRequestCount: 5,
      demandSignal: 0.6,
      bugSeverity: 3,
      builderConviction: 0.7,
      techInflection: 0.5,
      competitivePressure: 0.4,
      regulatoryUrgency: 0.3,
      complexity: 4,
      budgetUtilization: 30,
      dependencyClearance: 0.9,
      competitiveDrift: 0.1,
      marketDivergence: 0.2,
      explicitPriority: 0.7,
      teamConsensus: 0.6,
      meetingDecision: 0.5,
    });

    const result = computePriority(input);
    const d = result.dimensions;

    const expected =
      d.soulAlignment *
      d.demandPressure *
      d.marketForce *
      d.executionReality *
      (1 - d.entropyTax) *
      (1 + d.humanCurve) *
      d.calibration;

    expect(result.composite).toBeCloseTo(expected, 10);
  });
});
