import { describe, it, expect } from 'vitest';
import { createMetricStore } from './store.js';
import {
  instrumentEnforcement,
  instrumentExecutor,
  instrumentReconciler,
  instrumentAutonomy,
} from './instrumentation.js';
import { enforce } from '../policy/enforcement.js';
import { executeOrchestration } from '../agents/executor.js';
import { METRIC_NAMES } from '../telemetry/semantic-conventions.js';
import type { QualityGate, AgentRole, AnyResource } from '../core/types.js';
import type { ReconcileResult } from '../reconciler/types.js';
import { sequential } from '../agents/orchestration.js';

const testGate: QualityGate = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'QualityGate',
  metadata: { name: 'test-gate' },
  spec: {
    gates: [
      {
        name: 'coverage',
        enforcement: 'hard-mandatory',
        rule: { metric: 'coverage', operator: '>=', threshold: 80 },
      },
    ],
  },
};

function makeAgent(name: string): AgentRole {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'AgentRole',
    metadata: { name },
    spec: { role: name, goal: 'test', tools: [] },
  };
}

describe('instrumentEnforcement', () => {
  it('records gate pass counts', () => {
    const store = createMetricStore();
    const wrapped = instrumentEnforcement(enforce, { metricStore: store });
    wrapped(testGate, {
      authorType: 'human',
      repository: 'test',
      metrics: { coverage: 90 },
    });
    expect(store.current(METRIC_NAMES.GATE_PASS_TOTAL)).toBe(1);
  });

  it('records gate fail counts', () => {
    const store = createMetricStore();
    const wrapped = instrumentEnforcement(enforce, { metricStore: store });
    wrapped(testGate, {
      authorType: 'human',
      repository: 'test',
      metrics: { coverage: 50 },
    });
    expect(store.current(METRIC_NAMES.GATE_FAIL_TOTAL)).toBe(1);
  });

  it('accumulates counts across calls', () => {
    const store = createMetricStore();
    const wrapped = instrumentEnforcement(enforce, { metricStore: store });
    const ctx = { authorType: 'human' as const, repository: 'test', metrics: { coverage: 90 } };
    wrapped(testGate, ctx);
    wrapped(testGate, ctx);
    const points = store.query({ metric: METRIC_NAMES.GATE_PASS_TOTAL });
    expect(points).toHaveLength(2);
  });

  it('includes gate and enforcement labels', () => {
    const store = createMetricStore();
    const wrapped = instrumentEnforcement(enforce, { metricStore: store });
    wrapped(testGate, {
      authorType: 'human',
      repository: 'test',
      metrics: { coverage: 90 },
    });
    const points = store.query({ metric: METRIC_NAMES.GATE_PASS_TOTAL });
    expect(points[0].labels).toEqual({
      gate: 'coverage',
      enforcement: 'hard-mandatory',
    });
  });

  it('returns original result unchanged', () => {
    const store = createMetricStore();
    const wrapped = instrumentEnforcement(enforce, { metricStore: store });
    const result = wrapped(testGate, {
      authorType: 'human',
      repository: 'test',
      metrics: { coverage: 90 },
    });
    expect(result.allowed).toBe(true);
    expect(result.results[0].verdict).toBe('pass');
  });
});

describe('instrumentExecutor', () => {
  it('records task duration', async () => {
    const store = createMetricStore();
    const wrapped = instrumentExecutor(executeOrchestration, { metricStore: store });
    const agents = new Map([['a', makeAgent('a')]]);
    const plan = sequential([makeAgent('a')]);

    await wrapped(plan, agents, async () => 'done');

    const duration = store.current(METRIC_NAMES.TASK_DURATION_MS);
    expect(duration).toBeDefined();
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('records success counts per step', async () => {
    const store = createMetricStore();
    const wrapped = instrumentExecutor(executeOrchestration, { metricStore: store });
    const agents = new Map([['a', makeAgent('a')]]);
    const plan = sequential([makeAgent('a')]);

    await wrapped(plan, agents, async () => 'ok');

    const points = store.query({ metric: METRIC_NAMES.TASK_SUCCESS_TOTAL });
    expect(points.length).toBeGreaterThan(0);
  });

  it('records failure counts on error', async () => {
    const store = createMetricStore();
    const wrapped = instrumentExecutor(executeOrchestration, { metricStore: store });
    const agents = new Map([['a', makeAgent('a')]]);
    const plan = sequential([makeAgent('a')]);

    await wrapped(plan, agents, async () => {
      throw new Error('fail');
    });

    const points = store.query({ metric: METRIC_NAMES.TASK_FAILURE_TOTAL });
    expect(points.length).toBeGreaterThan(0);
  });

  it('returns original result', async () => {
    const store = createMetricStore();
    const wrapped = instrumentExecutor(executeOrchestration, { metricStore: store });
    const agents = new Map([['a', makeAgent('a')]]);
    const plan = sequential([makeAgent('a')]);

    const result = await wrapped(plan, agents, async () => 'output');
    expect(result.success).toBe(true);
  });
});

describe('instrumentReconciler', () => {
  it('records reconciliation duration', async () => {
    const store = createMetricStore();
    const mockReconciler = async (_r: AnyResource): Promise<ReconcileResult> => ({
      type: 'success',
    });
    const wrapped = instrumentReconciler(mockReconciler, { metricStore: store });

    const resource: AnyResource = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Pipeline',
      metadata: { name: 'test-pipeline' },
      spec: { triggers: [], providers: {}, stages: [] },
    };

    await wrapped(resource);

    const duration = store.current(METRIC_NAMES.RECONCILIATION_DURATION_MS);
    expect(duration).toBeDefined();
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('records result type in labels', async () => {
    const store = createMetricStore();
    const mockReconciler = async (_r: AnyResource): Promise<ReconcileResult> => ({
      type: 'error',
      error: new Error('oops'),
    });
    const wrapped = instrumentReconciler(mockReconciler, { metricStore: store });

    const resource: AnyResource = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Pipeline',
      metadata: { name: 'pipe' },
      spec: { triggers: [], providers: {}, stages: [] },
    };

    await wrapped(resource);

    const points = store.query({ metric: METRIC_NAMES.RECONCILIATION_DURATION_MS });
    expect(points[0].labels?.result).toBe('error');
  });

  it('returns original result', async () => {
    const store = createMetricStore();
    const mockReconciler = async (_r: AnyResource): Promise<ReconcileResult> => ({
      type: 'requeue',
    });
    const wrapped = instrumentReconciler(mockReconciler, { metricStore: store });

    const resource: AnyResource = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Pipeline',
      metadata: { name: 'pipe' },
      spec: { triggers: [], providers: {}, stages: [] },
    };

    const result = await wrapped(resource);
    expect(result.type).toBe('requeue');
  });
});

describe('instrumentAutonomy', () => {
  it('records promotion events', () => {
    const store = createMetricStore();
    const { onPromotion } = instrumentAutonomy({ metricStore: store });
    onPromotion('agent-1', 1, 2);
    expect(store.current(METRIC_NAMES.PROMOTION_TOTAL, { agent: 'agent-1' })).toBe(1);
    expect(store.current(METRIC_NAMES.AUTONOMY_LEVEL, { agent: 'agent-1' })).toBe(2);
  });

  it('records demotion events', () => {
    const store = createMetricStore();
    const { onDemotion } = instrumentAutonomy({ metricStore: store });
    onDemotion('agent-1', 3, 1);
    expect(store.current(METRIC_NAMES.DEMOTION_TOTAL, { agent: 'agent-1' })).toBe(1);
    expect(store.current(METRIC_NAMES.AUTONOMY_LEVEL, { agent: 'agent-1' })).toBe(1);
  });

  it('works without OTel meter', () => {
    const store = createMetricStore();
    const callbacks = instrumentAutonomy({ metricStore: store });
    // Should not throw even without meter
    expect(() => callbacks.onPromotion('a', 0, 1)).not.toThrow();
    expect(() => callbacks.onDemotion('a', 1, 0)).not.toThrow();
  });
});
