/**
 * Metrics collection implementations for rollout monitoring.
 */

import type { RolloutMetrics, MetricsSource } from './rollout-types.js';
import type { FetchFn } from './types.js';

// ── HTTP Health Check Metrics Collector ─────────────────────────────

export interface HttpMetricsConfig {
  /** URL to check for health/metrics. */
  healthUrl: string;
  /** Expected HTTP status code (defaults to 200). */
  expectedStatus?: number;
  /** Request timeout in ms (defaults to 5000). */
  timeoutMs?: number;
  /** Number of sample requests for latency calculation. */
  sampleCount?: number;
}

/**
 * Collects metrics by probing an HTTP health endpoint.
 * Measures latency, error rate based on HTTP status, and reports
 * basic availability metrics.
 */
export function createHttpMetricsCollector(
  config: HttpMetricsConfig,
  opts?: { fetch?: FetchFn },
): MetricsSource {
  const httpFetch = opts?.fetch ?? globalThis.fetch;
  const expectedStatus = config.expectedStatus ?? 200;
  const timeoutMs = config.timeoutMs ?? 5000;
  const sampleCount = config.sampleCount ?? 5;

  return {
    async collect(_deploymentId: string): Promise<RolloutMetrics> {
      const latencies: number[] = [];
      let errors = 0;

      for (let i = 0; i < sampleCount; i++) {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const res = await httpFetch(config.healthUrl, { signal: controller.signal });
          clearTimeout(timer);
          const elapsed = Date.now() - start;
          latencies.push(elapsed);
          if (res.status !== expectedStatus) errors++;
        } catch {
          errors++;
          latencies.push(timeoutMs);
        }
      }

      // Sort latencies for P95
      latencies.sort((a, b) => a - b);
      const p95Index = Math.min(Math.ceil(latencies.length * 0.95) - 1, latencies.length - 1);
      const p95 = latencies[p95Index] ?? 0;

      const successCount = sampleCount - errors;
      return {
        errorRate: errors / sampleCount,
        latencyP95Ms: p95,
        requestsPerSecond: successCount, // approximation from sample
        healthyInstances: successCount > 0 ? 1 : 0,
        totalInstances: 1,
        collectedAt: new Date().toISOString(),
      };
    },
  };
}

// ── Stub Metrics Collector (for testing) ────────────────────────────

/**
 * Creates a metrics source that returns configurable static metrics.
 * Useful for testing rollout controllers without real infrastructure.
 */
export function createStubMetricsCollector(
  defaults?: Partial<RolloutMetrics>,
): MetricsSource & { setMetrics(m: Partial<RolloutMetrics>): void } {
  let current: RolloutMetrics = {
    errorRate: 0,
    latencyP95Ms: 50,
    requestsPerSecond: 100,
    healthyInstances: 3,
    totalInstances: 3,
    collectedAt: new Date().toISOString(),
    ...defaults,
  };

  return {
    async collect(_deploymentId: string): Promise<RolloutMetrics> {
      return { ...current, collectedAt: new Date().toISOString() };
    },
    setMetrics(m: Partial<RolloutMetrics>) {
      current = { ...current, ...m };
    },
  };
}
