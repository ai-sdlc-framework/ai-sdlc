import { describe, it, expect } from 'vitest';
import {
  computeSa1,
  computeSa2,
  computeSoulAlignment,
  getPhaseWeights,
  W_STRUCTURAL_FLOOR,
  type Sa1Inputs,
  type Sa2Inputs,
} from './composite.js';

function sa1Inputs(overrides: Partial<Sa1Inputs> = {}): Sa1Inputs {
  return {
    hardGated: false,
    coreViolationCount: 0,
    evolvingViolationCount: 0,
    domainRelevance: 0.7,
    domainIntent: 0.8,
    subtleConflicts: [],
    ...overrides,
  };
}

function sa2Inputs(overrides: Partial<Sa2Inputs> = {}): Sa2Inputs {
  return {
    tokenCompliance: 0.88,
    catalogHealth: 0.95,
    principleCoverage: 0.72,
    principleAlignment: 0.8,
    coreDesignAntiPatternCount: 0,
    evolvingDesignAntiPatternCount: 0,
    subtleDesignConflicts: [],
    ...overrides,
  };
}

describe('getPhaseWeights', () => {
  it('Phase 2a → (0, 0)', () => {
    expect(getPhaseWeights('2a')).toEqual({ wStructural: 0, wLlm: 0 });
  });

  it('Phase 2b → (0.20, 0.80)', () => {
    expect(getPhaseWeights('2b')).toEqual({ wStructural: 0.2, wLlm: 0.8 });
  });

  it('Phase 2c → (0.35, 0.65)', () => {
    expect(getPhaseWeights('2c')).toEqual({ wStructural: 0.35, wLlm: 0.65 });
  });

  it('Phase 3 default → (0.35, 0.65) when no calibrated weights supplied', () => {
    expect(getPhaseWeights('3')).toEqual({ wStructural: 0.35, wLlm: 0.65 });
  });

  it('AC #2: Phase 3 clamps w_structural below 0.20 up to the floor', () => {
    const result = getPhaseWeights('3', { wStructural: 0.1, wLlm: 0.9 });
    expect(result.wStructural).toBe(W_STRUCTURAL_FLOOR);
    expect(result.wLlm).toBeCloseTo(1 - W_STRUCTURAL_FLOOR, 6);
  });

  it('Phase 3 passes through calibrated weights above the floor', () => {
    const result = getPhaseWeights('3', { wStructural: 0.5, wLlm: 0.5 });
    expect(result.wStructural).toBe(0.5);
    expect(result.wLlm).toBe(0.5);
  });
});

describe('computeSa1', () => {
  it('AC #3: hard gate forces SA-1=0 regardless of other scores', () => {
    const result = computeSa1(
      sa1Inputs({
        hardGated: true,
        domainRelevance: 1.0,
        domainIntent: 1.0,
      }),
      { wStructural: 0.35, wLlm: 0.65 },
    );
    expect(result.sa1).toBe(0);
    expect(result.hardGated).toBe(true);
  });

  it('Phase 2a (0, 0) weights produce SA-1 = 0 even without hard gate', () => {
    const result = computeSa1(sa1Inputs(), { wStructural: 0, wLlm: 0 });
    expect(result.sa1).toBe(0);
    expect(result.blended).toBe(0);
  });

  it('Phase 2b: blended = 0.2 × 0.5 + 0.8 × 0.5 = 0.5 (neutral inputs)', () => {
    const result = computeSa1(sa1Inputs({ domainRelevance: 0.5, domainIntent: 0.5 }), {
      wStructural: 0.2,
      wLlm: 0.8,
    });
    expect(result.blended).toBeCloseTo(0.5, 10);
    expect(result.sa1).toBeCloseTo(0.5, 10);
  });

  it('core violation penalty caps at 0.8 (coreViolationCount ≥ 2)', () => {
    const one = computeSa1(sa1Inputs({ coreViolationCount: 1 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    const two = computeSa1(sa1Inputs({ coreViolationCount: 2 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    const ten = computeSa1(sa1Inputs({ coreViolationCount: 10 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    expect(one.conflictPenalty).toBeCloseTo(0.6, 6);
    expect(two.conflictPenalty).toBeCloseTo(0.2, 6);
    expect(ten.conflictPenalty).toBeCloseTo(0.2, 6);
  });

  it('evolving violation penalty caps at 0.3', () => {
    const result = computeSa1(sa1Inputs({ evolvingViolationCount: 5 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    expect(result.conflictPenalty).toBeCloseTo(0.7, 6); // 1 - 0.3
  });

  it('high-severity subtle conflict halves LLM contribution', () => {
    const without = computeSa1(sa1Inputs({ domainIntent: 1 }), {
      wStructural: 0,
      wLlm: 1,
    });
    const withHigh = computeSa1(
      sa1Inputs({
        domainIntent: 1,
        subtleConflicts: [{ description: 'x', severity: 'high', confidence: 0.9 }],
      }),
      { wStructural: 0, wLlm: 1 },
    );
    expect(withHigh.sa1).toBeCloseTo(without.sa1 * 0.5, 6);
  });

  it('low-severity conflicts do NOT halve LLM contribution', () => {
    const baseline = computeSa1(sa1Inputs({ domainIntent: 1 }), {
      wStructural: 0,
      wLlm: 1,
    });
    const withLow = computeSa1(
      sa1Inputs({
        domainIntent: 1,
        subtleConflicts: [{ description: 'x', severity: 'low', confidence: 0.9 }],
      }),
      { wStructural: 0, wLlm: 1 },
    );
    expect(withLow.sa1).toBeCloseTo(baseline.sa1, 6);
  });

  it('SA-1 is clamped to [0, 1]', () => {
    const result = computeSa1(sa1Inputs({ domainRelevance: 10, domainIntent: 10 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    expect(result.sa1).toBeLessThanOrEqual(1);
    expect(result.sa1).toBeGreaterThanOrEqual(0);
  });
});

describe('computeSa2 — §B.7.2 worked example (AC #1)', () => {
  it('Phase 2c: tc=0.88, ch=0.95, pc=0.72, pa=0.80, no conflicts → SA-2 = 0.840', () => {
    const result = computeSa2(sa2Inputs(), { wStructural: 0.35, wLlm: 0.65 });
    // computableScore = 0.3 × 0.88 + 0.2 × 0.95 = 0.454
    expect(result.computableScore).toBeCloseTo(0.454, 10);
    // blendedScore = 0.35 × 0.72 + 0.65 × 0.80 × 1.0 = 0.252 + 0.52 = 0.772
    expect(result.blendedScore).toBeCloseTo(0.772, 10);
    // designConflictPenalty = 1.0 (no violations)
    expect(result.designConflictPenalty).toBe(1.0);
    // llmComponent = 0.772
    expect(result.llmComponent).toBeCloseTo(0.772, 10);
    // SA-2 = 0.454 + 0.5 × 0.772 = 0.840
    expect(result.sa2).toBeCloseTo(0.84, 6);
  });

  it('design anti-pattern penalty caps at 0.6 (coreAp ≥ 2 saturates penalty)', () => {
    const result = computeSa2(sa2Inputs({ coreDesignAntiPatternCount: 10 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    expect(result.designConflictPenalty).toBeCloseTo(0.4, 6);
  });

  it('evolving anti-pattern adds 0.1 per hit (capped jointly with core)', () => {
    // coreAp=1 → 0.3, evolvingAp=2 → 0.2; total 0.5 → penalty 0.5
    const result = computeSa2(
      sa2Inputs({
        coreDesignAntiPatternCount: 1,
        evolvingDesignAntiPatternCount: 2,
      }),
      { wStructural: 0.35, wLlm: 0.65 },
    );
    expect(result.designConflictPenalty).toBeCloseTo(0.5, 6);
  });

  it('high-severity subtle design conflict halves LLM contribution', () => {
    const without = computeSa2(sa2Inputs(), { wStructural: 0.35, wLlm: 0.65 });
    const withHigh = computeSa2(
      sa2Inputs({
        subtleDesignConflicts: [{ description: 'x', severity: 'high', confidence: 0.9 }],
      }),
      { wStructural: 0.35, wLlm: 0.65 },
    );
    expect(withHigh.subtleMult).toBe(0.5);
    expect(withHigh.sa2).toBeLessThan(without.sa2);
  });

  it('CR-1: no self-multiplication — computable is added, not multiplied into blended', () => {
    // With blendedScore = 0, SA-2 should equal the computable score alone.
    const result = computeSa2(sa2Inputs({ principleCoverage: 0, principleAlignment: 0 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    expect(result.blendedScore).toBe(0);
    expect(result.sa2).toBeCloseTo(result.computableScore, 10);
  });

  it('tokenCompliance/catalogHealth accept percentage input (0-100)', () => {
    const result = computeSa2(sa2Inputs({ tokenCompliance: 88, catalogHealth: 95 }), {
      wStructural: 0.35,
      wLlm: 0.65,
    });
    expect(result.computableScore).toBeCloseTo(0.454, 6);
  });

  it('SA-2 is clamped to [0, 1]', () => {
    const result = computeSa2(
      sa2Inputs({
        tokenCompliance: 1,
        catalogHealth: 1,
        principleCoverage: 1,
        principleAlignment: 1,
      }),
      { wStructural: 0.35, wLlm: 0.65 },
    );
    expect(result.sa2).toBeLessThanOrEqual(1);
  });
});

describe('computeSoulAlignment — end-to-end', () => {
  it('AC #4: Phase 2a returns shadowMode=true so callers skip ranking', () => {
    const result = computeSoulAlignment({
      phase: '2a',
      sa1: sa1Inputs(),
      sa2: sa2Inputs(),
    });
    expect(result.shadowMode).toBe(true);
    expect(result.weights).toEqual({ wStructural: 0, wLlm: 0 });
    expect(result.sa1.sa1).toBe(0);
    // SA-2 still reports the computable half even in shadow mode.
    expect(result.sa2.computableScore).toBeCloseTo(0.454, 6);
  });

  it('Phase 2c reproduces the §B.7.2 worked example (AC #1)', () => {
    const result = computeSoulAlignment({
      phase: '2c',
      sa1: sa1Inputs({ domainRelevance: 0.7, domainIntent: 0.8 }),
      sa2: sa2Inputs(),
    });
    expect(result.sa2.sa2).toBeCloseTo(0.84, 6);
    expect(result.weights).toEqual({ wStructural: 0.35, wLlm: 0.65 });
  });

  it('Phase 3 with calibrated weights below floor clamps to 0.20', () => {
    const result = computeSoulAlignment({
      phase: '3',
      calibratedWeights: { wStructural: 0.05, wLlm: 0.95 },
      sa1: sa1Inputs(),
      sa2: sa2Inputs(),
    });
    expect(result.weights.wStructural).toBe(W_STRUCTURAL_FLOOR);
    expect(result.weights.wLlm).toBeCloseTo(1 - W_STRUCTURAL_FLOOR, 6);
  });

  it('shadowMode is false for Phases 2b/2c/3', () => {
    for (const phase of ['2b', '2c', '3'] as const) {
      const result = computeSoulAlignment({
        phase,
        sa1: sa1Inputs(),
        sa2: sa2Inputs(),
      });
      expect(result.shadowMode).toBe(false);
    }
  });
});
