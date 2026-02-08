import { describe, it, expect } from 'vitest';
import { createGateReconciler } from './gate-reconciler.js';
import type { QualityGate } from '../core/types.js';
import type { EvaluationContext } from '../policy/enforcement.js';

const API = 'ai-sdlc.io/v1alpha1' as const;

function makeGate(metric: string, threshold: number): QualityGate {
  return {
    apiVersion: API,
    kind: 'QualityGate',
    metadata: { name: 'test-gate' },
    spec: {
      gates: [
        {
          name: 'metric-check',
          enforcement: 'hard-mandatory',
          rule: { metric, operator: '>=', threshold },
        },
      ],
    },
  };
}

describe('createGateReconciler', () => {
  it('sets compliant=true when gate passes', async () => {
    const gate = makeGate('coverage', 80);
    const reconciler = createGateReconciler({
      getContext: (): EvaluationContext => ({
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { coverage: 90 },
      }),
    });

    const result = await reconciler(gate);
    expect(result.type).toBe('success');
    expect(gate.status?.compliant).toBe(true);
  });

  it('sets compliant=false when gate fails', async () => {
    const gate = makeGate('coverage', 80);
    const reconciler = createGateReconciler({
      getContext: (): EvaluationContext => ({
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { coverage: 60 },
      }),
    });

    const result = await reconciler(gate);
    expect(result.type).toBe('success');
    expect(gate.status?.compliant).toBe(false);
  });

  it('populates conditions with gate results', async () => {
    const gate = makeGate('coverage', 80);
    const reconciler = createGateReconciler({
      getContext: (): EvaluationContext => ({
        authorType: 'ai-agent',
        repository: 'test',
        metrics: { coverage: 90 },
      }),
    });

    await reconciler(gate);
    expect(gate.status?.conditions).toHaveLength(1);
    expect(gate.status?.conditions?.[0].type).toBe('metric-check');
    expect(gate.status?.conditions?.[0].status).toBe('True');
  });

  it('handles context provider errors', async () => {
    const gate = makeGate('coverage', 80);
    const reconciler = createGateReconciler({
      getContext: () => {
        throw new Error('Context unavailable');
      },
    });

    const result = await reconciler(gate);
    expect(result.type).toBe('error');
  });

  it('creates status object if missing', async () => {
    const gate: QualityGate = {
      apiVersion: API,
      kind: 'QualityGate',
      metadata: { name: 'no-status' },
      spec: {
        gates: [
          {
            name: 'check',
            enforcement: 'advisory',
            rule: { metric: 'x', operator: '>=', threshold: 0 },
          },
        ],
      },
    };

    const reconciler = createGateReconciler({
      getContext: (): EvaluationContext => ({
        authorType: 'human',
        repository: 'test',
        metrics: { x: 1 },
      }),
    });

    await reconciler(gate);
    expect(gate.status?.compliant).toBe(true);
  });
});
