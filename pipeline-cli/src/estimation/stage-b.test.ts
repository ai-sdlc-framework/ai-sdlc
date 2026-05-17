/**
 * Stage B tests — RFC-0016 Phase 4 (AISDLC-282).
 *
 * Covers all 6 ACs:
 *  AC #1 — Stage B only invoked under §5.2 escalation OR variance ≥ 2
 *  AC #2 — Stage A signal table passed as context per §6.1
 *  AC #3 — Returns one bucket or 2-bucket range with justification
 *  AC #4 — estimateVariance per hash transition recorded
 *  AC #5 — Q5 ensemble aggregation across multiple LLM calls
 *  AC #6 — Stage B call rate stays below 30% telemetry metric
 *
 * All tests are hermetic — no real LLM calls; a mock `StageBInvoker` is
 * injected via the `invoker` option. No disk I/O in Stage B itself.
 */

import { describe, expect, it } from 'vitest';
import {
  shouldEscalateToStageB,
  buildStageBPrompt,
  parseStageBResponse,
  runStageB,
  aggregateStageBEnsemble,
  computeEnsembleVarianceForHash,
  computeStageBCallRate,
  STAGE_B_CALL_RATE_THRESHOLD,
  type StageBInvoker,
  type StageBVerdict,
} from './stage-b.js';
import type { StageAResult, SignalOutput, Bucket, SignalId } from './types.js';
import type { EstimateLogRecord } from './log-writer.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function sig(id: SignalId, kind: 'bucket', bucket: Bucket): SignalOutput;
function sig(id: SignalId, kind: 'range', low: Bucket, high: Bucket): SignalOutput;
function sig(id: SignalId, kind: 'bump', delta: number): SignalOutput;
function sig(id: SignalId, kind: 'unknown', reason: string): SignalOutput;
function sig(id: SignalId, kind: string, arg1: unknown, arg2?: unknown): SignalOutput {
  let result: SignalOutput['result'];
  if (kind === 'bucket') {
    result = { kind: 'bucket', bucket: arg1 as Bucket };
  } else if (kind === 'range') {
    result = { kind: 'range', low: arg1 as Bucket, high: arg2 as Bucket };
  } else if (kind === 'bump') {
    result = { kind: 'bump', delta: arg1 as number };
  } else {
    result = { kind: 'unknown', reason: arg1 as string };
  }
  return { id: id as SignalId, name: `signal-${id}`, inputs: {}, result };
}

/**
 * Build a minimal `StageAResult` with low confidence (escalates to B).
 * Signals split across S and L (non-adjacent).
 */
function makeLowConfidenceStageA(): StageAResult {
  return {
    taskId: 'AISDLC-999',
    taskClass: 'feature',
    classSource: 'heuristic',
    signals: [
      sig(1, 'bucket', 'S'),
      sig(2, 'unknown', 'no calibration'),
      sig(3, 'bucket', 'L'),
      sig(4, 'bump', 0),
      sig(5, 'bump', 0),
      sig(6, 'bump', 0),
      sig(7, 'bump', 0),
      sig(8, 'unknown', 'no events'),
      sig(9, 'bucket', 'M'),
    ],
    candidateBucket: 'S',
    candidateRange: { low: 'S', high: 'L' },
    confidence: 'low',
    escalateToStageB: true,
    rationale: 'signals split S vs L',
  };
}

/**
 * Build a minimal `StageAResult` with high confidence (does NOT escalate).
 */
function makeHighConfidenceStageA(): StageAResult {
  return {
    taskId: 'AISDLC-998',
    taskClass: 'bug',
    classSource: 'heuristic',
    signals: [
      sig(1, 'range', 'XS', 'S'),
      sig(2, 'unknown', 'no calibration'),
      sig(3, 'unknown', 'no LOC'),
      sig(4, 'bump', 0),
      sig(5, 'bump', 0),
      sig(6, 'bump', 0),
      sig(7, 'range', 'XS', 'S'),
      sig(8, 'unknown', 'no events'),
      sig(9, 'bucket', 'S'),
    ],
    candidateBucket: 'XS',
    candidateRange: { low: 'XS', high: 'S' },
    confidence: 'medium',
    escalateToStageB: false,
    rationale: 'signals agree on XS-S',
  };
}

/** Create an invoker that always returns the given raw string. */
function mockInvoker(response: string): StageBInvoker {
  return async (_prompt: string) => response;
}

/** Create a well-formed Stage B response for a single bucket. */
function goodResponse(bucket: string, justification = 'test justification'): string {
  return `BUCKET: ${bucket}\nJUSTIFICATION: ${justification}`;
}

// ── AC #1 — Escalation gate ────────────────────────────────────────────────

describe('shouldEscalateToStageB — AC #1', () => {
  it('escalates when Stage A confidence = low (escalateToStageB: true)', () => {
    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: true },
        variance: 0,
      }),
    ).toBe(true);
  });

  it('escalates when variance ≥ 2 regardless of Stage A confidence', () => {
    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: false },
        variance: 2,
      }),
    ).toBe(true);

    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: false },
        variance: 3,
      }),
    ).toBe(true);
  });

  it('does NOT escalate when confidence is high/medium AND variance < 2', () => {
    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: false },
        variance: 0,
      }),
    ).toBe(false);

    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: false },
        variance: 1,
      }),
    ).toBe(false);
  });

  it('escalates when BOTH conditions are true (belt-and-suspenders)', () => {
    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: true },
        variance: 3,
      }),
    ).toBe(true);
  });
});

describe('runStageB escalation gate — AC #1', () => {
  it('returns StageBSkipped when escalation conditions are not met', async () => {
    const result = await runStageB({
      taskTitle: 'test task',
      taskDescription: '',
      stageAResult: makeHighConfidenceStageA(),
      variance: 0,
      invoker: mockInvoker(goodResponse('M')),
    });
    expect(result.invoked).toBe(false);
    if (!result.invoked) {
      expect(result.skipReason).toMatch(/escalation conditions not met/);
    }
  });

  it('returns StageBSkipped when no invoker provided (dry-run)', async () => {
    const result = await runStageB({
      taskTitle: 'test task',
      taskDescription: '',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      // no invoker
    });
    expect(result.invoked).toBe(false);
    if (!result.invoked) {
      expect(result.skipReason).toMatch(/no LLM invoker/i);
    }
  });

  it('escalates when variance ≥ 2 even with medium confidence Stage A', async () => {
    const mediumStageA = makeHighConfidenceStageA();
    // variance=2 overrides the non-escalating Stage A
    const result = await runStageB({
      taskTitle: 'test',
      taskDescription: '',
      stageAResult: mediumStageA,
      variance: 2,
      invoker: mockInvoker(goodResponse('M', 'high variance justifies Stage B')),
    });
    expect(result.invoked).toBe(true);
  });
});

// ── AC #2 — Stage A signal table in prompt ─────────────────────────────────

describe('buildStageBPrompt — AC #2', () => {
  it('includes task title, class, and all 9 signals in the prompt', () => {
    const stageA = makeLowConfidenceStageA();
    const prompt = buildStageBPrompt({
      taskTitle: 'feat: add Stage B',
      taskDescription: 'Implement the LLM tie-breaker',
      taskClass: 'feature',
      stageAResult: stageA,
    });

    expect(prompt).toContain('feat: add Stage B');
    expect(prompt).toContain('feature');
    expect(prompt).toContain('DETERMINISTIC SIGNALS (Stage A)');
    // All 9 signal IDs present
    for (let i = 1; i <= 9; i++) {
      expect(prompt).toContain(`${i}.`);
    }
  });

  it('includes the Stage A verdict line with confidence rating', () => {
    const stageA = makeLowConfidenceStageA();
    const prompt = buildStageBPrompt({
      taskTitle: 'test task',
      taskDescription: '',
      taskClass: 'feature',
      stageAResult: stageA,
    });
    expect(prompt).toContain('STAGE A VERDICT');
    expect(prompt).toContain('confidence: low');
  });

  it('includes DISAGREEMENT section describing the split', () => {
    const stageA = makeLowConfidenceStageA();
    const prompt = buildStageBPrompt({
      taskTitle: 'test',
      taskDescription: '',
      taskClass: 'feature',
      stageAResult: stageA,
    });
    expect(prompt).toContain('DISAGREEMENT');
    // Should mention the two conflicting buckets
    expect(prompt).toContain('S');
    expect(prompt).toContain('L');
  });

  it('includes task description when provided', () => {
    const prompt = buildStageBPrompt({
      taskTitle: 'test',
      taskDescription: 'This is a complex multi-module integration task',
      taskClass: 'feature',
      stageAResult: makeLowConfidenceStageA(),
    });
    expect(prompt).toContain('complex multi-module integration task');
  });

  it('omits task description line when empty', () => {
    const prompt = buildStageBPrompt({
      taskTitle: 'test',
      taskDescription: '',
      taskClass: 'feature',
      stageAResult: makeLowConfidenceStageA(),
    });
    expect(prompt).not.toContain('TASK DESCRIPTION');
  });

  it('formats bucket signals with → bucket label', () => {
    const prompt = buildStageBPrompt({
      taskTitle: 'test',
      taskDescription: '',
      taskClass: 'feature',
      stageAResult: makeLowConfidenceStageA(),
    });
    expect(prompt).toMatch(/→ bucket [A-Z]/);
  });

  it('formats bump signals with ± delta label', () => {
    const prompt = buildStageBPrompt({
      taskTitle: 'test',
      taskDescription: '',
      taskClass: 'feature',
      stageAResult: makeLowConfidenceStageA(),
    });
    expect(prompt).toMatch(/→ [+-]?\d+ bucket bump/);
  });
});

// ── AC #3 — Returns bucket or range + justification ────────────────────────

describe('parseStageBResponse — AC #3', () => {
  it('parses single-bucket response', () => {
    const verdict = parseStageBResponse(
      'BUCKET: M\nJUSTIFICATION: Historical actuals dominate.',
      'sha256:abc',
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.bucket).toBe('M');
    expect(verdict!.bucketHigh).toBeUndefined();
    expect(verdict!.justification).toContain('Historical actuals');
    expect(verdict!.promptHash).toBe('sha256:abc');
  });

  it('parses 2-bucket range response (S-M)', () => {
    const verdict = parseStageBResponse(
      'BUCKET: S-M\nJUSTIFICATION: Straddles two buckets.',
      'sha256:def',
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.bucket).toBe('S');
    expect(verdict!.bucketHigh).toBe('M');
  });

  it('parses XL range (M-XL)', () => {
    const verdict = parseStageBResponse(
      'BUCKET: M-XL\nJUSTIFICATION: Wide uncertainty.',
      'sha256:ghi',
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.bucket).toBe('M');
    expect(verdict!.bucketHigh).toBe('XL');
  });

  it('parses case-insensitive bucket names', () => {
    const verdict = parseStageBResponse('bucket: xl\njustification: Large task.', 'sha256:jkl');
    expect(verdict).not.toBeNull();
    expect(verdict!.bucket).toBe('XL');
  });

  it('normalises reversed range so low ≤ high', () => {
    const verdict = parseStageBResponse('BUCKET: L-S\nJUSTIFICATION: Swapped.', 'sha256:mno');
    expect(verdict).not.toBeNull();
    expect(BUCKET_INDEX[verdict!.bucket]).toBeLessThanOrEqual(
      BUCKET_INDEX[verdict!.bucketHigh ?? verdict!.bucket],
    );
  });

  it('returns null for unparseable response', () => {
    expect(parseStageBResponse('I think it might be medium', 'sha256:x')).toBeNull();
    expect(parseStageBResponse('', 'sha256:y')).toBeNull();
  });

  it('defaults justification to placeholder when missing', () => {
    const verdict = parseStageBResponse('BUCKET: S', 'sha256:z');
    expect(verdict).not.toBeNull();
    expect(verdict!.justification).toMatch(/no justification/i);
  });
});

describe('runStageB end-to-end — AC #3', () => {
  it('returns invoked:true with verdict when LLM returns valid single bucket', async () => {
    const result = await runStageB({
      taskTitle: 'feat: add stage B',
      taskDescription: 'LLM tie-breaker',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      invoker: mockInvoker(
        'BUCKET: L\nJUSTIFICATION: Historical actuals + workflow YAML push toward L.',
      ),
    });
    expect(result.invoked).toBe(true);
    if (result.invoked) {
      expect(result.verdict.bucket).toBe('L');
      expect(result.verdict.justification).toContain('Historical actuals');
      expect(result.verdict.promptHash).toMatch(/^sha256:/);
    }
  });

  it('returns invoked:true with range verdict', async () => {
    const result = await runStageB({
      taskTitle: 'feat: add stage B',
      taskDescription: '',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      invoker: mockInvoker('BUCKET: M-L\nJUSTIFICATION: Range between M and L.'),
    });
    expect(result.invoked).toBe(true);
    if (result.invoked) {
      expect(result.verdict.bucket).toBe('M');
      expect(result.verdict.bucketHigh).toBe('L');
    }
  });

  it('returns StageBSkipped when invoker throws', async () => {
    const failingInvoker: StageBInvoker = async () => {
      throw new Error('network timeout');
    };
    const result = await runStageB({
      taskTitle: 'test',
      taskDescription: '',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      invoker: failingInvoker,
    });
    expect(result.invoked).toBe(false);
    if (!result.invoked) {
      expect(result.skipReason).toMatch(/network timeout/);
    }
  });

  it('returns StageBSkipped when LLM returns unparseable response', async () => {
    const result = await runStageB({
      taskTitle: 'test',
      taskDescription: '',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      invoker: mockInvoker('Sorry, I cannot determine the bucket without more context.'),
    });
    expect(result.invoked).toBe(false);
    if (!result.invoked) {
      expect(result.skipReason).toMatch(/unparseable/i);
    }
  });

  it('result includes the full prompt that was sent (for audit)', async () => {
    const result = await runStageB({
      taskTitle: 'feat: audit trail',
      taskDescription: '',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      invoker: mockInvoker(goodResponse('M')),
    });
    expect(result.invoked).toBe(true);
    if (result.invoked) {
      expect(result.prompt).toContain('feat: audit trail');
      expect(result.prompt).toContain('DETERMINISTIC SIGNALS');
    }
  });
});

// ── AC #4 — estimateVariance per hash transition ────────────────────────────

describe('computeEnsembleVarianceForHash — AC #4', () => {
  function makeRecord(hash: string, finalBucket: Bucket): EstimateLogRecord {
    return {
      ts: '2026-05-01T00:00:00Z',
      predictedBy: 'stage-a-deterministic',
      taskId: 'AISDLC-999',
      class: 'feature',
      bucket: finalBucket,
      finalBucket,
      stageA: {
        signals: [],
        candidateBucket: finalBucket,
        confidence: 'high',
        escalateToStageB: false,
        rationale: 'test',
      },
      estimateInputHash: hash,
      runIndex: 1,
      classSource: 'heuristic',
      classCached: false,
    };
  }

  it('returns 0 for single-run estimate (no prior rows for this hash)', () => {
    const rows = [makeRecord('sha256:abc', 'M')];
    expect(computeEnsembleVarianceForHash(rows, 'sha256:abc')).toBe(0);
  });

  it('returns 0 for empty log', () => {
    expect(computeEnsembleVarianceForHash([], 'sha256:abc')).toBe(0);
  });

  it('returns 0 when all same-hash rows agree on bucket', () => {
    const rows = [
      makeRecord('sha256:abc', 'M'),
      makeRecord('sha256:abc', 'M'),
      makeRecord('sha256:abc', 'M'),
    ];
    expect(computeEnsembleVarianceForHash(rows, 'sha256:abc')).toBe(0);
  });

  it('returns 1 for adjacent-bucket spread', () => {
    // XS=0, S=1 → variance = 1
    const rows = [makeRecord('sha256:abc', 'XS'), makeRecord('sha256:abc', 'S')];
    expect(computeEnsembleVarianceForHash(rows, 'sha256:abc')).toBe(1);
  });

  it('returns 2 for non-adjacent spread (triggers Stage B re-escalation)', () => {
    // XS=0, M=2 → variance = 2
    const rows = [makeRecord('sha256:abc', 'XS'), makeRecord('sha256:abc', 'M')];
    expect(computeEnsembleVarianceForHash(rows, 'sha256:abc')).toBe(2);
  });

  it('returns 4 for XS-XL spread (maximum)', () => {
    // XS=0, XL=4 → variance = 4
    const rows = [makeRecord('sha256:abc', 'XS'), makeRecord('sha256:abc', 'XL')];
    expect(computeEnsembleVarianceForHash(rows, 'sha256:abc')).toBe(4);
  });

  it('ignores rows with a DIFFERENT hash', () => {
    // Different hash rows should not affect the variance computation for the target hash
    const rows = [
      makeRecord('sha256:abc', 'XS'),
      makeRecord('sha256:def', 'XL'), // different hash — should be ignored
    ];
    // Only one row for 'sha256:abc' → variance = 0
    expect(computeEnsembleVarianceForHash(rows, 'sha256:abc')).toBe(0);
  });

  it('correctly handles the §8.4 escalation threshold (variance ≥ 2)', () => {
    const twoRows = [makeRecord('sha256:abc', 'S'), makeRecord('sha256:abc', 'L')];
    const variance = computeEnsembleVarianceForHash(twoRows, 'sha256:abc');
    // S=1, L=3 → variance = 2 → should escalate to Stage B
    expect(variance).toBe(2);
    expect(
      shouldEscalateToStageB({
        stageA: { escalateToStageB: false },
        variance,
      }),
    ).toBe(true);
  });
});

// ── AC #5 — Q5 ensemble aggregation ───────────────────────────────────────

describe('aggregateStageBEnsemble — AC #5', () => {
  const verdict = (bucket: Bucket, bucketHigh?: Bucket): StageBVerdict => ({
    bucket,
    ...(bucketHigh !== undefined ? { bucketHigh } : {}),
    justification: 'test',
    promptHash: 'sha256:abc',
  });

  it('returns null for empty verdict set', () => {
    expect(aggregateStageBEnsemble([])).toBeNull();
  });

  it('returns the single verdict bucket for n=1', () => {
    const result = aggregateStageBEnsemble([verdict('M')]);
    expect(result).not.toBeNull();
    expect(result!.medianBucket).toBe('M');
    expect(result!.ensembleVariance).toBe(0);
    expect(result!.n).toBe(1);
  });

  it('computes median bucket across 3 single-bucket verdicts', () => {
    // S=1, M=2, L=3 → indices [1,2,3] → median = 2 = M
    const result = aggregateStageBEnsemble([verdict('S'), verdict('M'), verdict('L')]);
    expect(result).not.toBeNull();
    expect(result!.medianBucket).toBe('M');
    expect(result!.ensembleVariance).toBe(2); // max(3) - min(1) = 2
    expect(result!.n).toBe(3);
  });

  it('includes range endpoints in the index set', () => {
    // One verdict is S-M (indices 1,2), another is M (index 2)
    // Indices: [1, 2, 2] → median = 2 = M; variance = max(2) - min(1) = 1
    const result = aggregateStageBEnsemble([verdict('S', 'M'), verdict('M')]);
    expect(result).not.toBeNull();
    expect(result!.medianBucket).toBe('M');
    expect(result!.ensembleVariance).toBe(1);
  });

  it('Q5 ensemble reduces LLM noise by returning the median, not a single shot', () => {
    // One outlier verdict (XL) vs two agreeing on M
    // Indices: [2, 2, 4] → sorted [2,2,4] → median at floor(3/2)=1 → idx=2 → M
    const result = aggregateStageBEnsemble([verdict('M'), verdict('M'), verdict('XL')]);
    expect(result).not.toBeNull();
    // Median should be M (index 2), not XL (index 4)
    expect(result!.medianBucket).toBe('M');
  });

  it('handles all-same-bucket verdicts (variance = 0)', () => {
    const result = aggregateStageBEnsemble([verdict('S'), verdict('S'), verdict('S')]);
    expect(result).not.toBeNull();
    expect(result!.ensembleVariance).toBe(0);
    expect(result!.medianBucket).toBe('S');
  });
});

// ── AC #6 — Stage B call rate telemetry ────────────────────────────────────

describe('computeStageBCallRate — AC #6', () => {
  function makeLogRecord(stageBInvoked?: boolean): EstimateLogRecord {
    const base: EstimateLogRecord = {
      ts: '2026-05-01T00:00:00Z',
      predictedBy: 'stage-a-deterministic',
      taskId: 'AISDLC-100',
      class: 'feature',
      bucket: 'M',
      finalBucket: 'M',
      stageA: {
        signals: [],
        candidateBucket: 'M',
        confidence: 'high',
        escalateToStageB: false,
        rationale: 'test',
      },
      estimateInputHash: 'sha256:abc',
      runIndex: 1,
      classSource: 'heuristic',
      classCached: false,
    };
    if (stageBInvoked !== undefined) {
      base.stageB = { invoked: stageBInvoked };
    }
    return base;
  }

  it('returns null for empty log', () => {
    expect(computeStageBCallRate([])).toBeNull();
  });

  it('returns 0 when no Stage B records exist', () => {
    const records = [makeLogRecord(), makeLogRecord(), makeLogRecord()];
    expect(computeStageBCallRate(records)).toBe(0);
  });

  it('returns correct rate for mixed records', () => {
    // 1 Stage B call out of 4 total = 25%
    const records = [
      makeLogRecord(true), // Stage B invoked
      makeLogRecord(), // no stageB field
      makeLogRecord(false), // Stage B skipped
      makeLogRecord(), // no stageB field
    ];
    expect(computeStageBCallRate(records)).toBe(0.25);
  });

  it('returns 1.0 when all records have Stage B invoked', () => {
    const records = [makeLogRecord(true), makeLogRecord(true)];
    expect(computeStageBCallRate(records)).toBe(1.0);
  });

  it('30% threshold is the boundary per AC #6', () => {
    expect(STAGE_B_CALL_RATE_THRESHOLD).toBe(0.3);
  });

  it('identifies when Stage B call rate exceeds the 30% threshold', () => {
    // 4 out of 10 = 40% > 30% → should be flagged
    const records = [
      makeLogRecord(true),
      makeLogRecord(true),
      makeLogRecord(true),
      makeLogRecord(true),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
    ];
    const rate = computeStageBCallRate(records);
    expect(rate).not.toBeNull();
    expect(rate!).toBeGreaterThan(STAGE_B_CALL_RATE_THRESHOLD);
  });

  it('identifies when Stage B call rate is within the 30% threshold', () => {
    // 2 out of 10 = 20% < 30% → acceptable
    const records = [
      makeLogRecord(true),
      makeLogRecord(true),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
      makeLogRecord(),
    ];
    const rate = computeStageBCallRate(records);
    expect(rate).not.toBeNull();
    expect(rate!).toBeLessThanOrEqual(STAGE_B_CALL_RATE_THRESHOLD);
  });

  it('does not count Stage B skipped records toward the rate', () => {
    // stageB.invoked=false should NOT count as a Stage B call
    const records = [
      makeLogRecord(false), // skipped — not invoked
      makeLogRecord(), // no stageB — not invoked
      makeLogRecord(), // no stageB — not invoked
    ];
    expect(computeStageBCallRate(records)).toBe(0);
  });
});

// ── Integration: runStageB → captureEstimate wiring ──────────────────────

describe('Stage B integration with log-writer — AC #1 + #3', () => {
  it('StageBResult can be mapped to EstimateLogStageBRecord for log-writer', async () => {
    const stageBResult = await runStageB({
      taskTitle: 'integration test',
      taskDescription: '',
      stageAResult: makeLowConfidenceStageA(),
      variance: 0,
      invoker: mockInvoker(goodResponse('L', 'Strong feature-class signal pushes toward L.')),
    });

    expect(stageBResult.invoked).toBe(true);
    if (stageBResult.invoked) {
      // Map to log record shape
      const stageBLogRecord = {
        invoked: true as const,
        promptHash: stageBResult.verdict.promptHash,
        bucket: stageBResult.verdict.bucket,
        ...(stageBResult.verdict.bucketHigh !== undefined
          ? { bucketHigh: stageBResult.verdict.bucketHigh }
          : {}),
        justification: stageBResult.verdict.justification,
      };

      expect(stageBLogRecord.invoked).toBe(true);
      expect(stageBLogRecord.bucket).toBe('L');
      expect(stageBLogRecord.justification).toContain('feature-class signal');
      expect(stageBLogRecord.promptHash).toMatch(/^sha256:/);
    }
  });

  it('StageBSkipped maps to invoked:false log record', async () => {
    const stageBResult = await runStageB({
      taskTitle: 'no escalation test',
      taskDescription: '',
      stageAResult: makeHighConfidenceStageA(),
      variance: 0,
      // No invoker and high confidence → skipped
    });

    expect(stageBResult.invoked).toBe(false);
    if (!stageBResult.invoked) {
      const stageBLogRecord = {
        invoked: false as const,
        skipReason: stageBResult.skipReason,
      };
      expect(stageBLogRecord.invoked).toBe(false);
      expect(stageBLogRecord.skipReason).toBeTruthy();
    }
  });
});

// ── Import of BUCKET_INDEX for range normalization ─────────────────────────
// This re-exports the BUCKET_INDEX from types to support the test above.
import { BUCKET_INDEX } from './types.js';
