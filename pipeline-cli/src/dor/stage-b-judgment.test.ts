import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  getJudgmentDefinition,
  resolveJudgmentConfig,
  validateJudgmentDefinitionSafety,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import { runJudgmentCli } from '../cli/judgment.js';
import { evaluateIssueE2E, evaluateIssueE2EDetailed } from './composite.js';
import {
  applyJudgedGates,
  buildDorJudgmentInput,
  dorStageBJudgment,
  gateQuestionStem,
  judgedGatesOf,
  judgmentSourceKind,
  registerDorStageBJudgment,
  templatedClarification,
  type DorJudgmentDecision,
  type JudgedGateResult,
} from './stage-b-judgment.js';
import { dorCorpusToEvalJsonl, dorCorpusToJudgmentItems } from './stage-b-judgment-corpus.js';
import { STAGE_B_GATE_QUESTIONS } from './stage-b.js';
import type { GateEvaluation, GateId, IssueInput } from './types.js';

const THRESHOLDS = { pass: 0.8, fail: 0.2 };
const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });

const BODY = [
  '## Description',
  'Add a new flag to `pipeline-cli/src/cli/index.ts`.',
  '',
  '## Acceptance Criteria',
  '- [ ] #1 `pipeline-cli/src/cli/index.ts` accepts the flag',
  '- [ ] #2 README documents the flag',
].join('\n');

function issue(source: IssueInput['source'] = 'backlog'): IssueInput {
  return { source, id: 'T-1', title: 'Add CLI flag', body: BODY };
}

function config(mode: 'enforce' | 'shadow' | 'off' = 'enforce') {
  return resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow' },
      judgments: {
        'dor.stage-b': {
          mode,
          thresholds: { 'fake@fake-1': THRESHOLDS },
          promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed a sample' } },
        },
      },
    },
  });
}

function provider(probs: Partial<Record<GateId, number>>, fallbackP = 0.5) {
  const p = new FakeJudgmentProvider();
  for (const id of [1, 2, 3, 4, 5, 6, 7] as GateId[]) {
    p.script(`gate-${id}`, noul(probs[id] ?? fallbackP));
  }
  return p;
}

/** Verdicts differ only in the signing time between two runs. */
const same = (a: unknown, b: unknown): void => {
  const norm = (v: unknown) => ({ ...(v as object), signedAt: 'x' });
  expect(norm(a)).toEqual(norm(b));
};

function judgment(p: FakeJudgmentProvider, mode: 'enforce' | 'shadow' | 'off' = 'enforce') {
  return { context: { config: config(mode), getProvider: () => p } };
}

const SPAWNER_PASS = JSON.stringify({
  gates: [
    { gateId: 4, verdict: 'pass', confidence: 'high', finding: 'ok' },
    { gateId: 6, verdict: 'pass', confidence: 'high', finding: 'ok' },
  ],
});

function spawner(output = SPAWNER_PASS) {
  return new MockSpawner({
    'refinement-reviewer': {
      type: 'refinement-reviewer',
      output,
      status: 'success',
      durationMs: 1,
    },
  });
}

describe('dor.stage-b definition', () => {
  it('passes the registration-time safety rules and is tighten-only', () => {
    expect(validateJudgmentDefinitionSafety(dorStageBJudgment)).toBeUndefined();
    expect(dorStageBJudgment).toMatchObject({
      egressClass: 'work-item-text',
      riskClass: 'tighten',
      direction: 'tighten-only',
      reducesReview: false,
      capabilityId: 'dor.stage-b',
    });
  });

  it('registers both definitions once and is idempotent', () => {
    registerDorStageBJudgment();
    registerDorStageBJudgment();
    expect(getJudgmentDefinition('dor.stage-b')?.id).toBe('dor.stage-b');
    expect(getJudgmentDefinition('dor.stage-b-pass')?.id).toBe('dor.stage-b-pass');
  });

  it('asks one noul per requested gate with literal true/false criteria', () => {
    const q = dorStageBJudgment.questions({
      title: 't',
      body: 'b',
      references: [],
      gateIds: [4, 6],
    });
    expect(Object.keys(q)).toEqual(['gate-4', 'gate-6']);
    const q4 = q['gate-4'];
    expect(q4.type).toBe('noul');
    if (q4.type === 'noul') {
      expect(q4.criteria?.true).toBe('fits one PR');
      expect(q4.criteria?.false).toContain('split into multiple issues');
      expect(String(q4.instructions)).not.toContain('(yes =');
    }
  });

  it('ignores unknown gate ids and handles a question without an answer key', () => {
    const q = dorStageBJudgment.questions({
      title: 't',
      body: 'b',
      references: [],
      gateIds: [4, 99 as GateId],
    });
    expect(Object.keys(q)).toEqual(['gate-4']);
    expect(gateQuestionStem(1)).not.toContain('(yes');
  });

  it('state carries only title, body and references', () => {
    const state = dorStageBJudgment.buildState({
      title: 't',
      body: 'b',
      references: ['r'],
      gateIds: [4],
    });
    expect(state).toEqual({ title: 't', body: 'b', references: ['r'] });
  });

  it('classifies per gate by threshold and escalates when nothing fails', () => {
    const input = { title: 't', body: 'b', references: [], gateIds: [4, 6, 5] as GateId[] };
    const answers = { 'gate-4': noul(0.9), 'gate-6': noul(0.5), 'gate-5': noul(0.1) };
    const out = dorStageBJudgment.compose(answers, input, THRESHOLDS, { permissiveAllowed: false });
    expect(out).toEqual({
      kind: 'act',
      decision: { gates: { '4': 'pass', '6': 'unsure', '5': 'fail' } },
    });
    const none = dorStageBJudgment.compose(
      { 'gate-4': noul(0.9), 'gate-6': noul(0.5) },
      { ...input, gateIds: [4, 6] },
      THRESHOLDS,
      { permissiveAllowed: true },
    );
    expect(none).toMatchObject({ kind: 'escalate', to: 'llm' });
    expect(judgedGatesOf(none as never)).toEqual({ '4': 'pass', '6': 'unsure' });
  });

  it('boundaries are inclusive and missing answers are unsure', () => {
    const input = { title: 't', body: 'b', references: [], gateIds: [4, 6, 5] as GateId[] };
    const out = dorStageBJudgment.compose(
      { 'gate-4': noul(0.8), 'gate-6': noul(0.2) },
      input,
      THRESHOLDS,
      { permissiveAllowed: false },
    );
    expect(judgedGatesOf(out as never)).toEqual({ '4': 'pass', '6': 'fail', '5': 'unsure' });
  });

  it('abstains without usable thresholds', () => {
    const input = { title: 't', body: 'b', references: [], gateIds: [4] as GateId[] };
    expect(
      dorStageBJudgment.compose({ 'gate-4': noul(1) }, input, {}, { permissiveAllowed: false }),
    ).toEqual({ kind: 'abstain', reason: 'no-thresholds' });
    expect(judgedGatesOf({ kind: 'abstain' })).toBeUndefined();
  });

  it('agrees compares non-unsure results with the label', () => {
    const agrees = dorStageBJudgment.agrees!;
    expect(agrees({ gates: { '4': 'fail' } }, { '4': 'fail', '6': 'pass' })).toBe(true);
    expect(agrees({ gates: { '4': 'fail', '6': 'unsure' } }, { '4': 'fail' })).toBe(true);
    expect(agrees({ gates: { '4': 'fail' } }, { '4': 'pass' })).toBe(false);
    expect(agrees({ gates: { '4': 'fail' } }, {})).toBe(false);
    expect(agrees({ gates: { '4': 'unsure' } }, { '4': 'pass' })).toBe(false);
    expect(agrees({ gates: { '4': 'fail' } }, undefined)).toBe(false);
  });

  it('maps issue sources to judgment source kinds', () => {
    expect(judgmentSourceKind('github')).toBe('gh-issue');
    expect(judgmentSourceKind('backlog')).toBe('backlog');
  });

  it('templates a clarification from the gate question without internal ids', () => {
    for (const id of [1, 2, 3, 4, 5, 6, 7] as GateId[]) {
      const q = templatedClarification(id);
      expect(q).toContain(`Gate ${id}`);
      expect(q).not.toMatch(/AISDLC-\d+/);
      expect(STAGE_B_GATE_QUESTIONS[id]).toContain(gateQuestionStem(id));
    }
  });
});

function g(
  id: GateId,
  verdict: GateEvaluation['verdict'],
  confidence: GateEvaluation['confidence'] = 'high',
  severity: GateEvaluation['severity'] = 'block',
  stage: GateEvaluation['stage'] = 'A',
  finding?: string,
): GateEvaluation {
  return { gateId: id, verdict, confidence, severity, stage, ...(finding ? { finding } : {}) };
}

describe('applyJudgedGates (tighten-only by construction)', () => {
  const verdicts: GateEvaluation['verdict'][] = ['pass', 'fail', 'skip'];
  const confidences: GateEvaluation['confidence'][] = ['high', 'medium', 'low'];
  const severities: GateEvaluation['severity'][] = ['block', 'warn'];
  const results: (JudgedGateResult | undefined)[] = ['pass', 'fail', 'unsure', undefined];

  it('never removes a failure, never replaces a pass, only fills skip with pass', () => {
    for (const verdict of verdicts)
      for (const confidence of confidences)
        for (const severity of severities)
          for (const stage of ['A', 'B'] as const)
            for (const r of results)
              for (const fillPass of [true, false]) {
                const before = g(4, verdict, confidence, severity, stage);
                const judged = r ? ({ '4': r } as DorJudgmentDecision['gates']) : {};
                const { gates } = applyJudgedGates([before], judged, { fillPass });
                const after = gates[0];
                if (verdict === 'fail') expect(after).toBe(before);
                if (verdict === 'pass') {
                  expect(after.verdict === 'pass' || after.verdict === 'fail').toBe(true);
                  if (r !== 'fail') expect(after).toBe(before);
                }
                if (after.verdict === 'pass' && verdict !== 'pass') {
                  expect(verdict).toBe('skip');
                  expect(fillPass).toBe(true);
                  expect(r).toBe('pass');
                }
                if (r === 'unsure' || r === undefined) expect(after).toBe(before);
                if (r === 'fail' && verdict !== 'fail') {
                  expect(after).toMatchObject({ verdict: 'fail', severity: 'block', stage: 'B' });
                  expect(after.clarificationQuestion).toBe(templatedClarification(4));
                }
              }
  });

  it('does not fill an auto-passed skip gate', () => {
    const skipped = g(4, 'skip', 'low', 'block', 'A', 'auto-pass: docs-only');
    const out = applyJudgedGates([skipped], { '4': 'pass' }, { fillPass: true });
    expect(out.gates[0]).toBe(skipped);
    expect(out.changed).toEqual([]);
  });

  it('reports which gates changed', () => {
    const out = applyJudgedGates(
      [g(1, 'pass', 'medium'), g(4, 'skip', 'low'), g(6, 'skip', 'low')],
      { '1': 'fail', '4': 'pass', '6': 'unsure' },
      { fillPass: true },
    );
    expect(out.changed).toEqual([1, 4]);
  });
});

describe('evaluateIssueE2E with the judgment', () => {
  it('layer off or shadow: identical to before, with and without a spawner', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      const p = provider({ 4: 0.01, 6: 0.01 });
      const baseNo = await evaluateIssueE2E(issue());
      const withNo = await evaluateIssueE2E(issue(), { judgment: judgment(p, mode) });
      same(withNo, baseNo);
      const baseSp = await evaluateIssueE2E(issue(), { stageB: { spawner: spawner() } });
      const withSp = await evaluateIssueE2E(issue(), {
        stageB: { spawner: spawner() },
        judgment: judgment(p, mode),
      });
      same(withSp, baseSp);
    }
  });

  it('disabled config and no gates to ask abstain to the existing path', async () => {
    const off = { context: { config: resolveJudgmentConfig({}) } };
    same(await evaluateIssueE2E(issue(), { judgment: off }), await evaluateIssueE2E(issue()));
    const r = await evaluateIssueE2EDetailed(issue(), { judgment: off });
    expect(r.stageBSource).toBe('none');
  });

  it('asks all Stage B gates in a single provider request per judgment', async () => {
    const p = provider({ 4: 0.9, 6: 0.9 });
    // the relax judgment is off here, so only the tighten judgment reaches the provider
    const cfg = config();
    cfg.judgments['dor.stage-b-pass'] = { mode: 'off', thresholds: {}, promotion: {} };
    await evaluateIssueE2E(issue(), {
      judgment: { context: { config: cfg, getProvider: () => p } },
    });
    expect(p.requests).toHaveLength(1);
    expect(Object.keys(p.requests[0].questions)).toEqual(
      expect.arrayContaining(['gate-4', 'gate-6']),
    );
    expect(p.requests[0].state).toEqual({ title: 'Add CLI flag', body: BODY, references: [] });
  });

  it('no spawner, a failing gate: needs-clarification with a templated question (both source kinds)', async () => {
    for (const source of ['backlog', 'github'] as const) {
      const p = provider({ 4: 0.05, 6: 0.9 });
      const r = await evaluateIssueE2EDetailed(issue(source), { judgment: judgment(p) });
      expect(r.stageBSource).toBe('judgment');
      expect(r.verdict.overallVerdict).toBe('needs-clarification');
      const g4 = r.verdict.gates.find((x) => x.gateId === 4)!;
      expect(g4.verdict).toBe('fail');
      expect(g4.clarificationQuestion).toBe(templatedClarification(4));
      expect(r.verdict.questions).toContain(templatedClarification(4));
    }
  });

  it('no spawner, unsure gate stays skip and the verdict matches Stage A', async () => {
    const p = provider({ 4: 0.5, 6: 0.5 });
    const r = await evaluateIssueE2EDetailed(issue(), { judgment: judgment(p) });
    expect(r.stageBSource).toBe('none');
    same(r.verdict, await evaluateIssueE2E(issue()));
    expect(r.verdict.gates.find((x) => x.gateId === 4)!.verdict).toBe('skip');
  });

  it('no spawner, backlog: a judged pass fills a skip gate', async () => {
    const p = provider({ 4: 0.95, 6: 0.95 });
    const r = await evaluateIssueE2EDetailed(issue('backlog'), { judgment: judgment(p) });
    expect(r.stageBSource).toBe('judgment');
    const g4 = r.verdict.gates.find((x) => x.gateId === 4)!;
    expect(g4).toMatchObject({ verdict: 'pass', stage: 'B' });
    expect(r.verdict.overallVerdict).toBe('admit');
  });

  it('gh-issue never gets a judged pass', async () => {
    const p = provider({ 4: 0.95, 6: 0.95 });
    const r = await evaluateIssueE2EDetailed(issue('github'), { judgment: judgment(p) });
    expect(r.stageBSource).toBe('none');
    same(r.verdict, await evaluateIssueE2E(issue('github')));
    expect(r.verdict.gates.find((x) => x.gateId === 4)!.verdict).toBe('skip');
  });

  it('a judged pass never overrides a Stage A fail of any confidence', async () => {
    const body = ['## Description', 'TBD', '', 'Do the thing.'].join('\n');
    const bad: IssueInput = { source: 'backlog', id: 'T-2', title: 'Thing', body };
    const baseline = await evaluateIssueE2E(bad);
    const failedBefore = baseline.gates.filter((x) => x.verdict === 'fail').map((x) => x.gateId);
    expect(failedBefore.length).toBeGreaterThan(0);
    const p = provider({}, 0.99);
    const r = await evaluateIssueE2E(bad, { judgment: judgment(p) });
    for (const gate of baseline.gates.filter((x) => x.verdict === 'fail')) {
      expect(r.gates.find((x) => x.gateId === gate.gateId)).toEqual(gate);
    }
    expect(r.overallVerdict).toBe('needs-clarification');
  });

  it('a supplied spawner always runs, whatever the judgment says', async () => {
    for (const probs of [
      { 4: 0.99, 6: 0.99 },
      { 4: 0.5, 6: 0.5 },
      { 4: 0.01, 6: 0.99 },
    ]) {
      const sp = spawner();
      const p = provider(probs);
      await evaluateIssueE2E(issue(), { stageB: { spawner: sp }, judgment: judgment(p) });
      expect(sp.getCallCount('refinement-reviewer')).toBe(1);
    }
  });

  it('with a spawner, a judged fail only adds a failure', async () => {
    const p = provider({ 4: 0.01, 6: 0.99 });
    const r = await evaluateIssueE2EDetailed(issue(), {
      stageB: { spawner: spawner() },
      judgment: judgment(p),
    });
    expect(r.stageBSource).toBe('judgment+subagent');
    expect(r.verdict.gates.find((x) => x.gateId === 4)!.verdict).toBe('fail');
    expect(r.verdict.gates.find((x) => x.gateId === 6)!.verdict).toBe('pass');
    expect(r.verdict.overallVerdict).toBe('needs-clarification');
  });

  it('with a spawner, a subagent failure survives a judged pass', async () => {
    const failing = JSON.stringify({
      gates: [
        {
          gateId: 4,
          verdict: 'fail',
          confidence: 'high',
          finding: 'too big',
          clarificationQuestion: 'Split it?',
        },
        { gateId: 6, verdict: 'pass', confidence: 'high', finding: 'ok' },
      ],
    });
    const p = provider({ 4: 0.99, 6: 0.99 });
    const r = await evaluateIssueE2EDetailed(issue(), {
      stageB: { spawner: spawner(failing) },
      judgment: judgment(p),
    });
    expect(r.stageBSource).toBe('subagent');
    const g4 = r.verdict.gates.find((x) => x.gateId === 4)!;
    expect(g4.verdict).toBe('fail');
    expect(g4.clarificationQuestion).toBe('Split it?');
    same(r.verdict, await evaluateIssueE2E(issue(), { stageB: { spawner: spawner(failing) } }));
  });

  it('records the subagent source when only the spawner is used', async () => {
    const r = await evaluateIssueE2EDetailed(issue(), { stageB: { spawner: spawner() } });
    expect(r.stageBSource).toBe('subagent');
  });

  it('buildDorJudgmentInput carries the references and the picked gates', async () => {
    const i = { ...issue(), references: ['RFC-0049'] };
    const { evaluateIssue } = await import('./evaluate.js');
    const input = buildDorJudgmentInput(i, await evaluateIssue(i, { hermetic: true }));
    expect(input.references).toEqual(['RFC-0049']);
    expect(input.gateIds).toEqual(expect.arrayContaining([4, 6]));
  });
});

describe('dor corpus converter and cli-judgment eval', () => {
  const root = join(process.cwd(), '..', 'spec', 'dor-corpus');

  it('produces labelled items for the Stage B gates', async () => {
    const items = await dorCorpusToJudgmentItems(root);
    expect(items.length).toBeGreaterThan(30);
    const unbounded = items.find((i) => i.input.title.includes('huge multi pr'));
    expect(unbounded?.label['4']).toBe('fail');
    const jsonl = await dorCorpusToEvalJsonl(root);
    expect(jsonl.trim().split('\n')).toHaveLength(items.length);
    expect(JSON.parse(jsonl.split('\n')[0])).toHaveProperty('label');
  });

  it('returns an empty string for an empty corpus', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dor-empty-'));
    try {
      expect(await dorCorpusToEvalJsonl(dir)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cli-judgment dor-corpus writes JSONL and eval dor.stage-b runs on it with a fake provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dor-eval-'));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const cfg = resolveJudgmentConfig({
        spec: { provider: 'fake', model: 'fake-1', defaults: { mode: 'shadow' } },
      });
      const fake = new FakeJudgmentProvider();
      for (const id of [1, 2, 3, 4, 5, 6, 7]) {
        fake.script(`gate-${id}`, (req) => {
          const state = req.state as { title: string };
          return noul(state.title.includes('huge multi pr') && id === 4 ? 0.05 : 0.95);
        });
      }
      const deps = {
        out: (t: string) => out.push(t),
        err: (t: string) => err.push(t),
        cwd: dir,
        env: {},
        loadConfig: () => cfg,
        getProvider: () => fake,
      };
      const file = join(dir, 'corpus.jsonl');
      expect(await runJudgmentCli(['dor-corpus', root, '--out', file, '--cwd', dir], deps)).toBe(0);
      expect(out.join('')).toContain('items to');
      out.length = 0;
      const code = await runJudgmentCli(
        [
          'eval',
          'dor.stage-b',
          '--corpus',
          file,
          '--cwd',
          dir,
          '--threshold',
          'pass=0.8',
          '--threshold',
          'fail=0.2',
        ],
        deps,
      );
      expect(err.join('')).toBe('');
      expect(code).toBe(0);
      out.length = 0;
      const passCode = await runJudgmentCli(
        ['eval', 'dor.stage-b-pass', '--corpus', file, '--cwd', dir, '--threshold', 'pass=0.8'],
        deps,
      );
      expect(passCode).toBe(0);
      expect(out.join('')).toMatch(/dor\.stage-b-pass/);
      expect(out.join('')).toMatch(/dor\.stage-b/);
      expect(fake.requests.length).toBeGreaterThan(30);
      // a bad corpus root is a clean error
      expect(await runJudgmentCli(['dor-corpus', join(dir, 'missing')], deps)).toBe(1);
      // stdout mode
      out.length = 0;
      expect(await runJudgmentCli(['dor-corpus', root], deps)).toBe(0);
      expect(out.join('')).toContain('"gateIds"');
      writeFileSync(join(dir, 'x'), '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
