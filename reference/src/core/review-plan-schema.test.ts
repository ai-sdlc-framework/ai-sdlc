import { describe, expect, it } from 'vitest';
import { validateReviewPlan } from './validation.js';

const probe = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  type: 'read',
  target: { files: [{ path: 'src/a.ts', startLine: 1, endLine: 5 }] },
  question: 'q',
  covers: ['h1'],
  ...over,
});
const plan = (probes: unknown[]) => ({ schemaVersion: 1, baselineVersion: '1', probes });

describe('ReviewPlan schema', () => {
  it('accepts a plan with every probe type', () => {
    const probes = [
      probe(),
      probe({ id: 'p2', type: 'trace', target: { symbols: ['foo'] } }),
      probe({ id: 'p3', type: 'run', target: { command: 'pnpm test' } }),
      probe({ id: 'p4', type: 'compare', target: { revisions: { base: 'main', head: 'HEAD' } } }),
      probe({ id: 'p5', type: 'search', target: { query: 'x' }, baseline: true }),
    ];
    expect(validateReviewPlan(plan(probes)).valid).toBe(true);
  });

  it('rejects an unknown probe type, extra fields and a bad id', () => {
    expect(validateReviewPlan(plan([probe({ type: 'exec' })])).valid).toBe(false);
    expect(validateReviewPlan(plan([probe({ extra: 1 })])).valid).toBe(false);
    expect(validateReviewPlan(plan([probe({ id: 'Bad Id' })])).valid).toBe(false);
  });

  it('enforces the target each type needs', () => {
    expect(validateReviewPlan(plan([probe({ type: 'run', target: { files: [] } })])).valid).toBe(
      false,
    );
    expect(
      validateReviewPlan(plan([probe({ type: 'read', target: { command: 'pnpm test' } })])).valid,
    ).toBe(false);
    expect(validateReviewPlan(plan([probe({ type: 'search', target: {} })])).valid).toBe(false);
    expect(validateReviewPlan(plan([probe({ type: 'trace', target: {} })])).valid).toBe(false);
    expect(validateReviewPlan(plan([probe({ type: 'compare', target: {} })])).valid).toBe(false);
  });

  it('rejects revisions with option or range syntax', () => {
    const rev = (base: string) =>
      probe({ type: 'compare', target: { revisions: { base, head: 'HEAD' } } });
    expect(validateReviewPlan(plan([rev('--output=x')])).valid).toBe(false);
    expect(validateReviewPlan(plan([rev('a..b')])).valid).toBe(false);
  });
});
