import { describe, it, expect } from 'vitest';
import { FakeJudgmentProvider } from './fake-provider.js';
import {
  evaluateJudgment,
  promotionSatisfies,
  type JudgmentEvaluationRecord,
  type JudgmentSink,
} from './evaluate.js';
import { resolveJudgmentConfig, disabledJudgmentConfig } from './config.js';
import type { JudgmentDefinition } from './definition.js';
import type { JudgmentAnswer } from './types.js';

const YES: JudgmentAnswer = { type: 'noul', probability: 0.95 };

interface Input {
  text: string;
}
type Decision = { permissive: boolean };

function makeDef(over: Partial<JudgmentDefinition<Input, Decision>> = {}) {
  return {
    id: 'test.judgment',
    version: 1,
    egressClass: 'work-item-text',
    direction: 'bidirectional',
    riskClass: 'seam',
    buildState: (i: Input) => ({ text: i.text }),
    questions: () => ({ q1: { type: 'noul', instructions: 'Is it fine?' } }),
    compose: (_a, _i, _t, c) => ({
      kind: 'act',
      decision: { permissive: c.permissiveAllowed },
    }),
    ...over,
  } as JudgmentDefinition<Input, Decision>;
}

function memorySink() {
  const records: JudgmentEvaluationRecord[] = [];
  const sink: JudgmentSink = { record: (r) => void records.push(r) };
  return { records, sink };
}

function cfg(spec: Record<string, unknown> = {}) {
  return resolveJudgmentConfig({ spec: { provider: 'fake', model: 'fake-1', ...spec } });
}

const enforceSpec = (extra: Record<string, unknown> = {}, model = 'fake-1') => ({
  model,
  defaults: { mode: 'shadow' },
  judgments: {
    'test.judgment': {
      mode: 'enforce',
      thresholds: { [`fake@${model}`]: { pass: 0.8 } },
      promotion: { [`fake@${model}`]: { path: 'override', evidence: 'looked at 20 items' } },
      ...extra,
    },
  },
});

function run(
  def: JudgmentDefinition<Input, Decision>,
  config: ReturnType<typeof cfg>,
  provider: FakeJudgmentProvider | undefined,
  extra: Record<string, unknown> = {},
  input: Input = { text: 'hello' },
) {
  const { records, sink } = memorySink();
  const promise = evaluateJudgment(def, input, {
    config,
    getProvider: (n) => (provider && provider.name === n ? provider : undefined),
    sinks: [sink],
    ...extra,
  });
  return promise.then((outcome) => ({ outcome, records }));
}

describe('evaluateJudgment', () => {
  it('abstains disabled with no provider configured and never calls', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    const { outcome, records } = await run(makeDef(), disabledJudgmentConfig(), p);
    expect(outcome).toEqual({ kind: 'abstain', reason: 'disabled' });
    expect(p.requests).toHaveLength(0);
    expect(records).toHaveLength(1);
  });

  it('abstains disabled when the provider is unknown, unavailable, or the mode is off', async () => {
    const p = new FakeJudgmentProvider({ available: false }).script('q1', YES);
    expect((await run(makeDef(), cfg(), p)).outcome).toEqual({
      kind: 'abstain',
      reason: 'disabled',
    });
    expect((await run(makeDef(), cfg(), undefined)).outcome).toEqual({
      kind: 'abstain',
      reason: 'disabled',
    });
    const ok = new FakeJudgmentProvider().script('q1', YES);
    expect((await run(makeDef(), cfg({ defaults: { mode: 'off' } }), ok)).outcome).toEqual({
      kind: 'abstain',
      reason: 'disabled',
    });
    expect(ok.requests).toHaveLength(0);
  });

  it('abstains disabled when isAvailable throws', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    p.isAvailable = async () => {
      throw new Error('boom');
    };
    expect((await run(makeDef(), cfg(), p)).outcome).toEqual({
      kind: 'abstain',
      reason: 'disabled',
    });
  });

  it('defaults to shadow for work-item-text: one record, abstain shadow', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    const { outcome, records } = await run(makeDef(), cfg(), p);
    expect(outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
    expect(p.requests).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0].called).toBe(true);
    expect(records[0].mode).toBe('shadow');
    expect(records[0].questionSetHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('abstains egress-not-permitted for code-diff with no call', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    const { outcome } = await run(makeDef({ egressClass: 'code-diff' }), cfg(), p);
    expect(outcome).toEqual({ kind: 'abstain', reason: 'egress-not-permitted' });
    expect(p.requests).toHaveLength(0);
  });

  it('skips the egress check for a loopback base URL', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    (p as unknown as { baseUrl: string }).baseUrl = 'http://127.0.0.1:8080';
    const { outcome } = await run(makeDef({ egressClass: 'code-diff' }), cfg(), p);
    expect(outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
    const q = new FakeJudgmentProvider().script('q1', YES);
    const config = cfg({ providerOptions: { fake: { baseUrl: 'http://localhost:9' } } });
    expect((await run(makeDef({ egressClass: 'agent-output' }), config, q)).outcome).toEqual({
      kind: 'abstain',
      reason: 'shadow',
    });
    const r = new FakeJudgmentProvider().script('q1', YES);
    (r as unknown as { baseUrl: string }).baseUrl = 'not a url';
    expect((await run(makeDef({ egressClass: 'agent-output' }), cfg(), r)).outcome).toEqual({
      kind: 'abstain',
      reason: 'egress-not-permitted',
    });
  });

  it('redacts secrets in the state before the provider call', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    const secret = 'sk-' + 'a'.repeat(30);
    await run(
      makeDef({ buildState: () => ({ text: `key ${secret}`, list: [`x ${secret}`, 3, null] }) }),
      cfg(),
      p,
    );
    const sent = JSON.stringify(p.requests[0].state);
    expect(sent).not.toContain(secret);
    expect(sent).toContain('[REDACTED:');
  });

  it('abstains state-too-large without calling or truncating', async () => {
    const p = new FakeJudgmentProvider({ capabilities: { maxStateTokens: 10 } }).script('q1', YES);
    const { outcome } = await run(makeDef(), cfg(), p, {}, { text: 'x'.repeat(500) });
    expect(outcome).toEqual({ kind: 'abstain', reason: 'state-too-large' });
    expect(p.requests).toHaveLength(0);
  });

  it('abstains provider-error on provider failure, timeout and missing answers', async () => {
    const failing = new FakeJudgmentProvider().script('q1', YES).failWith('network');
    expect((await run(makeDef(), cfg(), failing)).outcome).toEqual({
      kind: 'abstain',
      reason: 'provider-error',
    });
    const slow = new FakeJudgmentProvider().script('q1', YES);
    slow.evaluate = () => new Promise(() => undefined);
    expect((await run(makeDef(), cfg({ defaults: { timeoutMs: 5 } }), slow)).outcome).toEqual({
      kind: 'abstain',
      reason: 'provider-error',
    });
    const missing = new FakeJudgmentProvider().script('q1', YES);
    missing.evaluate = async () => ({
      answers: {},
      modelVersion: 'm',
      usage: { inputTokens: 1, outputTokens: 0 },
      latencyMs: 1,
    });
    expect((await run(makeDef(), cfg(), missing)).outcome).toEqual({
      kind: 'abstain',
      reason: 'provider-error',
    });
    const nullish = new FakeJudgmentProvider().script('q1', YES);
    nullish.evaluate = async () => null as never;
    expect((await run(makeDef(), cfg(), nullish)).outcome).toEqual({
      kind: 'abstain',
      reason: 'provider-error',
    });
  });

  it('abstains definition-error when compose, buildState or questions throw', async () => {
    const boom = () => {
      throw new Error('bad');
    };
    for (const over of [{ compose: boom }, { buildState: boom }, { questions: boom }]) {
      const p = new FakeJudgmentProvider().script('q1', YES);
      const { outcome } = await run(
        makeDef(over as Partial<JudgmentDefinition<Input, Decision>>),
        cfg(enforceSpec()),
        p,
      );
      expect(outcome).toEqual({ kind: 'abstain', reason: 'definition-error' });
    }
  });

  it('enforce returns the composed outcome', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    const { outcome, records } = await run(makeDef(), cfg(enforceSpec()), p, {
      sourceKind: 'backlog',
    });
    expect(outcome).toEqual({ kind: 'act', decision: { permissive: true } });
    expect(records[0].thresholds).toEqual({ pass: 0.8 });
    expect(records[0].downgradeReason).toBeUndefined();
  });

  describe('enforce downgrade', () => {
    async function downgraded(
      config: ReturnType<typeof cfg>,
      provider = new FakeJudgmentProvider().script('q1', YES),
      def = makeDef(),
    ) {
      const { outcome, records } = await run(def, config, provider);
      expect(outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
      expect(provider.requests).toHaveLength(1);
      expect(records[0].configuredMode).toBe('enforce');
      expect(records[0].mode).toBe('shadow');
      return records[0].downgradeReason;
    }

    it('alias model', async () => {
      const spec = enforceSpec({}, 'fake-latest');
      const p = new FakeJudgmentProvider({ modelId: 'fake-latest' }).script('q1', YES);
      expect(await downgraded(cfg(spec), p)).toBe('model-alias');
      const spec2 = enforceSpec({}, 'fake-preview');
      expect(await downgraded(cfg(spec2))).toBe('model-alias');
    });

    it('uncalibrated provider', async () => {
      const p = new FakeJudgmentProvider({
        capabilities: { calibratedProbabilities: false },
      }).script('q1', YES);
      expect(await downgraded(cfg(enforceSpec()), p)).toBe('uncalibrated-provider');
    });

    it('no thresholds for the active key', async () => {
      const spec = enforceSpec({ thresholds: { 'other@x': { pass: 1 } } });
      expect(await downgraded(cfg(spec))).toBe('no-thresholds');
    });

    it('no satisfying promotion record', async () => {
      expect(await downgraded(cfg(enforceSpec({ promotion: {} })))).toBe('no-promotion');
    });

    it('relax is not enforced via override, low n or low precision', async () => {
      const relax = makeDef({ riskClass: 'relax' });
      const k = 'fake@fake-1';
      for (const rec of [
        { path: 'override', evidence: 'looked' },
        { path: 'corpus', n: 49, actBandPrecision: 0.99 },
        { path: 'corpus', n: 80, actBandPrecision: 0.94 },
      ]) {
        const spec = enforceSpec({ promotion: { [k]: rec } });
        expect(await downgraded(cfg(spec), undefined, relax)).toBe('no-promotion');
      }
    });

    it('relax is enforced with a qualifying corpus record; seam with override evidence', async () => {
      const k = 'fake@fake-1';
      const relax = makeDef({ riskClass: 'relax' });
      const good = enforceSpec({
        promotion: { [k]: { path: 'corpus', n: 50, actBandPrecision: 0.95 } },
      });
      const p = new FakeJudgmentProvider().script('q1', YES);
      expect((await run(relax, cfg(good), p)).outcome.kind).toBe('act');
      const p2 = new FakeJudgmentProvider().script('q1', YES);
      expect((await run(makeDef(), cfg(enforceSpec()), p2)).outcome.kind).toBe('act');
    });
  });

  it('promotionSatisfies handles each bar', () => {
    expect(promotionSatisfies('seam', undefined)).toBe(false);
    expect(promotionSatisfies('seam', { path: 'override', evidence: '  ' })).toBe(false);
    expect(promotionSatisfies('tighten', { path: 'corpus', n: 50, actBandPrecision: 0.9 })).toBe(
      true,
    );
    expect(promotionSatisfies('tighten', { path: 'corpus', n: 50 })).toBe(false);
    expect(promotionSatisfies('seam', { path: 'x' } as never)).toBe(false);
  });

  describe('permissiveAllowed', () => {
    const cases: Array<
      [string, Partial<JudgmentDefinition<Input, Decision>>, string | undefined, boolean]
    > = [
      ['bidirectional + backlog', {}, 'backlog', true],
      ['bidirectional + gh-issue', {}, 'gh-issue', false],
      ['bidirectional + absent', {}, undefined, false],
      ['tighten-only + backlog', { direction: 'tighten-only' }, 'backlog', false],
    ];
    for (const [name, over, sourceKind, expected] of cases) {
      it(name, async () => {
        const p = new FakeJudgmentProvider().script('q1', YES);
        const { outcome } = await run(makeDef(over), cfg(enforceSpec()), p, { sourceKind });
        expect(outcome).toEqual({ kind: 'act', decision: { permissive: expected } });
      });
    }

    it('passes agrees and capabilityId through to compose', async () => {
      let seen: unknown;
      const def = makeDef({
        capabilityId: 'cap.x',
        agrees: () => true,
        compose: (_a, _i, _t, c) => {
          seen = c;
          return { kind: 'abstain', reason: 'nope' };
        },
      });
      const p = new FakeJudgmentProvider().script('q1', YES);
      await run(def, cfg(enforceSpec()), p);
      expect((seen as { capabilityId: string }).capabilityId).toBe('cap.x');
      expect(typeof (seen as { agrees: unknown }).agrees).toBe('function');
    });
  });

  describe('onCapabilityOutcome', () => {
    function collect() {
      const calls: Array<{ capabilityId: string; outcome: string; reason?: string }> = [];
      return { calls, onCapabilityOutcome: (r: (typeof calls)[number]) => void calls.push(r) };
    }

    it('reports live for enforce act', async () => {
      const c = collect();
      const p = new FakeJudgmentProvider().script('q1', YES);
      await run(makeDef({ capabilityId: 'cap.x' }), cfg(enforceSpec()), p, c);
      expect(c.calls).toEqual([{ capabilityId: 'cap.x', outcome: 'live' }]);
    });

    it('reports shadow when the provider answered in shadow', async () => {
      const c = collect();
      const p = new FakeJudgmentProvider().script('q1', YES);
      await run(makeDef({ capabilityId: 'cap.x' }), cfg(), p, c);
      expect(c.calls).toEqual([{ capabilityId: 'cap.x', outcome: 'shadow' }]);
    });

    it('reports degraded with the abstain reason', async () => {
      const c = collect();
      await run(makeDef({ capabilityId: 'cap.x' }), disabledJudgmentConfig(), undefined, c);
      expect(c.calls).toEqual([{ capabilityId: 'cap.x', outcome: 'degraded', reason: 'disabled' }]);
    });

    it('is not called without a capabilityId, and a throw does not change the result', async () => {
      const c = collect();
      const p = new FakeJudgmentProvider().script('q1', YES);
      await run(makeDef(), cfg(), p, c);
      expect(c.calls).toHaveLength(0);
      const p2 = new FakeJudgmentProvider().script('q1', YES);
      const { outcome } = await run(makeDef({ capabilityId: 'cap.x' }), cfg(enforceSpec()), p2, {
        onCapabilityOutcome: () => {
          throw new Error('cb');
        },
      });
      expect(outcome.kind).toBe('act');
    });
  });

  it('a throwing sink does not change the result; taskId lands on the record', async () => {
    const p = new FakeJudgmentProvider().script('q1', YES);
    const { records, sink } = memorySink();
    const outcome = await evaluateJudgment(
      makeDef(),
      { text: 'hi' },
      {
        config: cfg(),
        getProvider: () => p,
        taskId: 'T-1',
        sinks: [
          {
            record: () => {
              throw new Error('sink');
            },
          },
          sink,
        ],
      },
    );
    expect(outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
    expect(records[0].taskId).toBe('T-1');
  });

  it('uses the registered-provider registry by default and never throws', async () => {
    const outcome = await evaluateJudgment(makeDef(), { text: 'x' }, { config: cfg() });
    expect(outcome).toEqual({ kind: 'abstain', reason: 'disabled' });
  });
});
