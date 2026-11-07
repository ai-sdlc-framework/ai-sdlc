import { describe, it, expect } from 'vitest';
import { findCycles, topologicalLayers, topologicalOrder } from './dependency-graph.js';

const deps = (m: Record<string, string[]>) => (k: string) => m[k] ?? [];

describe('generic DAG engine (AISDLC-1212)', () => {
  it('orders dependencies first and layers by readiness', () => {
    const m = { a: ['b', 'ghost'], b: ['c'], c: [], d: [] };
    const keys = Object.keys(m);
    expect(topologicalOrder(keys, deps(m))).toEqual(['c', 'b', 'a', 'd']);
    expect(topologicalLayers(keys, deps(m))).toEqual([['c', 'd'], ['b'], ['a']]);
  });

  it('reports cycles with their path and throws from order and layers', () => {
    const m = { a: ['b'], b: ['a'], s: ['s'] };
    const keys = Object.keys(m);
    expect(findCycles(keys, deps(m))).toEqual([
      ['a', 'b', 'a'],
      ['s', 's'],
    ]);
    expect(() => topologicalOrder(keys, deps(m))).toThrow(/a -> b -> a/);
    expect(() => topologicalLayers(keys, deps(m))).toThrow(/cycle/i);
  });
});
