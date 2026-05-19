import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { computePriority, type PriorityInput } from './priority.js';
import {
  CALIBRATION_MIN,
  CALIBRATION_MAX,
  CALIBRATION_SLOPE,
  buildCategoryCoefficients,
  buildSoulCalibrationMatrix,
  computeCalibrationCoefficient,
} from './calibration.js';
import { SAFeedbackStore } from './sa-scoring/feedback-store.js';
import { StateStore } from './state/store.js';

function baseInput(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    itemId: '#1',
    title: 't',
    description: 'd',
    soulAlignment: 0.7,
    demandSignal: 0.6,
    builderConviction: 0.6,
    complexity: 5,
    ...overrides,
  };
}

describe('computeCalibrationCoefficient (AC #2, #4)', () => {
  it('returns 1.0 neutral when no feedback', () => {
    expect(computeCalibrationCoefficient({ accepts: 0, dismisses: 0, escalates: 0 })).toBe(1.0);
  });

  it('10 accepts + 2 escalates → ≈ 1.2', () => {
    const v = computeCalibrationCoefficient({ accepts: 10, dismisses: 0, escalates: 2 });
    expect(v).toBeCloseTo(1.0 + (8 / 12) * CALIBRATION_SLOPE, 10);
    expect(v).toBeCloseTo(1.2, 6);
  });

  it('clamps ceiling at 1.3', () => {
    const v = computeCalibrationCoefficient({ accepts: 100, dismisses: 0, escalates: 0 });
    expect(v).toBe(CALIBRATION_MAX);
  });

  it('clamps floor at 0.7', () => {
    const v = computeCalibrationCoefficient({ accepts: 0, dismisses: 0, escalates: 100 });
    expect(v).toBe(CALIBRATION_MIN);
  });

  it('dismisses count in denominator but not numerator', () => {
    // accepts=4, dismisses=4, escalates=0 → delta = 4/8 = 0.5 → 1.15
    const v = computeCalibrationCoefficient({ accepts: 4, dismisses: 4, escalates: 0 });
    expect(v).toBeCloseTo(1.0 + 0.5 * CALIBRATION_SLOPE, 10);
  });

  it('respects the 0.3 slope constant', () => {
    expect(CALIBRATION_SLOPE).toBe(0.3);
  });
});

describe('computePriority calibration wiring (AC #1, #3)', () => {
  it('AC #1: scalar path unchanged when no categoryResolver', () => {
    const result = computePriority(baseInput(), { calibrationCoefficient: 1.2 });
    expect(result.dimensions.calibration).toBeCloseTo(1.2, 6);
  });

  it('categoryResolver + coefficient overrides scalar', () => {
    const result = computePriority(baseInput(), {
      calibrationCoefficient: 1.0,
      categoryResolver: () => 'design',
      categoryCoefficients: { design: 1.25, product: 0.85 },
    });
    expect(result.dimensions.calibration).toBeCloseTo(1.25, 6);
  });

  it('falls back to scalar when category has no coefficient entry', () => {
    const result = computePriority(baseInput(), {
      calibrationCoefficient: 1.1,
      categoryResolver: () => 'design',
      categoryCoefficients: { product: 0.9 }, // no 'design' entry
    });
    expect(result.dimensions.calibration).toBeCloseTo(1.1, 6);
  });

  it('falls back to scalar when resolver returns undefined', () => {
    const result = computePriority(baseInput(), {
      calibrationCoefficient: 0.85,
      categoryResolver: () => undefined,
      categoryCoefficients: { product: 1.2 },
    });
    expect(result.dimensions.calibration).toBeCloseTo(0.85, 6);
  });

  it('AC #3: category coefficient also clamped to [0.7, 1.3]', () => {
    const high = computePriority(baseInput(), {
      categoryResolver: () => 'spam',
      categoryCoefficients: { spam: 5 },
    });
    expect(high.dimensions.calibration).toBe(1.3);

    const low = computePriority(baseInput(), {
      categoryResolver: () => 'spam',
      categoryCoefficients: { spam: -1 },
    });
    expect(low.dimensions.calibration).toBe(0.7);
  });
});

describe('buildCategoryCoefficients', () => {
  let db: InstanceType<typeof Database>;
  let store: StateStore;
  let feedback: SAFeedbackStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
    feedback = new SAFeedbackStore(store);
  });

  afterEach(() => {
    store.close();
  });

  it('aggregates accepts/dismisses/escalates by category and returns coefficients', () => {
    // product: 6 accepts, 2 escalates → 1.0 + 4/8 * 0.3 = 1.15
    for (let i = 0; i < 6; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'accept',
        category: 'product',
      });
    }
    for (let i = 6; i < 8; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'escalate',
        category: 'product',
      });
    }
    // design: 2 accepts, 4 escalates → 1.0 + (2-4)/6 * 0.3 = 0.9
    for (let i = 10; i < 12; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'accept',
        category: 'design',
      });
    }
    for (let i = 12; i < 16; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'escalate',
        category: 'design',
      });
    }
    const coefs = buildCategoryCoefficients(feedback);
    expect(coefs.product).toBeCloseTo(1.15, 6);
    expect(coefs.design).toBeCloseTo(0.9, 6);
  });

  it('excludes categories below minSampleSize', () => {
    feedback.record({
      didName: 'd',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      category: 'rare',
    });
    const coefs = buildCategoryCoefficients(feedback, { minSampleSize: 5 });
    expect(coefs.rare).toBeUndefined();
  });

  it('override signals do NOT count toward accept/escalate math', () => {
    feedback.record({
      didName: 'd',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'override',
      category: 'ops',
    });
    feedback.record({
      didName: 'd',
      issueNumber: 2,
      dimension: 'SA-1',
      signal: 'accept',
      category: 'ops',
    });
    const coefs = buildCategoryCoefficients(feedback);
    // 1 accept, 0 escalates, 1 override → samples = 1, delta = 1/1 = 1 → 1.3 clamped
    expect(coefs.ops).toBe(CALIBRATION_MAX);
  });

  it('categories filter scopes the output', () => {
    feedback.record({
      didName: 'd',
      issueNumber: 1,
      dimension: 'SA-1',
      signal: 'accept',
      category: 'include-me',
    });
    feedback.record({
      didName: 'd',
      issueNumber: 2,
      dimension: 'SA-1',
      signal: 'accept',
      category: 'ignore-me',
    });
    const coefs = buildCategoryCoefficients(feedback, { categories: ['include-me'] });
    expect(Object.keys(coefs)).toEqual(['include-me']);
  });

  it('wires end-to-end into computePriority via generated table', () => {
    // 3 accepts, 0 escalates, 0 dismisses → 1.3 (clamped ceiling)
    for (let i = 0; i < 3; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: i,
        dimension: 'SA-1',
        signal: 'accept',
        category: 'product',
      });
    }
    const coefs = buildCategoryCoefficients(feedback);
    const result = computePriority(
      { ...baseInput(), labels: ['product'] },
      {
        categoryResolver: (input) => input.labels?.[0],
        categoryCoefficients: coefs,
      },
    );
    expect(result.dimensions.calibration).toBe(CALIBRATION_MAX);
  });
});

// ── RFC-0009 Phase 2.2 — buildSoulCalibrationMatrix (AC #3) ──────────

describe('buildSoulCalibrationMatrix (RFC-0009 Phase 2.2 AC #3)', () => {
  let db: InstanceType<typeof Database>;
  let store: StateStore;
  let feedback: SAFeedbackStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
    feedback = new SAFeedbackStore(store);
  });

  afterEach(() => {
    store.close();
  });

  function recordFeedback(
    soul: string,
    dimension: 'SA-1' | 'SA-2',
    accepts: number,
    escalates: number,
    issueOffset = 0,
  ) {
    for (let i = 0; i < accepts; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: issueOffset + i,
        dimension,
        signal: 'accept',
        category: soul,
      });
    }
    for (let i = 0; i < escalates; i++) {
      feedback.record({
        didName: 'd',
        issueNumber: issueOffset + accepts + i,
        dimension,
        signal: 'escalate',
        category: soul,
      });
    }
  }

  it('AC #3: returns N×M cells for souls × dimensions', () => {
    // soul-a: SA-1 → 10 accepts, 2 escalates → coefficient ≈ 1.2
    recordFeedback('soul-a', 'SA-1', 10, 2);
    // soul-b: SA-1 → 4 accepts, 4 escalates → coefficient = 1.0
    recordFeedback('soul-b', 'SA-1', 4, 4, 100);
    // soul-a: SA-2 → 6 accepts, 0 escalates → coefficient = 1.3 (clamped)
    recordFeedback('soul-a', 'SA-2', 6, 0, 200);

    const matrix = buildSoulCalibrationMatrix(feedback, {
      souls: ['soul-a', 'soul-b', 'soul-c'],
      dimensions: ['SA-1', 'SA-2'],
    });

    // soul-a: SA-1 coefficient ≈ 1.0 + (8/12) * 0.3 = 1.2
    expect(matrix.cells['soul-a']?.['SA-1']).toBeCloseTo(1.2, 6);

    // soul-a: SA-2 coefficient = 1.3 (clamped ceiling)
    expect(matrix.cells['soul-a']?.['SA-2']).toBe(CALIBRATION_MAX);

    // soul-b: SA-1 coefficient = 1.0 + (0/8) * 0.3 = 1.0
    expect(matrix.cells['soul-b']?.['SA-1']).toBeCloseTo(1.0, 6);

    // soul-b: SA-2 — no data → cell absent (caller falls back to 1.0)
    expect(matrix.cells['soul-b']?.['SA-2']).toBeUndefined();

    // soul-c: no data → no cells emitted
    expect(matrix.cells['soul-c']).toBeUndefined();
  });

  it('AC #3: souls without data are absent from cells (not zero)', () => {
    recordFeedback('soul-a', 'SA-1', 3, 0);

    const matrix = buildSoulCalibrationMatrix(feedback, {
      souls: ['soul-a', 'soul-b'],
    });

    expect(matrix.cells['soul-a']).toBeDefined();
    expect(matrix.cells['soul-b']).toBeUndefined();
  });

  it('AC #3: souls and dimensions are correctly reported in the matrix metadata', () => {
    const matrix = buildSoulCalibrationMatrix(feedback, {
      souls: ['soul-a', 'soul-b'],
      dimensions: ['SA-1', 'SA-2'],
    });

    expect(matrix.souls).toEqual(['soul-a', 'soul-b']);
    expect(matrix.dimensions).toEqual(['SA-1', 'SA-2']);
  });

  it('AC #5: minSampleSize filters out cells with insufficient data', () => {
    // Only 2 events — below minSampleSize=5
    recordFeedback('soul-a', 'SA-1', 2, 0);

    const matrix = buildSoulCalibrationMatrix(feedback, {
      souls: ['soul-a'],
      minSampleSize: 5,
    });

    // Cell should be absent because sample size < 5
    expect(matrix.cells['soul-a']?.['SA-1']).toBeUndefined();
  });

  it('AC #3: defaults to all SA dimensions when dimensions not specified', () => {
    recordFeedback('soul-a', 'SA-1', 5, 0);
    recordFeedback('soul-a', 'SA-2', 5, 0, 100);

    const matrix = buildSoulCalibrationMatrix(feedback, { souls: ['soul-a'] });

    // Both SA-1 and SA-2 sampled by default
    expect(matrix.dimensions).toContain('SA-1');
    expect(matrix.dimensions).toContain('SA-2');
    expect(matrix.cells['soul-a']?.['SA-1']).toBeDefined();
    expect(matrix.cells['soul-a']?.['SA-2']).toBeDefined();
  });

  it('AC #3: returns empty cells when no souls provided', () => {
    const matrix = buildSoulCalibrationMatrix(feedback, { souls: [] });
    expect(Object.keys(matrix.cells)).toHaveLength(0);
    expect(matrix.souls).toHaveLength(0);
  });

  it('cross-soul independence: soul-a calibration does not contaminate soul-b', () => {
    // soul-a: very positive → 1.3 (clamped ceiling)
    recordFeedback('soul-a', 'SA-1', 100, 0);
    // soul-b: very negative → 0.7 (clamped floor)
    recordFeedback('soul-b', 'SA-1', 0, 100, 200);

    const matrix = buildSoulCalibrationMatrix(feedback, {
      souls: ['soul-a', 'soul-b'],
    });

    expect(matrix.cells['soul-a']?.['SA-1']).toBe(CALIBRATION_MAX);
    expect(matrix.cells['soul-b']?.['SA-1']).toBe(CALIBRATION_MIN);
  });
});
