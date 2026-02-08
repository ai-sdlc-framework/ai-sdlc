/**
 * OpenTelemetry instrumentation helpers for AI-SDLC.
 * Uses @opentelemetry/api which is a no-op when no SDK is configured.
 */

import {
  trace,
  metrics,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Meter,
} from '@opentelemetry/api';

const TRACER_NAME = 'ai-sdlc-framework';
const METER_NAME = 'ai-sdlc-framework';

/** Get the AI-SDLC tracer instance. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Get the AI-SDLC meter instance. */
export function getMeter(): Meter {
  return metrics.getMeter(METER_NAME);
}

/**
 * Execute an async function within an OpenTelemetry span.
 * Automatically records errors and sets span status.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Execute a synchronous function within an OpenTelemetry span.
 * Automatically records errors and sets span status.
 */
export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => T,
): T {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}
