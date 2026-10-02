import { describe, expect, it } from 'vitest';
import {
  FakeJudgmentProvider,
  disabledJudgmentConfig,
  getJudgmentDefinition,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';
import { classifyFailure } from '../tui/analytics/quality-classifier.js';
import {
  FAILURE_CLASS_ID,
  attachAdvisoryFailureClass,
  failureClassDefinition,
} from './failure-class.js';

const thresholds = { autoClassify: 0.7, ambiguous: 0.3 };
const signal = { stderr: 'something odd happened with zebra', exitCode: 1 };

function choice(label: string, p: number) {
  return {
    type: 'choice' as const,
    choice: label,
    probabilities: { [label]: p },
    confidence: 0.9,
  };
}

function ctxFor(
  answer: ReturnType<typeof choice>,
  allow: string[] = ['work-item-text', 'agent-output'],
) {
  const fake = new FakeJudgmentProvider().script('class', answer);
  return {
    fake,
    ctx: {
      config: resolveJudgmentConfig({
        spec: {
          provider: 'fake',
          model: 'fake-1',
          egress: { allow },
          judgments: {
            [FAILURE_CLASS_ID]: {
              mode: 'enforce',
              thresholds: { 'fake@fake-1': { label: 0.8 } },
              promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed' } },
            },
          },
        },
      }),
      getProvider: () => fake,
    } satisfies EvaluateJudgmentContext,
  };
}

describe('failure.class', () => {
  it('is registered tighten-only on agent-output with agrees', () => {
    const def = getJudgmentDefinition(FAILURE_CLASS_ID);
    expect(def?.direction).toBe('tighten-only');
    expect(def?.riskClass).toBe('tighten');
    expect(def?.egressClass).toBe('agent-output');
    expect(typeof def?.agrees).toBe('function');
  });

  it('sends only the failure text and offers the four classes plus none-of-these', () => {
    const state = failureClassDefinition.buildState({ stderr: 'boom' });
    expect(state).toEqual({ failureText: 'boom' });
    const q = failureClassDefinition.questions({ stderr: 'boom' }).class;
    expect(q.type).toBe('choice');
    expect(Object.keys((q as { options: object }).options).sort()).toEqual(
      [
        'ambiguous',
        'external-dependency-failed',
        'framework-misbehaved',
        'none-of-these',
        'operator-under-decided',
      ].sort(),
    );
    expect(JSON.stringify(q)).toContain('quoted data');
  });

  it('adds the label beside an unchanged primary result for UnknownFailureMode', async () => {
    const { ctx, fake } = ctxFor(choice('external-dependency-failed', 0.95));
    const primary = classifyFailure(signal, { thresholds, ts: new Date(0) });
    const out = await attachAdvisoryFailureClass(signal, 'UnknownFailureMode', ctx, {
      thresholds,
      ts: new Date(0),
    });
    expect(out.advisoryClass).toBe('external-dependency-failed');
    const { advisoryClass: _a, ...rest } = out;
    expect(rest).toEqual(primary);
    expect(fake.requests[0].state).toEqual({ failureText: signal.stderr });
  });

  it('is consulted only when the playbook did not match', async () => {
    const { ctx, fake } = ctxFor(choice('framework-misbehaved', 0.95));
    const out = await attachAdvisoryFailureClass(signal, 'VerificationFailure', ctx, {
      thresholds,
    });
    expect(out.advisoryClass).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it("returns exactly today's result when disabled, shadow, errored, egress denied, none-of-these or low", async () => {
    const primary = classifyFailure(signal, { thresholds, ts: new Date(0) });
    const run = (ctx: EvaluateJudgmentContext | undefined) =>
      attachAdvisoryFailureClass(signal, 'UnknownFailureMode', ctx, {
        thresholds,
        ts: new Date(0),
      });
    const ok = ctxFor(choice('external-dependency-failed', 0.95)).ctx;
    const cases: Array<EvaluateJudgmentContext | undefined> = [
      undefined,
      { config: disabledJudgmentConfig() },
      {
        config: resolveJudgmentConfig({
          spec: { provider: 'fake', model: 'fake-1', egress: { allow: ['agent-output'] } },
        }),
        getProvider: ok.getProvider,
      },
      { ...ok, getProvider: () => new FakeJudgmentProvider().failWith('timeout') },
      ctxFor(choice('external-dependency-failed', 0.95), ['work-item-text']).ctx,
      ctxFor(choice('none-of-these', 0.99)).ctx,
      ctxFor(choice('external-dependency-failed', 0.5)).ctx,
      ctxFor({ ...choice('x', 0.9), choice: 'ambiguous' } as never).ctx,
    ];
    for (const c of cases) expect(await run(c)).toEqual(primary);
  });

  it('never yields anything but a label: decision has one field', () => {
    const outcome = failureClassDefinition.compose(
      { class: choice('ambiguous', 0.99) },
      { stderr: '' },
      { label: 0.5 },
      { permissiveAllowed: true },
    );
    expect(outcome).toEqual({ kind: 'act', decision: { advisoryClass: 'ambiguous' } });
    expect(
      failureClassDefinition.compose(
        {},
        { stderr: '' },
        { label: 0.5 },
        { permissiveAllowed: false },
      ),
    ).toEqual({ kind: 'abstain', reason: 'bad-answer' });
    expect(
      failureClassDefinition.compose(
        { class: choice('ambiguous', 0.99) },
        { stderr: '' },
        {},
        { permissiveAllowed: false },
      ).kind,
    ).toBe('abstain');
    expect(failureClassDefinition.agrees!({ advisoryClass: 'ambiguous' }, 'ambiguous')).toBe(true);
  });

  it('returns the primary result when evaluation throws', async () => {
    const ctx = {
      get config(): never {
        throw new Error('boom');
      },
    } as unknown as EvaluateJudgmentContext;
    const out = await attachAdvisoryFailureClass(signal, 'UnknownFailureMode', ctx, { thresholds });
    expect(out.advisoryClass).toBeUndefined();
  });
});
