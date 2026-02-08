import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReconcilerLoop } from './loop.js';
import type { ReconcilerFn } from './types.js';
import type { AnyResource } from '../core/types.js';
import { API_VERSION } from '../core/types.js';

function makeResource(name: string): AnyResource {
  return {
    apiVersion: API_VERSION,
    kind: 'Pipeline',
    metadata: { name },
    spec: { triggers: [], providers: {}, stages: [] },
  };
}

describe('ReconcilerLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues and deduplicates resources', () => {
    const reconciler: ReconcilerFn = vi.fn(async () => ({ type: 'success' as const }));
    const loop = new ReconcilerLoop(reconciler);
    const r = makeResource('r1');
    loop.enqueue(r);
    loop.enqueue(r);
    expect(loop.queueSize).toBe(1);
  });

  it('start and stop lifecycle', async () => {
    const reconciler: ReconcilerFn = vi.fn(async () => ({ type: 'success' as const }));
    const loop = new ReconcilerLoop(reconciler);
    loop.enqueue(makeResource('r1'));
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    expect(reconciler).toHaveBeenCalled();
  });

  it('success result removes from queue', async () => {
    const reconciler: ReconcilerFn = vi.fn(async () => ({ type: 'success' as const }));
    const loop = new ReconcilerLoop(reconciler);
    loop.enqueue(makeResource('r1'));
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.queueSize).toBe(0);
    expect(loop.activeCount).toBe(0);
    loop.stop();
  });

  it('error result requeues with backoff', async () => {
    let calls = 0;
    const reconciler: ReconcilerFn = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        return { type: 'error' as const, error: new Error('fail') };
      }
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler, { initialBackoffMs: 100, maxBackoffMs: 10000 });
    loop.enqueue(makeResource('r1'));
    loop.start();

    // First call: immediate
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // After backoff (~200ms for attempt 1 with jitter), process requeued item
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(2);

    // After next backoff (~400ms for attempt 2 with jitter)
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(3);

    loop.stop();
  });

  it('requeue result processes immediately', async () => {
    let calls = 0;
    const reconciler: ReconcilerFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return { type: 'requeue' as const };
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler);
    loop.enqueue(makeResource('r1'));
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    // Requeue should have triggered immediate re-process
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    loop.stop();
  });

  it('requeue-after delays correctly', async () => {
    let calls = 0;
    const reconciler: ReconcilerFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return { type: 'requeue-after' as const, delayMs: 500 };
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler);
    loop.enqueue(makeResource('r1'));
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toBe(2);
    loop.stop();
  });

  it('respects maxConcurrency', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const reconciler: ReconcilerFn = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrent--;
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler, { maxConcurrency: 2 });
    loop.enqueue(makeResource('r1'));
    loop.enqueue(makeResource('r2'));
    loop.enqueue(makeResource('r3'));
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    // Only 2 should be active
    expect(loop.activeCount).toBeLessThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(200);
    loop.stop();
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('periodic reconciliation re-enqueues known resources', async () => {
    let calls = 0;
    const reconciler: ReconcilerFn = vi.fn(async () => {
      calls++;
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler, { periodicIntervalMs: 1000 });
    loop.enqueue(makeResource('r1'));
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // After periodic interval, should re-reconcile
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toBeGreaterThanOrEqual(2);
    loop.stop();
  });

  it('stop prevents further processing', async () => {
    let calls = 0;
    const reconciler: ReconcilerFn = vi.fn(async () => {
      calls++;
      return { type: 'requeue-after' as const, delayMs: 100 };
    });

    const loop = new ReconcilerLoop(reconciler);
    loop.enqueue(makeResource('r1'));
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    loop.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);
  });

  it('enqueue during active reconciliation is filtered', async () => {
    let resolveFirst: () => void;
    const firstCall = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const reconciler: ReconcilerFn = vi.fn(async () => {
      await firstCall;
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler);
    const r = makeResource('r1');
    loop.enqueue(r);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    // r1 is now active, enqueue should be no-op
    loop.enqueue(r);
    expect(loop.queueSize).toBe(0);

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
  });

  it('backoff resets on success after errors', async () => {
    let calls = 0;
    const reconciler: ReconcilerFn = vi.fn(async () => {
      calls++;
      if (calls === 1) return { type: 'error' as const, error: new Error('fail') };
      return { type: 'success' as const };
    });

    const loop = new ReconcilerLoop(reconciler, {
      initialBackoffMs: 100,
      maxBackoffMs: 10000,
      periodicIntervalMs: 5000,
    });
    loop.enqueue(makeResource('r1'));
    loop.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // After backoff, should succeed
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(2);

    // After periodic interval, re-enqueue starts fresh (attempt 0)
    await vi.advanceTimersByTimeAsync(5100);
    expect(calls).toBeGreaterThanOrEqual(3);

    loop.stop();
  });
});
