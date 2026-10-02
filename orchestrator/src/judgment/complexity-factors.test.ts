import { describe, it, expect } from 'vitest';
import {
  FakeJudgmentProvider,
  disabledJudgmentConfig,
  getJudgmentDefinition,
  resolveJudgmentConfig,
  scoreComplexity,
  type ComplexityInput,
  type EvaluateJudgmentContext,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import {
  BOOLEAN_COMPLEXITY_FACTORS,
  COMPLEXITY_FACTORS_ID,
  applyComplexityFactorJudgment,
  applyFactorRaises,
  complexityFactorsDefinition,
  scoreComplexityWithJudgment,
  type BooleanComplexityFactor,
} from './complexity-factors.js';

const p = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });

function provider(probs: Partial<Record<BooleanComplexityFactor, number>>) {
  const fake = new FakeJudgmentProvider();
  for (const f of BOOLEAN_COMPLEXITY_FACTORS) fake.script(f, p(probs[f] ?? 0));
  return fake;
}

function enforceCtx(fake: FakeJudgmentProvider, extra: Record<string, unknown> = {}) {
  const config = resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      judgments: {
        [COMPLEXITY_FACTORS_ID]: {
          mode: 'enforce',
          thresholds: { 'fake@fake-1': { raise: 0.8 } },
          promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed samples' } },
        },
      },
      ...extra,
    },
  });
  return { config, getProvider: () => fake } satisfies EvaluateJudgmentContext;
}

const base: ComplexityInput = { filesAffected: 6, linesOfChange: 250 };

describe('complexity.factors', () => {
  it('is registered tighten-only with agrees and the right egress class', () => {
    const def = getJudgmentDefinition(COMPLEXITY_FACTORS_ID);
    expect(def?.direction).toBe('tighten-only');
    expect(def?.riskClass).toBe('tighten');
    expect(def?.egressClass).toBe('work-item-text');
    expect(typeof def?.agrees).toBe('function');
    expect(def?.capabilityId).toBeUndefined();
  });

  it('turns a false factor true when its Noul clears the threshold', async () => {
    const out = await applyComplexityFactorJudgment(
      base,
      'rotate the signing key',
      enforceCtx(provider({ securitySensitive: 0.95 })),
    );
    expect(out.securitySensitive).toBe(true);
    expect(out.apiChange).toBeUndefined();
    expect(out.filesAffected).toBe(6);
  });

  it('never turns a true factor false and never lowers the score', async () => {
    const start: ComplexityInput = { ...base, securitySensitive: true, apiChange: true };
    const out = await applyComplexityFactorJudgment(start, 'text', enforceCtx(provider({})));
    expect(out.securitySensitive).toBe(true);
    expect(out.apiChange).toBe(true);
    expect(scoreComplexity(out)).toBeGreaterThanOrEqual(scoreComplexity(start));
  });

  it('property: over the fixture set the result is monotone', async () => {
    const levels = [0, 0.5, 0.79, 0.8, 1];
    const inputs: ComplexityInput[] = [
      base,
      { ...base, securitySensitive: true },
      { ...base, apiChange: true, databaseMigration: true },
      { filesAffected: 1, linesOfChange: 1, crossServiceChange: true, newDependencies: 2 },
      { filesAffected: 40, linesOfChange: 3000 },
    ];
    for (const input of inputs) {
      for (const a of levels) {
        for (const b of levels) {
          const fake = provider({
            securitySensitive: a,
            apiChange: b,
            databaseMigration: b,
            crossServiceChange: a,
          });
          const out = await applyComplexityFactorJudgment(input, 't', enforceCtx(fake));
          for (const f of BOOLEAN_COMPLEXITY_FACTORS) {
            if (input[f] === true) expect(out[f]).toBe(true);
          }
          expect(out.filesAffected).toBe(input.filesAffected);
          expect(out.linesOfChange).toBe(input.linesOfChange);
          expect(out.newDependencies).toBe(input.newDependencies);
          expect(scoreComplexity(out)).toBeGreaterThanOrEqual(scoreComplexity(input));
        }
      }
    }
  });

  it('compose cannot name anything but a raise, even for hostile answers', () => {
    const answers = Object.fromEntries(BOOLEAN_COMPLEXITY_FACTORS.map((f) => [f, p(1)]));
    const outcome = complexityFactorsDefinition.compose(
      answers,
      { text: '' },
      { raise: 0.5 },
      {
        permissiveAllowed: true,
      },
    );
    expect(outcome).toEqual({ kind: 'act', decision: { raise: [...BOOLEAN_COMPLEXITY_FACTORS] } });
    const next = applyFactorRaises({ ...base, apiChange: true }, [
      'securitySensitive',
      'bogus' as BooleanComplexityFactor,
    ]);
    expect(next).toEqual({ ...base, apiChange: true, securitySensitive: true });
  });

  it('supports per-factor thresholds and abstains without any threshold', () => {
    const answers = Object.fromEntries(BOOLEAN_COMPLEXITY_FACTORS.map((f) => [f, p(0.6)]));
    const ctx = { permissiveAllowed: false };
    const o = complexityFactorsDefinition.compose(
      answers,
      { text: '' },
      { 'raise.apiChange': 0.5, raise: 0.9 },
      ctx,
    );
    expect(o).toEqual({ kind: 'act', decision: { raise: ['apiChange'] } });
    expect(complexityFactorsDefinition.compose(answers, { text: '' }, {}, ctx).kind).toBe(
      'abstain',
    );
    expect(
      complexityFactorsDefinition.compose(
        { ...answers, apiChange: undefined as never },
        { text: '' },
        { raise: 0.5 },
        ctx,
      ),
    ).toMatchObject({ kind: 'act' });
  });

  it('agrees compares factor sets', () => {
    const agrees = complexityFactorsDefinition.agrees!;
    expect(agrees({ raise: ['apiChange'] }, ['apiChange'])).toBe(true);
    expect(agrees({ raise: ['apiChange'] }, ['securitySensitive'])).toBe(false);
    expect(agrees({ raise: [] }, 'nope')).toBe(true);
  });

  it('is identical to today when disabled, shadow, errored, or egress is denied', async () => {
    const baseline = scoreComplexity(base);
    const ok = provider({ securitySensitive: 1 });
    const cases: EvaluateJudgmentContext[] = [
      { config: disabledJudgmentConfig() },
      {
        config: resolveJudgmentConfig({ spec: { provider: 'fake', model: 'fake-1' } }),
        getProvider: () => ok,
      },
      enforceCtx(new FakeJudgmentProvider().failWith('timeout')),
      enforceCtx(ok, { egress: { allow: [] } }),
    ];
    for (const ctx of cases) {
      expect(await applyComplexityFactorJudgment(base, 'text', ctx)).toBe(base);
      expect(await scoreComplexityWithJudgment(base, 'text', ctx)).toBe(baseline);
    }
  });

  it('scoreComplexityWithJudgment raises the score when a factor is raised', async () => {
    const score = await scoreComplexityWithJudgment(
      base,
      'text',
      enforceCtx(provider({ securitySensitive: 0.99 })),
    );
    expect(score).toBeGreaterThan(scoreComplexity(base));
  });

  it('returns the input when evaluation throws', async () => {
    const ctx = {
      get config(): never {
        throw new Error('boom');
      },
    } as unknown as EvaluateJudgmentContext;
    expect(await applyComplexityFactorJudgment(base, 't', ctx)).toBe(base);
  });

  it('frames the text as data and asks only literal conditions', () => {
    const qs = complexityFactorsDefinition.questions({ text: 'x' });
    for (const q of Object.values(qs)) {
      expect(JSON.stringify(q)).toContain('quoted data');
    }
    expect(complexityFactorsDefinition.buildState({ text: 'hello' })).toEqual({
      workItemText: 'hello',
    });
  });
});
