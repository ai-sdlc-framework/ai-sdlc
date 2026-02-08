/**
 * In-memory metric store with per-label tracking.
 */

import type {
  MetricDataPoint,
  MetricDefinition,
  MetricQuery,
  MetricStore,
  MetricSummary,
} from './types.js';

function labelsMatch(
  pointLabels: Record<string, string> | undefined,
  queryLabels: Record<string, string> | undefined,
): boolean {
  if (!queryLabels || Object.keys(queryLabels).length === 0) return true;
  if (!pointLabels) return false;
  return Object.entries(queryLabels).every(([k, v]) => pointLabels[k] === v);
}

export function createMetricStore(): MetricStore {
  const definitions = new Map<string, MetricDefinition>();
  const data = new Map<string, MetricDataPoint[]>();

  function getPoints(metric: string): MetricDataPoint[] {
    let points = data.get(metric);
    if (!points) {
      points = [];
      data.set(metric, points);
    }
    return points;
  }

  return {
    register(definition: MetricDefinition): void {
      definitions.set(definition.name, definition);
    },

    record(partial: Omit<MetricDataPoint, 'timestamp'> & { timestamp?: string }): MetricDataPoint {
      const point: MetricDataPoint = {
        metric: partial.metric,
        value: partial.value,
        timestamp: partial.timestamp ?? new Date().toISOString(),
        labels: partial.labels,
      };
      getPoints(point.metric).push(point);
      return point;
    },

    current(metric: string, labels?: Record<string, string>): number | undefined {
      const points = data.get(metric);
      if (!points || points.length === 0) return undefined;
      for (let i = points.length - 1; i >= 0; i--) {
        if (labelsMatch(points[i].labels, labels)) {
          return points[i].value;
        }
      }
      return undefined;
    },

    query(query: MetricQuery): readonly MetricDataPoint[] {
      const points = data.get(query.metric);
      if (!points) return [];
      return points.filter((p) => {
        if (!labelsMatch(p.labels, query.labels)) return false;
        if (query.from && p.timestamp < query.from) return false;
        if (query.to && p.timestamp > query.to) return false;
        return true;
      });
    },

    summarize(metric: string, labels?: Record<string, string>): MetricSummary | undefined {
      const points = data.get(metric);
      if (!points || points.length === 0) return undefined;
      const matching = points.filter((p) => labelsMatch(p.labels, labels));
      if (matching.length === 0) return undefined;

      const values = matching.map((p) => p.value);
      return {
        metric,
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((sum, v) => sum + v, 0) / values.length,
        latest: values[values.length - 1],
      };
    },

    snapshot(labels?: Record<string, string>): Record<string, number> {
      const result: Record<string, number> = {};
      for (const [metric, points] of data) {
        for (let i = points.length - 1; i >= 0; i--) {
          if (labelsMatch(points[i].labels, labels)) {
            result[metric] = points[i].value;
            break;
          }
        }
      }
      return result;
    },

    definitions(): readonly MetricDefinition[] {
      return Array.from(definitions.values());
    },
  };
}
