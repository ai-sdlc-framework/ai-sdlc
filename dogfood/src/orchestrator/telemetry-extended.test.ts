import { describe, it, expect } from 'vitest';
import {
  createSilentLogger,
  withPipelineSpanSync,
  getPipelineTracer,
  // Re-exports
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
} from './telemetry-extended.js';

describe('Extended telemetry', () => {
  describe('createSilentLogger()', () => {
    it('creates a no-op logger', () => {
      const logger = createSilentLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      // Should not throw when called
      logger.info('silent message');
      logger.warn('silent warning');
      logger.error('silent error');
    });
  });

  describe('withPipelineSpanSync()', () => {
    it('executes a function synchronously within a span', () => {
      const result = withPipelineSpanSync('test-span', { key: 'value' }, () => 42);
      expect(result).toBe(42);
    });

    it('returns the function result', () => {
      const obj = { hello: 'world' };
      const result = withPipelineSpanSync('test', {}, () => obj);
      expect(result).toBe(obj);
    });
  });

  describe('getPipelineTracer()', () => {
    it('returns a tracer instance', () => {
      const tracer = getPipelineTracer();
      expect(tracer).toBeDefined();
    });
  });

  describe('reference re-exports', () => {
    it('getTracer returns a tracer', () => {
      expect(typeof getTracer).toBe('function');
      const tracer = getTracer();
      expect(tracer).toBeDefined();
    });

    it('getMeter returns a meter', () => {
      expect(typeof getMeter).toBe('function');
      const meter = getMeter();
      expect(meter).toBeDefined();
    });

    it('withSpan is a function', () => {
      expect(typeof withSpan).toBe('function');
    });

    it('withSpanSync executes synchronously', () => {
      const result = withSpanSync('test', {}, () => 'ok');
      expect(result).toBe('ok');
    });

    it('createNoOpLogger creates silent logger', () => {
      const logger = createNoOpLogger();
      expect(typeof logger.info).toBe('function');
    });

    it('createConsoleLogger creates console logger', () => {
      const logger = createConsoleLogger();
      expect(typeof logger.info).toBe('function');
    });

    it('createBufferLogger creates buffer logger', () => {
      const logger = createBufferLogger();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.getEntries).toBe('function');
    });

    it('SPAN_NAMES is defined', () => {
      expect(SPAN_NAMES).toBeDefined();
    });

    it('METRIC_NAMES is defined', () => {
      expect(METRIC_NAMES).toBeDefined();
    });

    it('ATTRIBUTE_KEYS is defined', () => {
      expect(ATTRIBUTE_KEYS).toBeDefined();
    });

    it('AI_SDLC_PREFIX is a string', () => {
      expect(typeof AI_SDLC_PREFIX).toBe('string');
    });

    it('validate is a function', () => {
      expect(typeof validate).toBe('function');
    });

    it('compareMetric is a function', () => {
      expect(typeof compareMetric).toBe('function');
    });

    it('exceedsSeverity is a function', () => {
      expect(typeof exceedsSeverity).toBe('function');
    });
  });
});
