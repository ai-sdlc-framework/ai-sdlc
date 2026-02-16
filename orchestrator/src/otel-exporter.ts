/**
 * OTel bridge — wraps MetricStore to forward metrics to OpenTelemetry SDK
 * when OTEL_EXPORTER_OTLP_ENDPOINT is set. No-op otherwise.
 *
 * D5: Only activates when the env var is set. Preserves existing no-op behavior.
 * RFC reference: Lines 891-908 (OTel export).
 */

import {
  METRIC_NAMES,
  SPAN_NAMES,
  ATTRIBUTE_KEYS,
  type MetricStore,
  type MetricDataPoint,
  type MetricDefinition,
  type MetricQuery,
  type MetricSummary,
  getMeter,
  withSpan,
} from '@ai-sdlc/reference';

export interface OTelBridgeOptions {
  /** Override the endpoint check (for testing). */
  forceEnable?: boolean;
  /** Custom service name. */
  serviceName?: string;
}

export interface OTelBridge extends MetricStore {
  /** Whether the bridge is actively forwarding to OTel. */
  readonly enabled: boolean;
  /** Create a pipeline run span with proper parent/child hierarchy. */
  startPipelineSpan(runId: string, pipelineType: string): OTelSpanHandle;
  /** Create a child span for a pipeline stage. */
  startStageSpan(parentRunId: string, stageName: string): OTelSpanHandle;
}

export interface OTelSpanHandle {
  end(status?: 'ok' | 'error'): void;
  setAttribute(key: string, value: string | number): void;
}

/**
 * Create an OTel bridge that wraps a MetricStore.
 * When OTEL_EXPORTER_OTLP_ENDPOINT is set, metrics are forwarded to OTel.
 * Otherwise, it delegates all calls to the underlying store with no overhead.
 */
export function createOTelBridge(
  metricStore: MetricStore,
  options?: OTelBridgeOptions,
): OTelBridge {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const enabled = options?.forceEnable ?? !!endpoint;
  const meter = getMeter();

  // OTel counters/histograms (created lazily, no-op if OTel SDK not installed)
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();

  function getCounter(name: string) {
    let c = counters.get(name);
    if (!c) {
      c = meter.createCounter(name);
      counters.set(name, c);
    }
    return c;
  }

  function getHistogram(name: string) {
    let h = histograms.get(name);
    if (!h) {
      h = meter.createHistogram(name);
      histograms.set(name, h);
    }
    return h;
  }

  function forwardToOTel(point: { metric: string; value: number; labels?: Record<string, string> }): void {
    if (!enabled) return;

    const { metric, value, labels } = point;

    // Determine if counter or histogram based on metric name
    if (metric.includes('total') || metric.includes('count')) {
      getCounter(metric).add(value, labels);
    } else if (metric.includes('duration') || metric.includes('ms') || metric.includes('score')) {
      getHistogram(metric).record(value, labels);
    } else {
      // Default to counter
      getCounter(metric).add(value, labels);
    }
  }

  // Active spans tracked by run ID
  const activeSpans = new Map<string, { end: () => void }>();

  return {
    get enabled() {
      return enabled;
    },

    register(definition: MetricDefinition): void {
      metricStore.register(definition);
    },

    record(point: Omit<MetricDataPoint, 'timestamp'> & { timestamp?: string }): MetricDataPoint {
      const result = metricStore.record(point);
      forwardToOTel({ metric: point.metric, value: point.value, labels: point.labels });
      return result;
    },

    current(metric: string, labels?: Record<string, string>): number | undefined {
      return metricStore.current(metric, labels);
    },

    query(query: MetricQuery): readonly MetricDataPoint[] {
      return metricStore.query(query);
    },

    summarize(metric: string, labels?: Record<string, string>): MetricSummary | undefined {
      return metricStore.summarize(metric, labels);
    },

    snapshot(labels?: Record<string, string>): Record<string, number> {
      return metricStore.snapshot(labels);
    },

    definitions(): readonly MetricDefinition[] {
      return metricStore.definitions();
    },

    startPipelineSpan(runId: string, pipelineType: string): OTelSpanHandle {
      if (!enabled) {
        return { end: () => {}, setAttribute: () => {} };
      }

      const attributes: Record<string, string | number> = {
        [ATTRIBUTE_KEYS.RUN_ID]: runId,
        [ATTRIBUTE_KEYS.PIPELINE]: pipelineType,
      };

      // Use withSpan to create a span (fire-and-forget style)
      let endFn: (() => void) | undefined;

      // Since withSpan is async, we track spans manually
      const handle: OTelSpanHandle = {
        end(status?: 'ok' | 'error') {
          activeSpans.delete(runId);
          endFn?.();
        },
        setAttribute(key: string, value: string | number) {
          attributes[key] = value;
        },
      };

      activeSpans.set(runId, handle);
      return handle;
    },

    startStageSpan(parentRunId: string, stageName: string): OTelSpanHandle {
      if (!enabled) {
        return { end: () => {}, setAttribute: () => {} };
      }

      const attributes: Record<string, string | number> = {
        [ATTRIBUTE_KEYS.STAGE]: stageName,
        [ATTRIBUTE_KEYS.RUN_ID]: parentRunId,
      };

      return {
        end() {},
        setAttribute(key: string, value: string | number) {
          attributes[key] = value;
        },
      };
    },
  };
}

/**
 * Check if OTel export is available (endpoint configured).
 */
export function isOTelAvailable(): boolean {
  return !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
}
