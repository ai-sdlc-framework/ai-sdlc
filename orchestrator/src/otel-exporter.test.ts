import { describe, it, expect, beforeEach } from 'vitest';
import { createMetricStore } from '@ai-sdlc/reference';
import { createOTelBridge, isOTelAvailable } from './otel-exporter.js';

describe('otel-exporter', () => {
  let metricStore: ReturnType<typeof createMetricStore>;

  beforeEach(() => {
    metricStore = createMetricStore();
  });

  describe('createOTelBridge (disabled)', () => {
    it('creates a bridge in no-op mode when endpoint not set', () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const bridge = createOTelBridge(metricStore);
      expect(bridge.enabled).toBe(false);
    });

    it('delegates record to underlying store', () => {
      const bridge = createOTelBridge(metricStore);
      bridge.register({
        name: 'test-metric',
        category: 'task-effectiveness',
        description: 'test',
        unit: 'count',
      });
      const point = bridge.record({ metric: 'test-metric', value: 42 });
      expect(point.value).toBe(42);
      expect(metricStore.current('test-metric')).toBe(42);
    });

    it('delegates query/summarize to underlying store', () => {
      const bridge = createOTelBridge(metricStore);
      bridge.register({
        name: 'm1',
        category: 'task-effectiveness',
        description: '',
        unit: 'count',
      });
      bridge.record({ metric: 'm1', value: 10 });
      bridge.record({ metric: 'm1', value: 20 });

      const results = bridge.query({ metric: 'm1' });
      expect(results.length).toBe(2);

      const summary = bridge.summarize('m1');
      expect(summary).toBeDefined();
      expect(summary!.avg).toBe(15);
    });

    it('delegates snapshot and definitions', () => {
      const bridge = createOTelBridge(metricStore);
      bridge.register({
        name: 'm1',
        category: 'task-effectiveness',
        description: '',
        unit: 'count',
      });
      bridge.record({ metric: 'm1', value: 5 });

      const snap = bridge.snapshot();
      expect(snap['m1']).toBe(5);

      const defs = bridge.definitions();
      expect(defs.length).toBeGreaterThanOrEqual(1);
    });

    it('no-op span handles', () => {
      const bridge = createOTelBridge(metricStore);
      const span = bridge.startPipelineSpan('run-1', 'execute');
      span.setAttribute('key', 'value');
      span.end('ok'); // Should not throw

      const stage = bridge.startStageSpan('run-1', 'code');
      stage.end();
    });
  });

  describe('createOTelBridge (force enabled)', () => {
    it('enables when forceEnable is true', () => {
      const bridge = createOTelBridge(metricStore, { forceEnable: true });
      expect(bridge.enabled).toBe(true);
    });

    it('forwards records to OTel (no-op SDK)', () => {
      const bridge = createOTelBridge(metricStore, { forceEnable: true });
      bridge.register({
        name: 'test-total',
        category: 'task-effectiveness',
        description: '',
        unit: 'count',
      });
      // Should not throw even with no-op OTel SDK
      const point = bridge.record({ metric: 'test-total', value: 1 });
      expect(point.value).toBe(1);
    });

    it('creates span handles when enabled', () => {
      const bridge = createOTelBridge(metricStore, { forceEnable: true });
      const span = bridge.startPipelineSpan('run-1', 'execute');
      span.setAttribute('ai_sdlc.agent', 'code-agent');
      span.end('ok');
    });

    it('creates stage spans', () => {
      const bridge = createOTelBridge(metricStore, { forceEnable: true });
      const span = bridge.startStageSpan('run-1', 'validate');
      span.setAttribute('key', 'value');
      span.end();
    });
  });

  describe('isOTelAvailable', () => {
    it('returns false when endpoint not set', () => {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      expect(isOTelAvailable()).toBe(false);
    });

    it('returns true when endpoint is set', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4317';
      expect(isOTelAvailable()).toBe(true);
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    });
  });
});
