/**
 * Aggregator tests — RFC-0016 Phase 1 (AISDLC-279).
 *
 * Covers AC #3 (class-default fallback fires when historical-actuals
 * returns unknown) and the §5.2 decision rules:
 *  - all resolved signals agree → high confidence, single bucket
 *  - signals split across adjacent buckets → medium, range
 *  - signals split across non-adjacent buckets → low, escalate
 *  - bump signals shift the converged bucket
 *  - Q8 ordering rule: cheap-specific signals override class-default
 *
 * The aggregator is a pure function over `SignalOutput[]`, so the
 * tests synthesize the signal shape directly without going through
 * disk or the §5 collectors.
 */

import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregator.js';
import type { Bucket, SignalId, SignalOutput, SignalResult } from './types.js';

function sig(id: SignalId, name: string, result: SignalResult): SignalOutput {
  return { id, name, inputs: {}, result };
}

// Shorthand factories
const bucket = (id: SignalId, b: Bucket): SignalOutput =>
  sig(id, `sig-${id}`, { kind: 'bucket', bucket: b });
const range = (id: SignalId, low: Bucket, high: Bucket): SignalOutput =>
  sig(id, `sig-${id}`, { kind: 'range', low, high });
const bump = (id: SignalId, delta: number): SignalOutput =>
  sig(id, `sig-${id}`, { kind: 'bump', delta });
const unknown = (id: SignalId, reason = 'no data'): SignalOutput =>
  sig(id, `sig-${id}`, { kind: 'unknown', reason });

describe('aggregate — unanimous (high confidence)', () => {
  it('emits high confidence + single bucket when all bucket-emitting signals agree', () => {
    const out = aggregate([bucket(1, 'S'), bucket(3, 'S'), bump(4, 0), bump(5, 0), bump(6, 0)]);
    expect(out.candidateBucket).toBe('S');
    expect(out.candidateRange).toBeUndefined();
    expect(out.confidence).toBe('high');
    expect(out.escalateToStageB).toBe(false);
  });

  it('treats a 0-width range as a single-bucket vote (e.g. XS-XS would collapse)', () => {
    const out = aggregate([range(1, 'M', 'M'), bucket(7, 'M' as Bucket)]);
    expect(out.candidateBucket).toBe('M');
    expect(out.confidence).toBe('high');
  });
});

describe('aggregate — adjacent split (medium confidence)', () => {
  it('emits medium + range when two signals straddle adjacent buckets', () => {
    const out = aggregate([bucket(1, 'S'), bucket(3, 'M')]);
    expect(out.candidateBucket).toBe('S');
    expect(out.candidateRange).toEqual({ low: 'S', high: 'M' });
    expect(out.confidence).toBe('medium');
    expect(out.escalateToStageB).toBe(false);
  });

  it('emits medium when a range signal abuts a single-bucket signal', () => {
    // file-type emits range XS-S, file-scope emits S — combined range is XS-S.
    const out = aggregate([range(7, 'XS', 'S'), bucket(1, 'S')]);
    expect(out.candidateRange).toEqual({ low: 'XS', high: 'S' });
    expect(out.confidence).toBe('medium');
  });
});

describe('aggregate — non-adjacent split (low + escalate)', () => {
  it('emits low confidence + escalate when signals split across non-adjacent buckets', () => {
    const out = aggregate([bucket(1, 'S'), bucket(3, 'L')]);
    expect(out.candidateRange).toEqual({ low: 'S', high: 'L' });
    expect(out.confidence).toBe('low');
    expect(out.escalateToStageB).toBe(true);
  });

  it('emits low + escalate when 3 distinct buckets vote', () => {
    const out = aggregate([bucket(1, 'XS'), bucket(3, 'M'), bucket(7, 'XL')]);
    expect(out.confidence).toBe('low');
    expect(out.escalateToStageB).toBe(true);
  });
});

describe('aggregate — bumps shift the converged bucket', () => {
  it('+1 bump pushes a unanimous S to M', () => {
    const out = aggregate([bucket(1, 'S'), bucket(3, 'S'), bump(6, 1)]);
    expect(out.candidateBucket).toBe('M');
    expect(out.confidence).toBe('high');
  });

  it('multiple bumps accumulate', () => {
    const out = aggregate([bucket(1, 'S'), bucket(3, 'S'), bump(4, 1), bump(6, 1)]);
    expect(out.candidateBucket).toBe('L');
  });

  it('clamps at XL on the high end', () => {
    const out = aggregate([bucket(1, 'L'), bucket(3, 'L'), bump(4, 1), bump(6, 1), bump(5, 1)]);
    expect(out.candidateBucket).toBe('XL');
  });

  it('clamps at XS on the low end (defensive — bumps are typically positive)', () => {
    const out = aggregate([bucket(1, 'XS'), bucket(3, 'XS'), bump(7, -2)]);
    expect(out.candidateBucket).toBe('XS');
  });

  it('shifts the range endpoints together when a split is bumped', () => {
    const out = aggregate([bucket(1, 'S'), bucket(3, 'M'), bump(6, 1)]);
    expect(out.candidateRange).toEqual({ low: 'M', high: 'L' });
    expect(out.confidence).toBe('medium');
  });

  it('ignores 0-delta bumps for the rationale', () => {
    const out = aggregate([bucket(1, 'S'), bump(4, 0), bump(5, 0), bump(6, 0)]);
    expect(out.candidateBucket).toBe('S');
    expect(out.rationale).not.toMatch(/applied bumps/);
  });
});

describe('aggregate — Q8 fallback ordering', () => {
  it('uses signal #9 (class-default) when no cheap signal resolved (AC #3)', () => {
    // Phase 1 typical: signal #2 unknown, signal #8 unknown, signals #1/#3/#7
    // also unknown (e.g. task with 0 references and no LOC). Only signal
    // #9 (class-default, bucket S for `bug`) resolves.
    const out = aggregate([
      unknown(1, 'no refs'),
      unknown(2, 'no calibration'),
      unknown(3, 'no LOC'),
      bump(4, 0),
      bump(5, 0),
      bump(6, 0),
      unknown(7, 'no refs'),
      unknown(8, 'no events'),
      bucket(9, 'S'),
    ]);
    expect(out.candidateBucket).toBe('S');
    // Downgraded to medium because we relied on the fallback
    // (cold-start signal — Phase 5 surface will tag this `warming`).
    expect(out.confidence).toBe('medium');
    expect(out.rationale).toMatch(/class-default fallback/);
  });

  it('cheap-specific signal OVERRIDES the class-default when they disagree (Q8 ordering)', () => {
    // Worked example AISDLC-123 (§5.3): file-scope says XS, class-default
    // (bug → S) says S. Cheap signal wins per Q8 — bucket = XS, NOT S.
    const out = aggregate([
      range(1, 'XS', 'S'), // file-scope (cheap, range XS-S)
      unknown(2),
      bump(4, 0),
      bump(5, 0),
      bump(6, 0),
      range(7, 'XS', 'S'), // file-type (cheap, range XS-S)
      unknown(8),
      bucket(9, 'S'), // class-default (would push to S alone)
    ]);
    // With only cheap signals (XS-S range twice), the result is XS-S
    // medium confidence — NOT S high (which is what #9 alone would say).
    expect(out.candidateRange).toEqual({ low: 'XS', high: 'S' });
    expect(out.confidence).toBe('medium');
  });

  it('rationale mentions class-default fallback only when it was actually used', () => {
    const fallbackUsed = aggregate([
      unknown(1),
      unknown(2),
      unknown(3),
      bump(4, 0),
      bump(5, 0),
      bump(6, 0),
      unknown(7),
      unknown(8),
      bucket(9, 'M'),
    ]);
    expect(fallbackUsed.rationale).toMatch(/class-default fallback/);

    const cheapWins = aggregate([
      bucket(1, 'S'),
      bump(4, 0),
      bump(5, 0),
      bump(6, 0),
      bucket(9, 'M'),
    ]);
    expect(cheapWins.rationale).not.toMatch(/class-default fallback/);
  });
});

describe('aggregate — edge cases', () => {
  it('returns a defensive M/low/escalate verdict when no signal resolved at all', () => {
    // Should not happen in Phase 1 (signal #9 always votes) but
    // defensive: function stays total.
    const out = aggregate([unknown(1), unknown(2), unknown(3), unknown(7), unknown(8)]);
    expect(out.candidateBucket).toBe('M');
    expect(out.confidence).toBe('low');
    expect(out.escalateToStageB).toBe(true);
  });

  it('handles an empty signal array (cold-start with no collectors)', () => {
    const out = aggregate([]);
    expect(out.confidence).toBe('low');
    expect(out.escalateToStageB).toBe(true);
  });
});
