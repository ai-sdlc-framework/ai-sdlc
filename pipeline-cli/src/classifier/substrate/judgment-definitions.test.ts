import { describe, expect, it } from 'vitest';
import {
  FakeJudgmentProvider,
  evaluateJudgment,
  getJudgmentDefinition,
  resolveJudgmentConfig,
  snapshotJudgmentDefinition,
  type JudgmentAnswer,
  type JudgmentOutcome,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import {
  PENDING_CLASSIFICATION,
  SUBSTRATE_CAPABILITY_IDS,
  SUBSTRATE_JUDGMENT_IDS,
  registerSubstrateJudgments,
  substrateJudgmentDefinition,
  substrateJudgmentDefinitions,
  type SubstrateJudgmentDecision,
} from './judgment-definitions.js';
import { ALLOWED_CLASSIFICATIONS } from './task-prompts.js';
import type { ClassifierInput } from './types.js';

const choice = (c: string, confidence: number): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: { [c]: confidence },
  confidence,
});

function compose(
  taskType: Parameters<typeof substrateJudgmentDefinition>[0],
  answer: JudgmentAnswer | undefined,
  thresholds: Record<string, number>,
  permissiveAllowed: boolean,
  input: ClassifierInput = { text: 'x' },
): JudgmentOutcome<SubstrateJudgmentDecision> {
  const def = substrateJudgmentDefinition(taskType);
  return def.compose(answer ? { answer } : {}, input, thresholds, { permissiveAllowed });
}

describe('substrate judgment definitions', () => {
  it('declares five seam, bidirectional, work-item-text definitions that pass registration', () => {
    const defs = substrateJudgmentDefinitions();
    expect(defs.map((d) => d.id)).toEqual([
      'capture.triage',
      'capture.severity',
      'capture.pr-comment',
      'dor.answer-segment',
      'decision.recommendation',
    ]);
    for (const d of defs) {
      expect(d.riskClass).toBe('seam');
      expect(d.direction).toBe('bidirectional');
      expect(d.egressClass).toBe('work-item-text');
      expect(d.fallback).toBe('pending');
      expect(d.reducingOutcomes).toEqual([]);
      expect(d.reducesReview).toBe(false);
      expect(snapshotJudgmentDefinition(d).ok).toBe(true);
    }
  });

  it('names the section 9.1 capability ids', () => {
    expect(Object.values(SUBSTRATE_CAPABILITY_IDS).sort()).toEqual(
      [
        'classifier.capture-triage',
        'classifier.capture-severity',
        'classifier.pr-comment-is-capture',
        'classifier.dor-answer-is-new-concern',
        'decisions.stage-c-recommendation',
      ].sort(),
    );
    for (const d of substrateJudgmentDefinitions()) {
      expect(Object.values(SUBSTRATE_CAPABILITY_IDS)).toContain(d.capabilityId);
    }
  });

  it('registers once and is idempotent', () => {
    registerSubstrateJudgments();
    registerSubstrateJudgments();
    for (const id of Object.values(SUBSTRATE_JUDGMENT_IDS)) {
      expect(getJudgmentDefinition(id)).toBeDefined();
    }
  });

  it('builds enum option sets from the substrate enums and never offers pending', () => {
    for (const t of ['capture-triage', 'capture-severity', 'dor-answer-is-new-concern'] as const) {
      const q = substrateJudgmentDefinition(t).questions({ text: 'x' }).answer;
      expect(q.type).toBe('choice');
      const keys = Object.keys((q as { options: Record<string, unknown> }).options);
      expect(keys).toEqual([...ALLOWED_CLASSIFICATIONS[t]].filter((v) => v !== 'pending'));
      expect(keys).not.toContain(PENDING_CLASSIFICATION);
      for (const desc of Object.values((q as { options: Record<string, string> }).options)) {
        expect(desc.length).toBeGreaterThan(20);
      }
    }
  });

  it('puts only the text in the state for the enum judgments', () => {
    const state = substrateJudgmentDefinition('capture-triage').buildState({
      text: 'a finding',
      context: { secret: 'no' },
    });
    expect(state).toEqual({ text: 'a finding' });
  });

  it('keeps adopter-visible strings free of task ids', () => {
    const text = JSON.stringify(
      substrateJudgmentDefinitions().map((d) => d.questions({ text: 'x' })),
    );
    expect(text).not.toMatch(/AISDLC-\d+/);
  });

  describe('choice compose', () => {
    const t = { confidence: 0.8 };
    it('acts at or above the threshold', () => {
      expect(compose('capture-triage', choice('quick-fix-task', 0.8), t, false)).toEqual({
        kind: 'act',
        decision: { classification: 'quick-fix-task', confidence: 0.8 },
      });
    });
    it('escalates below the threshold, with no threshold and on a malformed answer', () => {
      expect(compose('capture-triage', choice('quick-fix-task', 0.79), t, true).kind).toBe(
        'escalate',
      );
      expect(compose('capture-triage', choice('quick-fix-task', 0.99), {}, true).kind).toBe(
        'escalate',
      );
      expect(compose('capture-triage', { type: 'noul', probability: 1 }, t, true).kind).toBe(
        'escalate',
      );
      expect(compose('capture-triage', undefined, t, true).kind).toBe('escalate');
    });
    it.each([
      ['capture-triage', "won't-fix"],
      ['capture-severity', 'low'],
      ['dor-answer-is-new-concern', 'clarification'],
    ] as const)('escalates the permissive %s outcome %s unless allowed', (task, c) => {
      expect(compose(task, choice(c, 0.99), t, false).kind).toBe('escalate');
      expect(compose(task, choice(c, 0.99), t, true).kind).toBe('act');
    });
    it('acts on a non-permissive outcome even when permissive is not allowed', () => {
      expect(compose('capture-severity', choice('critical', 0.9), t, false).kind).toBe('act');
    });
  });

  describe('capture.pr-comment', () => {
    const t = { distance: 0.3 };
    const noul = (p: number): JudgmentAnswer => ({ type: 'noul', probability: p });
    it('acts when far enough from 0.5', () => {
      expect(compose('pr-comment-is-capture', noul(0.9), t, false)).toEqual({
        kind: 'act',
        decision: { classification: 'is-capture', confidence: 0.9 },
      });
    });
    it('escalates inside the distance band, with no threshold and on a malformed answer', () => {
      expect(compose('pr-comment-is-capture', noul(0.6), t, true).kind).toBe('escalate');
      expect(compose('pr-comment-is-capture', noul(0.9), {}, true).kind).toBe('escalate');
      expect(compose('pr-comment-is-capture', choice('a', 1), t, true).kind).toBe('escalate');
      expect(compose('pr-comment-is-capture', undefined, t, true).kind).toBe('escalate');
    });
    it('treats not-capture as permissive', () => {
      expect(compose('pr-comment-is-capture', noul(0.05), t, false).kind).toBe('escalate');
      const out = compose('pr-comment-is-capture', noul(0.05), t, true);
      expect(out.kind === 'act' && out.decision.classification).toBe('not-capture');
      expect(out.kind === 'act' && out.decision.confidence).toBeCloseTo(0.95);
    });
  });

  describe('decision.recommendation', () => {
    const ctx = (n: number): ClassifierInput => ({
      text: 'which way',
      context: {
        optionIds: Array.from({ length: n }, (_, i) => `opt-${i}`),
        optionDescriptions: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`opt-${i}`, `description ${i}`]),
        ),
      },
    });
    it.each([2, 8])('builds options from the context for %i options plus none-of-these', (n) => {
      const def = substrateJudgmentDefinition('decision-recommendation');
      const q = def.questions(ctx(n)).answer as { options: Record<string, string> };
      expect(Object.keys(q.options)).toHaveLength(n + 1);
      expect(q.options['opt-0']).toBe('description 0');
      expect(Object.keys(q.options)).toContain('none-of-these');
      expect(def.buildState(ctx(n))).toMatchObject({ summary: 'which way' });
    });
    it('avoids colliding with a caller option named none-of-these', () => {
      const def = substrateJudgmentDefinition('decision-recommendation');
      const input = { text: 't', context: { optionIds: ['none-of-these', 'b'] } };
      const q = def.questions(input).answer as { options: Record<string, string> };
      expect(Object.keys(q.options)).toEqual(['none-of-these', 'b', '_none-of-these']);
      expect(
        compose(
          'decision-recommendation',
          choice('_none-of-these', 0.99),
          { confidence: 0.5 },
          true,
          input,
        ).kind,
      ).toBe('escalate');
    });
    it('acts only for trusted work, escalates on none-of-these and unknown ids', () => {
      const t = { confidence: 0.5 };
      expect(compose('decision-recommendation', choice('opt-1', 0.9), t, true, ctx(2))).toEqual({
        kind: 'act',
        decision: { classification: 'opt-1', confidence: 0.9 },
      });
      expect(compose('decision-recommendation', choice('opt-1', 0.9), t, false, ctx(2)).kind).toBe(
        'escalate',
      );
      expect(
        compose('decision-recommendation', choice('none-of-these', 0.99), t, true, ctx(2)),
      ).toMatchObject({ kind: 'escalate', reason: 'none-of-these' });
      expect(
        compose('decision-recommendation', choice('zzz', 0.99), t, true, ctx(2)),
      ).toMatchObject({
        reason: 'unknown-option',
      });
      expect(compose('decision-recommendation', choice('opt-1', 0.2), t, true, ctx(2)).kind).toBe(
        'escalate',
      );
      expect(compose('decision-recommendation', choice('opt-1', 0.9), {}, true, ctx(2)).kind).toBe(
        'escalate',
      );
      expect(compose('decision-recommendation', undefined, t, true, ctx(2)).kind).toBe('escalate');
    });
    it('end to end with the fake provider: 8 options, none-of-these wins -> escalate', async () => {
      const provider = new FakeJudgmentProvider();
      provider.script('answer', choice('none-of-these', 0.95));
      const config: ResolvedJudgmentConfig = resolveJudgmentConfig({
        spec: {
          provider: 'fake',
          model: 'fake-1',
          judgments: {
            'decision.recommendation': {
              mode: 'enforce',
              thresholds: { 'fake@fake-1': { confidence: 0.5 } },
              promotion: { 'fake@fake-1': { path: 'override', evidence: 'operator walkthrough' } },
            },
          },
        },
      });
      const out = await evaluateJudgment(
        substrateJudgmentDefinition('decision-recommendation'),
        ctx(8),
        {
          config,
          getProvider: () => provider,
          sourceKind: 'backlog',
        },
      );
      expect(out.kind).toBe('escalate');
      expect(
        Object.keys((provider.requests[0].questions.answer as { options: object }).options),
      ).toHaveLength(9);
    });
  });

  it('agrees compares the decision with a label', () => {
    const d = substrateJudgmentDefinition('capture-triage');
    expect(d.agrees?.({ classification: 'tbd', confidence: 1 }, 'tbd')).toBe(true);
    expect(d.agrees?.({ classification: 'tbd', confidence: 1 }, 'x')).toBe(false);
  });
});
