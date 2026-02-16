/**
 * Metrics instrumentation wrappers for the dogfood pipeline.
 * Wraps enforcement and autonomy evaluation with metric recording.
 */

import {
  createMetricStore,
  instrumentEnforcement,
  instrumentAutonomy,
  instrumentExecutor,
  executeOrchestration,
  STANDARD_METRICS,
  enforce,
  type MetricStore,
  type MetricCategory,
  type MetricDefinition,
  type MetricDataPoint,
  type MetricQuery,
  type MetricSummary,
  type InstrumentationConfig,
} from '@ai-sdlc/reference';

/**
 * Create a metric store pre-loaded with standard metric definitions.
 */
export function createPipelineMetricStore(): MetricStore {
  return createMetricStore();
}

/**
 * Create an instrumented enforcement function that records per-gate metrics.
 */
export function createInstrumentedEnforcement(metricStore: MetricStore) {
  const config: InstrumentationConfig = { metricStore };
  return instrumentEnforcement(enforce, config);
}

/**
 * Create instrumented autonomy callbacks for promotion/demotion metrics.
 */
export function createInstrumentedAutonomy(metricStore: MetricStore) {
  const config: InstrumentationConfig = { metricStore };
  return instrumentAutonomy(config);
}

/**
 * Create an instrumented executor that records task execution metrics.
 */
export function createInstrumentedExecutor(metricStore: MetricStore) {
  const config: InstrumentationConfig = { metricStore };
  return instrumentExecutor(executeOrchestration, config);
}

export { STANDARD_METRICS, createMetricStore, instrumentExecutor };
export type {
  MetricStore,
  MetricCategory,
  MetricDefinition,
  MetricDataPoint,
  MetricQuery,
  MetricSummary,
};
