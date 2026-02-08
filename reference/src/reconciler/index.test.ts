import { describe, it, expect } from 'vitest';
import { calculateBackoff, reconcileOnce } from './index.js';
import type { ReconcileResult, ReconcilerConfig } from './types.js';
import type { Pipeline } from '../core/types.js';
import { API_VERSION } from '../core/types.js';

const dummyResource: Pipeline = {
  apiVersion: API_VERSION,
  kind: 'Pipeline',
  metadata: { name: 'test' },
  spec: {
    triggers: [{ event: 'push' }],
    providers: { git: { type: 'github' } },
    stages: [{ name: 'build' }],
  },
};

describe('calculateBackoff()', () => {
  it('returns approximately 1000ms for attempt 0', () => {
    const result = calculateBackoff(0);
    // 1000 base + up to 10% jitter = 1000..1100
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(1100);
  });

  it('doubles per attempt', () => {
    // attempt 1 → 2000 + jitter, attempt 2 → 4000 + jitter
    const a1 = calculateBackoff(1);
    expect(a1).toBeGreaterThanOrEqual(2000);
    expect(a1).toBeLessThanOrEqual(2200);

    const a2 = calculateBackoff(2);
    expect(a2).toBeGreaterThanOrEqual(4000);
    expect(a2).toBeLessThanOrEqual(4400);
  });

  it('caps at maxBackoffMs', () => {
    const result = calculateBackoff(100); // Way past the cap
    // Default maxBackoffMs is 300_000
    expect(result).toBeLessThanOrEqual(330_000); // 300k + 10% jitter
  });

  it('respects custom config', () => {
    const config: ReconcilerConfig = {
      periodicIntervalMs: 10_000,
      maxBackoffMs: 5_000,
      initialBackoffMs: 500,
      maxConcurrency: 5,
    };
    const result = calculateBackoff(0, config);
    expect(result).toBeGreaterThanOrEqual(500);
    expect(result).toBeLessThanOrEqual(550);
  });

  it('always returns an integer', () => {
    for (let i = 0; i < 10; i++) {
      expect(Number.isInteger(calculateBackoff(i))).toBe(true);
    }
  });
});

describe('reconcileOnce()', () => {
  it('passes through success result', async () => {
    const result = await reconcileOnce(dummyResource, async () => ({ type: 'success' }));
    expect(result.type).toBe('success');
  });

  it('wraps Error instances', async () => {
    const result = await reconcileOnce(dummyResource, async () => {
      throw new Error('boom');
    });
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.error.message).toBe('boom');
    }
  });

  it('wraps non-Error thrown values', async () => {
    const result = await reconcileOnce(dummyResource, async () => {
      throw 'string-error';
    });
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.error.message).toBe('string-error');
    }
  });

  it('passes through requeue result', async () => {
    const result = await reconcileOnce(dummyResource, async () => ({ type: 'requeue' }));
    expect(result.type).toBe('requeue');
  });

  it('passes through requeue-after result', async () => {
    const expected: ReconcileResult = { type: 'requeue-after', delayMs: 5000 };
    const result = await reconcileOnce(dummyResource, async () => expected);
    expect(result).toEqual(expected);
  });
});
