import { describe, it, expect, vi } from 'vitest';
import { createHttpMetricsCollector, createStubMetricsCollector } from './metrics-collector.js';
import type { FetchFn } from './types.js';

function mockFetch(status: number, delayMs = 0): FetchFn {
  return vi.fn(async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return { ok: status >= 200 && status < 300, status } as unknown as Response;
  });
}

describe('HttpMetricsCollector', () => {
  it('collects metrics from health endpoint', async () => {
    const fetch = mockFetch(200);
    const collector = createHttpMetricsCollector(
      { healthUrl: 'http://localhost:3000/health', sampleCount: 3 },
      { fetch },
    );

    const metrics = await collector.collect('test-deploy');

    expect(metrics.errorRate).toBe(0);
    expect(metrics.latencyP95Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.healthyInstances).toBe(1);
    expect(metrics.totalInstances).toBe(1);
    expect(metrics.collectedAt).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports errors for non-200 responses', async () => {
    const fetch = mockFetch(500);
    const collector = createHttpMetricsCollector(
      { healthUrl: 'http://localhost:3000/health', sampleCount: 4 },
      { fetch },
    );

    const metrics = await collector.collect('test-deploy');

    expect(metrics.errorRate).toBe(1);
    expect(metrics.healthyInstances).toBe(0);
  });

  it('handles custom expected status', async () => {
    const fetch = mockFetch(204);
    const collector = createHttpMetricsCollector(
      { healthUrl: 'http://localhost/health', expectedStatus: 204, sampleCount: 2 },
      { fetch },
    );

    const metrics = await collector.collect('test');

    expect(metrics.errorRate).toBe(0);
  });

  it('reports errors on fetch failure', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Connection refused');
    }) as unknown as FetchFn;
    const collector = createHttpMetricsCollector(
      { healthUrl: 'http://unreachable/health', sampleCount: 2 },
      { fetch },
    );

    const metrics = await collector.collect('test');

    expect(metrics.errorRate).toBe(1);
    expect(metrics.healthyInstances).toBe(0);
  });

  it('calculates P95 latency from samples', async () => {
    let callCount = 0;
    const fetch = vi.fn(async () => {
      callCount++;
      // Simulate varying latencies
      if (callCount === 5) await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as FetchFn;

    const collector = createHttpMetricsCollector(
      { healthUrl: 'http://localhost/health', sampleCount: 5 },
      { fetch },
    );

    const metrics = await collector.collect('test');

    expect(metrics.latencyP95Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.requestsPerSecond).toBe(5);
  });
});

describe('StubMetricsCollector', () => {
  it('returns default metrics', async () => {
    const collector = createStubMetricsCollector();

    const metrics = await collector.collect('test');

    expect(metrics.errorRate).toBe(0);
    expect(metrics.latencyP95Ms).toBe(50);
    expect(metrics.requestsPerSecond).toBe(100);
    expect(metrics.healthyInstances).toBe(3);
    expect(metrics.totalInstances).toBe(3);
  });

  it('accepts custom defaults', async () => {
    const collector = createStubMetricsCollector({ errorRate: 0.1, latencyP95Ms: 200 });

    const metrics = await collector.collect('test');

    expect(metrics.errorRate).toBe(0.1);
    expect(metrics.latencyP95Ms).toBe(200);
  });

  it('allows updating metrics dynamically', async () => {
    const collector = createStubMetricsCollector();

    collector.setMetrics({ errorRate: 0.5 });
    const metrics = await collector.collect('test');

    expect(metrics.errorRate).toBe(0.5);
    expect(metrics.latencyP95Ms).toBe(50); // unchanged
  });

  it('returns fresh timestamp on each collect', async () => {
    const collector = createStubMetricsCollector();

    const m1 = await collector.collect('test');
    await new Promise((r) => setTimeout(r, 10));
    const m2 = await collector.collect('test');

    expect(m1.collectedAt).not.toBe(m2.collectedAt);
  });
});
