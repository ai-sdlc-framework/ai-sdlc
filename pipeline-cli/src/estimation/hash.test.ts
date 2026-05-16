/**
 * Tests for `computeEstimateInputHash` — RFC-0016 §8.4.
 *
 * Determinism + canonicalisation are the contract; if these tests ever
 * fail it's because the hash output changed silently, which would
 * invalidate every historical `_estimates/log.jsonl` row.
 */

import { describe, expect, it } from 'vitest';
import { computeEstimateInputHash, sortedJsonStringify } from './hash.js';
import type { SignalOutput } from './types.js';

const baseSignals: SignalOutput[] = [
  {
    id: 1,
    name: 'file scope count',
    inputs: { fileCount: 1 },
    result: { kind: 'range', low: 'XS', high: 'S' },
  },
  {
    id: 9,
    name: 'class-default fallback',
    inputs: { taskClass: 'bug', seedBucket: 'S' },
    result: { kind: 'bucket', bucket: 'S' },
  },
];

describe('computeEstimateInputHash — determinism', () => {
  it('returns a sha256:<hex> string of fixed length', () => {
    const hash = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces the same hash for the same inputs (run twice)', () => {
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    expect(a).toBe(b);
  });

  it('produces the same hash regardless of signal array order', () => {
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: [...baseSignals].reverse(),
      taskClass: 'bug',
    });
    expect(a).toBe(b);
  });

  it('produces the same hash regardless of input-object key order', () => {
    const reordered: SignalOutput[] = [
      {
        id: 1,
        name: 'file scope count',
        // Same keys, different declaration order — must hash identically.
        inputs: Object.fromEntries(Object.entries({ fileCount: 1 }).reverse()) as Record<
          string,
          unknown
        >,
        result: { kind: 'range', low: 'XS', high: 'S' },
      },
      {
        id: 9,
        name: 'class-default fallback',
        inputs: { seedBucket: 'S', taskClass: 'bug' },
        result: { kind: 'bucket', bucket: 'S' },
      },
    ];
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: reordered,
      taskClass: 'bug',
    });
    expect(a).toBe(b);
  });

  it('ignores the human-readable `name` field on signals', () => {
    const renamed: SignalOutput[] = baseSignals.map((s) =>
      s.id === 1 ? { ...s, name: 'totally different label' } : s,
    );
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: renamed,
      taskClass: 'bug',
    });
    expect(a).toBe(b);
  });
});

describe('computeEstimateInputHash — sensitivity', () => {
  it('changes when the task title changes', () => {
    const a = computeEstimateInputHash({
      taskTitle: 'title 1',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 'title 2',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    expect(a).not.toBe(b);
  });

  it('changes when the task description changes', () => {
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'desc 1',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'desc 2',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    expect(a).not.toBe(b);
  });

  it('changes when the task class flips', () => {
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'feature',
    });
    expect(a).not.toBe(b);
  });

  it('changes when a signal `inputs` value materially differs', () => {
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const mutated: SignalOutput[] = baseSignals.map((s) =>
      s.id === 1 ? { ...s, inputs: { fileCount: 7 } } : s,
    );
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: mutated,
      taskClass: 'bug',
    });
    expect(a).not.toBe(b);
  });

  it('changes when a signal `result` differs (bucket vs range)', () => {
    const a = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: baseSignals,
      taskClass: 'bug',
    });
    const mutated: SignalOutput[] = baseSignals.map((s) =>
      s.id === 1 ? { ...s, result: { kind: 'bucket', bucket: 'XS' } } : s,
    );
    const b = computeEstimateInputHash({
      taskTitle: 't',
      taskDescription: 'd',
      stageASignals: mutated,
      taskClass: 'bug',
    });
    expect(a).not.toBe(b);
  });
});

describe('sortedJsonStringify — canonical form', () => {
  it('emits keys in lexicographic order at every depth', () => {
    expect(sortedJsonStringify({ b: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"b":1}');
  });

  it('preserves array element order (arrays are semantic)', () => {
    expect(sortedJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null and primitive scalars', () => {
    expect(sortedJsonStringify(null)).toBe('null');
    expect(sortedJsonStringify(7)).toBe('7');
    expect(sortedJsonStringify('s')).toBe('"s"');
  });
});
