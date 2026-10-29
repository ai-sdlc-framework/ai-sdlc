import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import * as pkg from './index.js';
import { StateStore } from './state/store.js';
import { AutonomyTracker } from './autonomy-tracker.js';
import {
  loadDesignExemplarBank,
  buildDesignReviewContext,
  computeBindingDesignMetrics,
  handleDesignGateFailure,
  runDesignQualityTrendMonitor,
} from './design-review-pipeline.js';

const EXEMPLARS = resolve(__dirname, '../../.ai-sdlc/design-review-exemplars.yaml');

const input = (complex: boolean) => ({
  factors: {
    variantCount: complex ? 10 : 1,
    propCount: complex ? 20 : 2,
    responsiveBreakpoints: complex ? 6 : 1,
    interactiveStates: complex ? 8 : 1,
    composedComponents: complex ? 8 : 0,
    tokenReferences: 5,
  },
  spacingValues: [{ property: 'margin', value: '5px', numericValue: 5, file: 'a.tsx', line: 2 }],
  typographyValues: [],
  colorValues: [{ value: '#ff0000', isTokenized: false }],
  states: { componentType: 'button', required: ['default', 'focus'], covered: ['default'] },
  reuse: { catalogComponents: [], newElements: [] },
});

describe('design review pipeline wiring', () => {
  it('exposes the three orchestrator modules from the package barrel', () => {
    for (const name of [
      'computeDesignMetrics',
      'runCorrectionLoop',
      'createDesignReviewFeedbackStore',
      'detectDesignQualityTrendDegrading',
      'buildDesignReviewContext',
    ]) {
      expect((pkg as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('loads exemplars from .ai-sdlc and puts structural findings, principles, exemplars in context', () => {
    const bank = loadDesignExemplarBank(EXEMPLARS);
    expect(bank.getAll().length).toBeGreaterThan(0);
    const ctx = buildDesignReviewContext(input(false), bank);
    expect(ctx.contextMarkdown.startsWith('## Structural analysis')).toBe(true);
    expect(ctx.contextMarkdown).toContain('evidence-first');
    expect(ctx.contextMarkdown).toContain('hardcoded-hex-colour');
    expect(ctx.contextMarkdown).toContain('Missing states: focus');
  });

  it('gates human review on triggersDesignReview', () => {
    const bank = loadDesignExemplarBank(EXEMPLARS);
    expect(buildDesignReviewContext(input(true), bank).requiresHumanReview).toBe(true);
    expect(buildDesignReviewContext(input(false), bank).requiresHumanReview).toBe(false);
  });

  it('feeds design metrics into autonomy demotion and promotion', () => {
    const store = StateStore.open(new Database(':memory:'));
    const tracker = new AutonomyTracker(store);
    tracker.recordTaskOutcome('agent-a', true);
    const ledger = store.getAutonomyLedger('agent-a')!;
    store.upsertAutonomyLedger({ ...ledger, currentLevel: 1 });
    const metrics = computeBindingDesignMetrics(store, 'dsb');
    expect(metrics.designReviewApprovalRate).toBe(1);
    tracker.recordDesignMetrics('agent-a', { ...metrics, designReviewApprovalRate: 0.2 });
    const demotion = tracker.evaluateAndPersistDemotion('agent-a');
    expect(demotion.shouldDemote).toBe(true);
    expect(demotion.reasons.join()).toContain('Design review approval');
    const promo = tracker.evaluateAndPersistPromotion('agent-a');
    expect(promo.unmetConditions.join()).toContain('design review approval');
  });

  it('runs the correction loop on design gate failure', async () => {
    const failure = { component: 'Button' } as never;
    const calls: number[] = [];
    const result = await handleDesignGateFailure(
      async (failures, attempt) => {
        calls.push(attempt);
        expect(failures).toHaveLength(1);
        return { failures: [], costUsd: 0.1, tokenReferencesChanged: false };
      },
      { maxRetries: 3, costSoftLimitUsd: 5 },
      [failure],
    );
    expect(calls).toEqual([0]);
    expect(result.converged).toBe(true);
    const none = await handleDesignGateFailure(
      async () => {
        throw new Error('unreachable');
      },
      { maxRetries: 3, costSoftLimitUsd: 5 },
      [],
    );
    expect(none.iterations).toHaveLength(0);
  });

  it('trend monitor returns no events for areas without history', () => {
    const store = StateStore.open(new Database(':memory:'));
    expect(runDesignQualityTrendMonitor(['src/ui'], { stateStore: store })).toEqual([]);
  });
});
