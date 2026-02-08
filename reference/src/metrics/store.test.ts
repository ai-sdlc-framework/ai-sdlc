import { describe, it, expect } from 'vitest';
import { createMetricStore } from './store.js';
import { STANDARD_METRICS } from './types.js';

describe('createMetricStore', () => {
  it('records and retrieves a data point', () => {
    const store = createMetricStore();
    const point = store.record({ metric: 'coverage', value: 85 });

    expect(point.metric).toBe('coverage');
    expect(point.value).toBe(85);
    expect(point.timestamp).toBeTruthy();
  });

  it('uses provided timestamp', () => {
    const store = createMetricStore();
    const point = store.record({
      metric: 'coverage',
      value: 90,
      timestamp: '2026-01-01T00:00:00Z',
    });
    expect(point.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('current() returns latest value', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80 });
    store.record({ metric: 'coverage', value: 90 });

    expect(store.current('coverage')).toBe(90);
  });

  it('current() returns undefined for unknown metric', () => {
    const store = createMetricStore();
    expect(store.current('unknown')).toBeUndefined();
  });

  it('current() filters by labels', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80, labels: { agent: 'alice' } });
    store.record({ metric: 'coverage', value: 95, labels: { agent: 'bob' } });

    expect(store.current('coverage', { agent: 'alice' })).toBe(80);
    expect(store.current('coverage', { agent: 'bob' })).toBe(95);
  });

  it('query() filters by time range', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80, timestamp: '2026-01-01T00:00:00Z' });
    store.record({ metric: 'coverage', value: 85, timestamp: '2026-06-01T00:00:00Z' });
    store.record({ metric: 'coverage', value: 90, timestamp: '2026-12-01T00:00:00Z' });

    const results = store.query({
      metric: 'coverage',
      from: '2026-03-01T00:00:00Z',
      to: '2026-09-01T00:00:00Z',
    });
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(85);
  });

  it('query() filters by labels', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80, labels: { agent: 'alice' } });
    store.record({ metric: 'coverage', value: 95, labels: { agent: 'bob' } });

    const results = store.query({ metric: 'coverage', labels: { agent: 'alice' } });
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(80);
  });

  it('query() returns empty for unknown metric', () => {
    const store = createMetricStore();
    expect(store.query({ metric: 'unknown' })).toHaveLength(0);
  });

  it('summarize() computes stats', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80 });
    store.record({ metric: 'coverage', value: 90 });
    store.record({ metric: 'coverage', value: 100 });

    const summary = store.summarize('coverage');
    expect(summary).toEqual({
      metric: 'coverage',
      count: 3,
      min: 80,
      max: 100,
      avg: 90,
      latest: 100,
    });
  });

  it('summarize() returns undefined for unknown metric', () => {
    const store = createMetricStore();
    expect(store.summarize('unknown')).toBeUndefined();
  });

  it('snapshot() returns latest value per metric', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80 });
    store.record({ metric: 'coverage', value: 95 });
    store.record({ metric: 'lint-pass-rate', value: 100 });

    const snap = store.snapshot();
    expect(snap).toEqual({ coverage: 95, 'lint-pass-rate': 100 });
  });

  it('snapshot() filters by labels', () => {
    const store = createMetricStore();
    store.record({ metric: 'coverage', value: 80, labels: { agent: 'alice' } });
    store.record({ metric: 'coverage', value: 95, labels: { agent: 'bob' } });

    const snap = store.snapshot({ agent: 'alice' });
    expect(snap).toEqual({ coverage: 80 });
  });

  it('register() and definitions() round-trip', () => {
    const store = createMetricStore();
    store.register(STANDARD_METRICS[0]);
    store.register(STANDARD_METRICS[1]);

    const defs = store.definitions();
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe('task-completion-rate');
  });
});
