/**
 * Matrix proving the relax half (`dor.stage-b-pass`) can only act on trusted backlog work,
 * never relaxes a Stage A failure, and leaves the tighten half's rules intact.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FakeJudgmentProvider,
  registerJudgmentDefinition,
  resolveJudgmentConfig,
  validateJudgmentDefinitionSafety,
  type JudgmentAnswer,
  type JudgmentDefinition,
} from '@ai-sdlc/reference';
import type { DorJudgmentInput } from './stage-b-judgment.js';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import type { GateConfidence, GateEvaluation, GateId, IssueInput, StageAVerdict } from './types.js';

type StageAKind = 'pass' | 'fail-high' | 'fail-medium' | 'fail-low';
let stageAKind: StageAKind = 'pass';

vi.mock('./evaluate.js', () => ({
  evaluateIssue: async (input: IssueInput): Promise<StageAVerdict> => {
    const gates: GateEvaluation[] = ([1, 2, 3, 4, 5, 6, 7] as GateId[]).map((gateId) => {
      const owned = gateId === 4 || gateId === 6;
      let verdict: GateEvaluation['verdict'] = owned ? 'skip' : 'pass';
      let confidence: GateConfidence = owned ? 'low' : gateId === 1 ? 'medium' : 'high';
      if (gateId === 2 && stageAKind !== 'pass') {
        verdict = 'fail';
        confidence = stageAKind.replace('fail-', '') as GateConfidence;
      }
      return { gateId, verdict, confidence, severity: 'block', stage: 'A' };
    });
    const failing = gates.some((g) => g.verdict === 'fail');
    return {
      issueId: input.id,
      rubricVersion: 'v1',
      overallVerdict: failing ? 'needs-clarification' : 'admit',
      gates,
      signedAt: '2026-10-01T00:00:00.000Z',
      evaluatorVersion: 'test',
      summary: 'stage a',
      questions: [],
      overallConfidence: 'medium',
      durationMs: 1,
    } as StageAVerdict;
  },
}));

const { evaluateIssueE2EDetailed } = await import('./composite.js');
const { dorStageBPassJudgment, dorStageBJudgment, templatedClarification, ALL_GATES_PASS } =
  await import('./stage-b-judgment.js');

const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const KEY = 'fake@fake-1';

type Mode = 'disabled' | 'shadow' | 'enforce' | 'enforce-no-promotion';

function config(mode: Mode) {
  if (mode === 'disabled') return resolveJudgmentConfig({});
  const m = mode === 'shadow' ? 'shadow' : 'enforce';
  return resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow' },
      judgments: {
        'dor.stage-b': {
          mode: m,
          thresholds: { [KEY]: { pass: 0.8, fail: 0.2 } },
          promotion: { [KEY]: { path: 'override', evidence: 'sampled' } },
        },
        'dor.stage-b-pass': {
          mode: m,
          thresholds: { [KEY]: { pass: 0.8 } },
          promotion:
            mode === 'enforce-no-promotion'
              ? {}
              : { [KEY]: { path: 'corpus', n: 50, actBandPrecision: 0.96 } },
        },
      },
    },
  });
}

type Judged = 'all-pass' | 'one-fail' | 'unsure';
function provider(j: Judged) {
  const p = new FakeJudgmentProvider();
  for (const id of [1, 2, 3, 4, 5, 6, 7] as GateId[]) {
    const prob = j === 'all-pass' ? 0.99 : j === 'unsure' ? 0.5 : id === 4 ? 0.01 : 0.99;
    p.script(`gate-${id}`, noul(prob));
  }
  return p;
}

const SPAWNER_OUT = JSON.stringify({
  gates: [
    { gateId: 4, verdict: 'pass', confidence: 'high', finding: 'ok' },
    { gateId: 6, verdict: 'pass', confidence: 'high', finding: 'ok' },
  ],
});
const spawner = () =>
  new MockSpawner({
    'refinement-reviewer': {
      type: 'refinement-reviewer',
      output: SPAWNER_OUT,
      status: 'success',
      durationMs: 1,
    },
  });

describe('relax path matrix', () => {
  const sources = ['backlog', 'github'] as const;
  const kinds: StageAKind[] = ['pass', 'fail-high', 'fail-medium', 'fail-low'];
  const judgeds: Judged[] = ['all-pass', 'one-fail', 'unsure'];
  const modes: Mode[] = ['disabled', 'shadow', 'enforce', 'enforce-no-promotion'];

  for (const source of sources)
    for (const withSpawner of [true, false])
      for (const kind of kinds)
        for (const judged of judgeds)
          for (const mode of modes) {
            const name = `${source} spawner=${withSpawner} stageA=${kind} judged=${judged} mode=${mode}`;
            it(name, async () => {
              stageAKind = kind;
              const input: IssueInput = { source, id: 'T-1', title: 't', body: 'b' };
              const p = provider(judged);
              const sp = spawner();
              const ctx = { config: config(mode), getProvider: () => p };
              const baseline = await evaluateIssueE2EDetailed(input, {
                ...(withSpawner ? { stageB: { spawner: spawner() } } : {}),
              });
              const r = await evaluateIssueE2EDetailed(input, {
                ...(withSpawner ? { stageB: { spawner: sp } } : {}),
                judgment: { context: ctx },
              });
              const live = mode === 'enforce';
              const stageAFails = kind !== 'pass';

              // The relax path acts only for backlog work, in enforce with promotion, with
              // no Stage A failure and every gate passing.
              const relaxActs =
                live && source === 'backlog' && !stageAFails && judged === 'all-pass';
              expect(sp.getCallCount('refinement-reviewer')).toBe(
                withSpawner ? (relaxActs ? 0 : 1) : 0,
              );

              // A Stage A failure is preserved exactly, at any confidence.
              for (const g of baseline.verdict.gates.filter(
                (x) => x.verdict === 'fail' && x.stage === 'A',
              )) {
                expect(r.verdict.gates.find((x) => x.gateId === g.gateId)).toEqual(g);
              }
              if (stageAFails) expect(r.verdict.overallVerdict).toBe('needs-clarification');

              // Untrusted work: no judged pass anywhere, and a judged fail is the only change.
              if (source !== 'backlog') {
                const judgedPass = r.verdict.gates.filter(
                  (x) => x.stage === 'B' && x.finding?.includes('answered yes'),
                );
                expect(judgedPass).toEqual([]);
              }

              // Shadow, disabled and an unpromoted enforce change nothing.
              if (!live && mode !== 'enforce-no-promotion') {
                expect(r.verdict.gates).toEqual(baseline.verdict.gates);
                expect(r.stageBSource).toBe(withSpawner ? 'subagent' : 'none');
              }
              // No gate is ever relaxed: every baseline fail stays a fail.
              for (const g of baseline.verdict.gates.filter((x) => x.verdict === 'fail')) {
                expect(r.verdict.gates.find((x) => x.gateId === g.gateId)?.verdict).toBe('fail');
              }
              // A judged fail (tighten half) adds the templated failure in enforce.
              if (live && !stageAFails && judged === 'one-fail') {
                const g4 = r.verdict.gates.find((x) => x.gateId === 4)!;
                expect(g4.verdict).toBe('fail');
                expect(g4.clarificationQuestion).toBe(templatedClarification(4));
              }
              if (relaxActs) {
                expect(r.stageBSource).toBe('judgment');
                expect(r.verdict.gates.find((x) => x.gateId === 4)!.verdict).toBe('pass');
                expect(r.verdict.overallVerdict).toBe('admit');
              }
            });
          }
});

describe('dor.stage-b-pass declaration', () => {
  it('conforms to the registration-time rules', () => {
    expect(validateJudgmentDefinitionSafety(dorStageBPassJudgment)).toBeUndefined();
    expect(dorStageBPassJudgment).toMatchObject({
      egressClass: 'work-item-text',
      riskClass: 'relax',
      direction: 'bidirectional',
      reducesReview: true,
      reducingOutcomes: [ALL_GATES_PASS],
      capabilityId: 'dor.stage-b',
    });
  });

  it('rejects variants that break rules (c) and (d)', () => {
    const variants: Partial<JudgmentDefinition<never, never>>[] = [
      { riskClass: 'tighten' },
      { riskClass: 'seam', fallback: 'pending' },
      { reducesReview: false },
      { reducesReview: undefined },
    ];
    for (const v of variants) {
      expect(
        validateJudgmentDefinitionSafety({ ...dorStageBPassJudgment, ...v } as never),
      ).toBeDefined();
    }
    expect(
      validateJudgmentDefinitionSafety({ ...dorStageBJudgment, reducesReview: true } as never),
    ).toBeDefined();
  });

  it('registers (and a duplicate is rejected)', () => {
    registerJudgmentDefinition({ ...dorStageBPassJudgment, id: 'dor.stage-b-pass.reg-test' });
    expect(() =>
      registerJudgmentDefinition({ ...dorStageBPassJudgment, id: 'dor.stage-b-pass.reg-test' }),
    ).toThrow(/already registered/);
  });
});

describe('dor.stage-b-pass compose', () => {
  const input: DorJudgmentInput = {
    title: 't',
    body: 'b',
    references: [],
    gateIds: [4, 6] as GateId[],
  };
  const answers = { 'gate-4': noul(0.9), 'gate-6': noul(0.9) };
  const t = { pass: 0.8 };

  it('acts only with every gate passing on trusted work and no Stage A failure', () => {
    expect(dorStageBPassJudgment.compose(answers, input, t, { permissiveAllowed: true })).toEqual({
      kind: 'act',
      decision: { outcome: 'all-gates-pass', gates: { '4': 'pass', '6': 'pass' } },
    });
  });

  it('escalates for an untrusted source, a Stage A failure, a non-passing gate or no gates', () => {
    const c = (i = input, a = answers, perm = true) =>
      dorStageBPassJudgment.compose(a, i, t, { permissiveAllowed: perm });
    expect(c(input, answers, false)).toMatchObject({
      kind: 'escalate',
      reason: 'untrusted-source',
    });
    expect(c({ ...input, stageAFail: true })).toMatchObject({ reason: 'stage-a-failure' });
    expect(c(input, { ...answers, 'gate-6': noul(0.5) })).toMatchObject({
      reason: 'not-all-gates-pass',
    });
    expect(c(input, { ...answers, 'gate-6': noul(0.0) })).toMatchObject({ kind: 'escalate' });
    expect(c({ ...input, gateIds: [] })).toMatchObject({ kind: 'escalate' });
  });

  it('abstains without a usable pass threshold; agrees only when every gate is expected to pass', () => {
    expect(dorStageBPassJudgment.compose(answers, input, {}, { permissiveAllowed: true })).toEqual({
      kind: 'abstain',
      reason: 'no-thresholds',
    });
    const agrees = dorStageBPassJudgment.agrees!;
    const d = { outcome: 'all-gates-pass' as const, gates: { '4': 'pass', '6': 'pass' } as never };
    expect(agrees(d, { '4': 'pass', '6': 'pass' })).toBe(true);
    expect(agrees(d, { '4': 'pass', '6': 'fail' })).toBe(false);
    expect(agrees(d, { '4': 'pass' })).toBe(false);
    expect(agrees(d, undefined)).toBe(false);
    expect(agrees({ outcome: 'all-gates-pass', gates: {} }, {})).toBe(false);
  });

  it('never produces an act other than all-gates-pass (exhaustive over answers and flags)', () => {
    const probs = [0, 0.5, 0.79, 0.8, 1];
    for (const a of probs)
      for (const b of probs)
        for (const perm of [true, false])
          for (const fail of [true, false, undefined]) {
            const out = dorStageBPassJudgment.compose(
              { 'gate-4': noul(a), 'gate-6': noul(b) },
              { ...input, stageAFail: fail },
              t,
              { permissiveAllowed: perm },
            );
            if (out.kind === 'act') {
              expect(out.decision.outcome).toBe('all-gates-pass');
              expect(perm && !fail && a >= 0.8 && b >= 0.8).toBe(true);
            }
          }
  });
});
