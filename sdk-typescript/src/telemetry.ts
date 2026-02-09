/**
 * OpenTelemetry semantic conventions and structured logging.
 * Subpath: @ai-sdlc/sdk/telemetry
 */
export {
  // Semantic conventions
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  AI_SDLC_PREFIX,

  // Instrumentation helpers
  getTracer,
  getMeter,
  withSpan,
  withSpanSync,

  // Structured logging
  createNoOpLogger,
  createBufferLogger,
  createConsoleLogger,
  type StructuredLogger,
  type BufferLogger,
  type LogEntry,
  type LogLevel,
} from '@ai-sdlc/reference';
