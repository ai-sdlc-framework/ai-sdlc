import { describe, expect, it } from 'vitest';
import { alreadyReverted, evaluateReverts, type RevertCandidate } from './revert.js';

const base: RevertCandidate = {
  role: 'developer',
  taskClass: '*',
  model: 'sonnet',
  previousModel: 'opus',
  evidenceRate: 0.8,
  observed: { tasks: 30, approved: 22 }, // 73.3%: 6.7 points below
};

describe('evaluateReverts', () => {
  it('reverts when over minTasks tasks the rate is more than the margin below the evidence', () => {
    const [r] = evaluateReverts([base], []);
    expect(r?.revert).toBe(true);
    expect(r?.pointsBelow).toBeCloseTo(6.67, 1);
    expect(r?.observedRate).toBeCloseTo(22 / 30);
  });

  it('does not revert with 29 tasks', () => {
    const [r] = evaluateReverts([{ ...base, observed: { tasks: 29, approved: 10 } }], []);
    expect(r).toMatchObject({ revert: false, reason: '29 tasks since the change, 30 needed' });
  });

  it('does not revert at exactly 5 points below', () => {
    const [r] = evaluateReverts(
      [{ ...base, evidenceRate: 0.8, observed: { tasks: 40, approved: 30 } }],
      [],
    );
    expect(r?.revert).toBe(false);
    expect(r?.reason).toContain('more than 5 needed');
  });

  it('does not revert when the rate is at or above the evidence', () => {
    const [r] = evaluateReverts([{ ...base, observed: { tasks: 30, approved: 30 } }], []);
    expect(r?.revert).toBe(false);
    expect(r?.pointsBelow).toBeLessThan(0);
  });

  it('honours custom thresholds and ignores invalid ones', () => {
    const c = { ...base, observed: { tasks: 10, approved: 5 } };
    expect(evaluateReverts([c], [], { minTasks: 10, marginPoints: 20 })[0]?.revert).toBe(true);
    expect(evaluateReverts([c], [], { minTasks: 10, marginPoints: 40 })[0]?.revert).toBe(false);
    // NaN / negative fall back to the documented 30 tasks and 5 points.
    expect(evaluateReverts([c], [], { minTasks: Number.NaN })[0]?.revert).toBe(false);
    expect(evaluateReverts([base], [], { marginPoints: -1 })[0]?.revert).toBe(true);
  });

  it('skips a cell an override already covers', () => {
    const entries = [{ role: 'developer', taskClass: '*', model: 'opus', tableModel: 'sonnet' }];
    expect(alreadyReverted(entries, base)).toBe(true);
    expect(evaluateReverts([base], entries)[0]).toMatchObject({
      revert: false,
      reason: 'an override already covers this cell',
    });
    // An override recorded for a different table model does not count.
    expect(alreadyReverted([{ ...entries[0], tableModel: 'haiku' }, null, 'junk'], base)).toBe(
      false,
    );
  });

  it('fails closed on malformed counts and rates', () => {
    for (const observed of [
      { tasks: 30, approved: 31 },
      { tasks: 30.5, approved: 1 },
      { tasks: -1, approved: 0 },
      { tasks: Number.NaN, approved: 0 },
    ]) {
      expect(evaluateReverts([{ ...base, observed }], [])[0]).toMatchObject({
        revert: false,
        reason: 'observed counts are malformed',
      });
    }
    for (const evidenceRate of [1.5, -0.1, Number.NaN]) {
      expect(evaluateReverts([{ ...base, evidenceRate }], [])[0]).toMatchObject({
        revert: false,
        reason: 'evidence rate is malformed',
      });
    }
  });
});
