import { describe, it, expect } from 'vitest';
import {
  createPipelineMetricStore,
  createInstrumentedEnforcement,
  createInstrumentedAutonomy,
  STANDARD_METRICS,
} from './instrumented.js';
import type { QualityGate, EvaluationContext } from '@ai-sdlc/reference';

function makeQualityGate(): QualityGate {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'QualityGate',
    metadata: { name: 'test-gate' },
    spec: {
      gates: [
        {
          name: 'description-present',
          enforcement: 'advisory',
          rule: { metric: 'description-length', operator: '>=', threshold: 1 },
        },
        {
          name: 'complexity-check',
          enforcement: 'hard-mandatory',
          rule: { metric: 'complexity', operator: '<=', threshold: 5 },
        },
      ],
    },
  };
}

function makeEvalCtx(metrics: Record<string, number> = {}): EvaluationContext {
  return {
    authorType: 'ai-agent',
    repository: 'test',
    metrics: { 'description-length': 10, complexity: 3, ...metrics },
  };
}

describe('Metrics instrumentation', () => {
  describe('createPipelineMetricStore()', () => {
    it('creates a metric store', () => {
      const store = createPipelineMetricStore();
      expect(store).toBeDefined();
      expect(typeof store.record).toBe('function');
      expect(typeof store.query).toBe('function');
    });
  });

  describe('STANDARD_METRICS', () => {
    it('has defined standard metrics', () => {
      expect(STANDARD_METRICS.length).toBeGreaterThan(0);
      const names = STANDARD_METRICS.map((m) => m.name);
      expect(names).toContain('task-completion-rate');
    });
  });

  describe('createInstrumentedEnforcement()', () => {
    it('records gate pass metrics', () => {
      const store = createPipelineMetricStore();
      const instrumentedEnforce = createInstrumentedEnforcement(store);
      const result = instrumentedEnforce(makeQualityGate(), makeEvalCtx());
      expect(result.allowed).toBe(true);

      const passMetrics = store.query({ metric: 'ai_sdlc.gate.pass.total' });
      expect(passMetrics.length).toBeGreaterThan(0);
    });

    it('records gate fail metrics on failure', () => {
      const store = createPipelineMetricStore();
      const instrumentedEnforce = createInstrumentedEnforcement(store);
      const result = instrumentedEnforce(makeQualityGate(), makeEvalCtx({ complexity: 10 }));
      expect(result.allowed).toBe(false);

      const failMetrics = store.query({ metric: 'ai_sdlc.gate.fail.total' });
      expect(failMetrics.length).toBeGreaterThan(0);
    });

    it('records per-gate labels', () => {
      const store = createPipelineMetricStore();
      const instrumentedEnforce = createInstrumentedEnforcement(store);
      instrumentedEnforce(makeQualityGate(), makeEvalCtx());

      const passMetrics = store.query({ metric: 'ai_sdlc.gate.pass.total' });
      const hasGateLabel = passMetrics.some((m) => m.labels?.gate === 'description-present');
      expect(hasGateLabel).toBe(true);
    });

    it('returns original enforcement result', () => {
      const store = createPipelineMetricStore();
      const instrumentedEnforce = createInstrumentedEnforcement(store);
      const result = instrumentedEnforce(makeQualityGate(), makeEvalCtx());
      expect(result.results).toHaveLength(2);
      expect(result.results[0].gate).toBe('description-present');
    });
  });

  describe('createInstrumentedAutonomy()', () => {
    it('records promotion metrics', () => {
      const store = createPipelineMetricStore();
      const { onPromotion } = createInstrumentedAutonomy(store);
      onPromotion('agent-1', 0, 1);

      const promotions = store.query({ metric: 'ai_sdlc.autonomy.promotion.total' });
      expect(promotions.length).toBe(1);
    });

    it('records demotion metrics', () => {
      const store = createPipelineMetricStore();
      const { onDemotion } = createInstrumentedAutonomy(store);
      onDemotion('agent-1', 2, 0);

      const demotions = store.query({ metric: 'ai_sdlc.autonomy.demotion.total' });
      expect(demotions.length).toBe(1);
    });

    it('records autonomy level on promotion', () => {
      const store = createPipelineMetricStore();
      const { onPromotion } = createInstrumentedAutonomy(store);
      onPromotion('agent-1', 0, 2);

      const levels = store.query({ metric: 'ai_sdlc.autonomy.level' });
      expect(levels.length).toBe(1);
      expect(levels[0].value).toBe(2);
    });

    it('records autonomy level on demotion', () => {
      const store = createPipelineMetricStore();
      const { onDemotion } = createInstrumentedAutonomy(store);
      onDemotion('agent-1', 3, 1);

      const levels = store.query({ metric: 'ai_sdlc.autonomy.level' });
      expect(levels.length).toBe(1);
      expect(levels[0].value).toBe(1);
    });
  });
});
