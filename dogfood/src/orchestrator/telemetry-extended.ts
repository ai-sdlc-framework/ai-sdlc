/**
 * Extended telemetry integration — covers remaining OTel primitives,
 * no-op logger, synchronous spans, and core utilities not yet integrated.
 */

import {
  getTracer,
  getMeter,
  withSpan,
  withSpanSync,
  createNoOpLogger,
  createConsoleLogger,
  createBufferLogger,
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  AI_SDLC_PREFIX,
  // Core utilities
  validate,
  compareMetric,
  exceedsSeverity,
  type StructuredLogger,
  type BufferLogger,
  type LogEntry,
  type LogLevel,
} from '@ai-sdlc/reference';

/**
 * Create a no-op logger (useful for suppressing output in tests).
 */
export function createSilentLogger(): StructuredLogger {
  return createNoOpLogger();
}

/**
 * Execute a function within a named span synchronously.
 */
export function withPipelineSpanSync<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => T,
): T {
  return withSpanSync(name, attrs, fn);
}

/**
 * Get the OpenTelemetry tracer for custom spans.
 */
export function getPipelineTracer() {
  return getTracer();
}

/**
 * Validate a resource against its JSON Schema.
 */
export { validate as validateResourceSchema } from '@ai-sdlc/reference';

export {
  getTracer,
  getMeter,
  withSpan,
  withSpanSync,
  createNoOpLogger,
  createConsoleLogger,
  createBufferLogger,
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  AI_SDLC_PREFIX,
  validate,
  compareMetric,
  exceedsSeverity,
};

export type { StructuredLogger, BufferLogger, LogEntry, LogLevel };
