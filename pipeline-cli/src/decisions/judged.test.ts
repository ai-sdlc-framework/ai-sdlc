/**
 * Decision judgments: Stage A (reversibility, pillars, duplicate) and Stage B signals.
 * Hermetic: a fake provider, temp directories, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  evaluateJudgment,
  resolveJudgmentConfig,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import type { JudgmentRunner } from '../judgment/runner.js';
import type { Decision } from './decision-record.js';
import {
  applyJudgedDuplicate,
  applyJudgedReversibility,
  mergeJudgedPillars,
  runStageA,
} from './stage-a.js';
import { runStageB, scoreLlmConfidence } from './stage-b.js';
import {
  judgeStageA,
  judgeStageBSignals,
  readExemplarRefs,
  selectRelevantExemplars,
  shortlistDuplicates,
} from './judged.js';

function mk(id: string, summary: string, over: Partial<Decision['spec']> = {}): Decision {
  return {
    metadata: {
      id,
      source: 'ad-hoc',
      scope: 'workspace',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    spec: {
      summary,
      options: [
        { id: 'opt-a', description: 'Option A', consequences: ['x'] },
        { id: 'opt-b', description: 'Option B', consequences: ['y'] },
      ],
      ...over,
    },
    status: { lifecycle: 'open' },
  } as Decision;
}

const choice = (c: string, p: number, all: string[]): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries(all.map((k) => [k, k === c ? p : (1 - p) / (all.length - 1)])),
  confidence: p,
});
const REV = ['reversible', 'one-way', 'unknown'];
const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const score = (s: number, confidence = 0.9): JudgmentAnswer => ({
  type: 'score',
  score: s,
  probabilities: [0, 0, 0, 0].map((_, i) => (i === s ? confidence : 0.05)),
  confidence,
});

const IDS = [
  'decision.reversibility',
  'decision.pillars',
  'decision.duplicate',
  'decision.stage-b-signals',
];

function runnerFor(
  provider: FakeJudgmentProvider,
  mode: 'enforce' | 'shadow' = 'enforce',
): JudgmentRunner {
  const config = resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow' },
      judgments: Object.fromEntries(
        IDS.map((id) => [
          id,
          {
            mode,
            thresholds: { 'fake@fake-1': { x: 0.5 } },
            promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed 20 items' } },
          },
        ]),
      ),
    },
  });
  return (definition, input, opts = {}) =>
    evaluateJudgment(definition, input, {
      config,
      getProvider: () => provider,
      ...(opts.incumbent !== undefined ? { incumbent: opts.incumbent } : {}),
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    });
}

function pillarScript(p: FakeJudgmentProvider, e: number, pr: number, d: number): void {
  p.script('engineering', noul(e)).script('product', noul(pr)).script('design', noul(d));
}

describe('apply helpers', () => {
  it('reversibility: only an unknown phrase-list result is affected, and only toward more scrutiny', () => {
    expect(applyJudgedReversibility('one-way', 'reversible')).toEqual({ reversibility: 'one-way' });
    expect(applyJudgedReversibility('reversible', 'one-way')).toEqual({
      reversibility: 'reversible',
    });
    expect(applyJudgedReversibility('unknown', undefined)).toEqual({ reversibility: 'unknown' });
    expect(applyJudgedReversibility('unknown', 'unknown')).toEqual({ reversibility: 'unknown' });
    expect(applyJudgedReversibility('unknown', 'one-way')).toEqual({ reversibility: 'one-way' });
    expect(applyJudgedReversibility('unknown', 'reversible')).toEqual({
      reversibility: 'unknown',
      judgedReversibility: 'reversible',
    });
  });

  it('pillars are only ever added', () => {
    expect(mergeJudgedPillars(['engineering'], undefined)).toEqual(['engineering']);
    expect(mergeJudgedPillars(['engineering'], [])).toEqual(['engineering']);
    expect(mergeJudgedPillars(['engineering'], ['design', 'product'])).toEqual([
      'design',
      'engineering',
      'product',
    ]);
    expect(mergeJudgedPillars(['engineering', 'product'], ['design'])).toEqual([
      'design',
      'engineering',
      'product',
    ]);
  });

  it('a duplicate the edit distance found is never cleared; a judged one can flag a miss', () => {
    const found = { isDuplicate: true, candidateId: 'DEC-0002', similarity: 0.9 };
    const none = { isDuplicate: false, candidateId: null, similarity: 0.4 };
    expect(applyJudgedDuplicate(found, { candidateId: 'DEC-0003', similarity: 0.6 })).toBe(found);
    expect(applyJudgedDuplicate(none, undefined)).toBe(none);
    expect(applyJudgedDuplicate(none, { candidateId: 'DEC-0003', similarity: 0.61234 })).toEqual({
      isDuplicate: true,
      candidateId: 'DEC-0003',
      similarity: 0.612,
    });
  });
});

describe('runStageA with judged answers', () => {
  const d = mk('DEC-0001', 'Pick the cache layer for session lookups');

  it('is identical with no judged input', () => {
    const base = runStageA({ decision: d });
    expect(runStageA({ decision: d, judged: undefined })).toEqual(base);
    expect(base).not.toHaveProperty('judgedReversibility');
  });

  it('a judged one-way overrides a phrase-list miss and resolves by Stage A', () => {
    const out = runStageA({ decision: d, judged: { reversibility: 'one-way' } });
    expect(out.reversibility).toBe('one-way');
    expect(out.resolvedByStageA).toBe(true);
  });

  it('a phrase-list one-way hit survives a judged reversible', () => {
    const hit = mk('DEC-0001', 'Do a hard delete of the old tenants');
    const out = runStageA({ decision: hit, judged: { reversibility: 'reversible' } });
    expect(out.reversibility).toBe('one-way');
  });

  it('a judged reversible is recorded but never routes the decision to the framework', () => {
    const plain = runStageA({ decision: d });
    const out = runStageA({ decision: d, judged: { reversibility: 'reversible' } });
    expect(out.reversibility).toBe('unknown');
    expect(out.judgedReversibility).toBe('reversible');
    expect(out.resolvedByStageA).toBe(false);
    expect(out.routingActor).toBe(plain.routingActor);
    expect(out.prioritySignal).toBe(plain.prioritySignal);
  });

  it('judged pillars widen the keyword set and send a reversible decision to the operator', () => {
    const rev = mk('DEC-0001', 'Pick the cache layer', { reversible: true });
    const before = runStageA({ decision: rev });
    expect(before.routingActor).toBe('framework');
    const out = runStageA({ decision: rev, judged: { pillars: ['design', 'product'] } });
    expect(out.blastRadius.affectedPillars).toEqual(['design', 'engineering', 'product']);
    expect(out.routingActor).toBe('operator');
  });

  it('a judged duplicate flags the decision and removes it from the resolved set', () => {
    const rev = mk('DEC-0001', 'Pick the cache layer', { reversible: true });
    expect(runStageA({ decision: rev }).resolvedByStageA).toBe(true);
    const out = runStageA({
      decision: rev,
      judged: { duplicate: { candidateId: 'DEC-0002', similarity: 0.6 } },
    });
    expect(out.duplicateDetection).toMatchObject({ isDuplicate: true, candidateId: 'DEC-0002' });
    expect(out.resolvedByStageA).toBe(false);
  });
});

describe('judgeStageA', () => {
  const d = mk('DEC-0001', 'Pick the cache layer for session lookups');
  const open = [
    mk('DEC-0002', 'Pick the cache layer for session storage'),
    mk('DEC-0003', 'Completely unrelated hiring plan for next quarter'),
  ];

  function provider(): FakeJudgmentProvider {
    const p = new FakeJudgmentProvider()
      .script('reversibility', choice('one-way', 0.95, REV))
      .script('dup-DEC-0002', noul(0.97));
    pillarScript(p, 0.9, 0.8, 0.1);
    return p;
  }

  it('returns undefined without a runner', async () => {
    expect(await judgeStageA(d, open, undefined)).toBeUndefined();
  });

  it('enforce overrides a keyword miss and widens pillars; all pairs go in one request', async () => {
    const p = provider();
    const judged = await judgeStageA(d, open, runnerFor(p), { sourceKind: 'backlog' });
    expect(judged).toEqual({
      reversibility: 'one-way',
      pillars: ['engineering', 'product'],
      duplicate: { candidateId: 'DEC-0002', similarity: expect.any(Number) },
    });
    const dupRequests = p.requests.filter((r) =>
      Object.keys(r.questions).some((q) => q.startsWith('dup-')),
    );
    expect(dupRequests).toHaveLength(1);
    expect(Object.keys(dupRequests[0].questions)).toEqual(['dup-DEC-0002']);
  });

  it('puts every shortlisted pair in the same single request', async () => {
    const more = [...open, mk('DEC-0004', 'Pick the cache layer for session lookup data')];
    const p = provider().script('dup-DEC-0004', noul(0.1));
    await judgeStageA(d, more, runnerFor(p), { sourceKind: 'backlog' });
    const dupRequests = p.requests.filter((r) =>
      Object.keys(r.questions).some((q) => q.startsWith('dup-')),
    );
    expect(dupRequests).toHaveLength(1);
    expect(Object.keys(dupRequests[0].questions).sort()).toEqual(['dup-DEC-0002', 'dup-DEC-0004']);
  });

  it('makes no duplicate request when the shortlist is empty', async () => {
    const p = provider();
    const judged = await judgeStageA(d, [open[1]], runnerFor(p), { sourceKind: 'backlog' });
    expect(judged?.duplicate).toBeUndefined();
    expect(p.requests.some((r) => Object.keys(r.questions).some((q) => q.startsWith('dup-')))).toBe(
      false,
    );
  });

  it('does not act on reversible or a declared duplicate for gh-issue work', async () => {
    const p = new FakeJudgmentProvider()
      .script('reversibility', choice('reversible', 0.97, REV))
      .script('dup-DEC-0002', noul(0.99));
    pillarScript(p, 0.1, 0.1, 0.1);
    const judged = await judgeStageA(d, open, runnerFor(p), { sourceKind: 'gh-issue' });
    expect(judged).toBeUndefined();
  });

  it('keeps a keyword one-way hit when the judgment says reversible', async () => {
    const hit = mk('DEC-0001', 'Do a hard delete of the old tenants');
    const p = new FakeJudgmentProvider().script('reversibility', choice('reversible', 0.97, REV));
    pillarScript(p, 0.1, 0.1, 0.1);
    const judged = await judgeStageA(hit, [], runnerFor(p), { sourceKind: 'backlog' });
    expect(judged).toEqual({ reversibility: 'reversible' });
    expect(runStageA({ decision: hit, judged }).reversibility).toBe('one-way');
  });

  it('does not ask about reversibility when the field is explicit', async () => {
    const p = provider();
    await judgeStageA(mk('DEC-0001', 'x', { reversible: false }), [], runnerFor(p), {
      sourceKind: 'backlog',
    });
    expect(p.requests.some((r) => 'reversibility' in r.questions)).toBe(false);
  });

  it('returns undefined in shadow mode and when the provider fails', async () => {
    expect(await judgeStageA(d, open, runnerFor(provider(), 'shadow'))).toBeUndefined();
    const failing = provider().failWith('timeout');
    expect(
      await judgeStageA(d, open, runnerFor(failing), { sourceKind: 'backlog' }),
    ).toBeUndefined();
  });

  it('shortlists above the floor, best first, capped', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      mk(`DEC-01${i}0`, `Pick the cache layer for session lookups v${i}`),
    );
    const list = shortlistDuplicates(d, many);
    expect(list).toHaveLength(5);
    expect(list.every((c) => c.similarity >= 0.5)).toBe(true);
    expect(shortlistDuplicates(d, [d])).toEqual([]);
  });
});

describe('Stage B signals', () => {
  const dec = mk('DEC-0001', 'Pick the cache layer for session lookups', {
    body: 'See RFC-0035 for the stated position.',
  });

  it('replaces both constants in the weighted formula', () => {
    const base = scoreLlmConfidence(dec);
    expect(base.novelty).toBe(0.5);
    expect(base.exemplarSimilarity).toBe(0.5);
    const judged = scoreLlmConfidence(dec, { novelty: 0, exemplarSimilarity: 1 / 3 });
    expect(judged.novelty).toBe(0);
    expect(judged.exemplarSimilarity).toBeCloseTo(1 / 3);
    const expected =
      base.rfcStatedPositionPresence * 0.3 +
      base.evidenceCompleteness * 0.4 +
      0 * 0.15 +
      (1 / 3) * 0.15;
    expect(judged.score).toBeCloseTo(expected, 3);
    expect(judged.score).toBeLessThan(base.score);
  });

  it('leaves the constants in place without signals', () => {
    const a = runStageA({ decision: dec });
    expect(runStageB({ decision: dec, stageA: a })).toEqual(
      runStageB({ decision: dec, stageA: a, signals: undefined }),
    );
  });

  it('feeds the judged signals through runStageB', () => {
    const a = runStageA({ decision: dec });
    const base = runStageB({ decision: dec, stageA: a });
    const out = runStageB({
      decision: dec,
      stageA: a,
      signals: { novelty: 0, exemplarSimilarity: 0 },
    });
    expect(out.rubricScores.llmConfidence.novelty).toBe(0);
    expect(out.compositeScore).toBeLessThan(base.compositeScore);
  });

  describe('judgeStageBSignals', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'stage-b-signals-'));
      mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));

    const seeded = `exemplars:
  - id: ex-1
    type: true-positive
    summary: 'Pick the cache layer'
    rationale: 'Composes with the existing store.'
  - id: ex-2
    type: false-positive
    summary: 'Unrelated hiring plan'
`;

    it('returns undefined without a runner and on abstain', async () => {
      expect(await judgeStageBSignals(dec, tmp, undefined)).toBeUndefined();
      const p = new FakeJudgmentProvider()
        .script('novelty', score(0))
        .script('exemplarSimilarity', score(0));
      expect(await judgeStageBSignals(dec, tmp, runnerFor(p, 'shadow'))).toBeUndefined();
    });

    it('sends the relevant exemplars and returns normalised signals, never above 0.5', async () => {
      writeFileSync(join(tmp, '.ai-sdlc', 'decision-exemplars.yaml'), seeded);
      const p = new FakeJudgmentProvider()
        .script('novelty', score(1))
        .script('exemplarSimilarity', score(3));
      const out = await judgeStageBSignals(dec, tmp, runnerFor(p), { sourceKind: 'backlog' });
      expect(out).toEqual({ novelty: 1 / 3, exemplarSimilarity: 0.5 });
      const state = p.requests[0].state as { exemplars: { id: string }[] };
      expect(state.exemplars.map((e) => e.id)).toEqual(['ex-1', 'ex-2']);
      expect(Object.keys(p.requests[0].questions)).toEqual(['novelty', 'exemplarSimilarity']);
    });

    it('works with no exemplar file', async () => {
      const p = new FakeJudgmentProvider()
        .script('novelty', score(0))
        .script('exemplarSimilarity', score(0));
      expect(await judgeStageBSignals(dec, tmp, runnerFor(p))).toEqual({
        novelty: 0,
        exemplarSimilarity: 0,
      });
    });

    it('reads the seeded shape, the promoted shape and ignores junk', () => {
      const file = join(tmp, '.ai-sdlc', 'decision-exemplars.yaml');
      writeFileSync(
        file,
        `- id: p1
  promotedAt: x
  promotedFromCorpusEntryId: y
  taskType: z
  originalClassification: a
  classification: b
  polarity: negative
  inputText: promoted text
  confidence: 0.5
  reasoning: r
- 5
- id: nosummary
`,
      );
      expect(readExemplarRefs(tmp)).toEqual([
        { id: 'p1', label: 'false-positive', summary: 'promoted text', rationale: 'r' },
      ]);
      writeFileSync(file, 'exemplars: [\n');
      expect(readExemplarRefs(tmp)).toEqual([]);
      writeFileSync(file, 'just a string');
      expect(readExemplarRefs(tmp)).toEqual([]);
      writeFileSync(file, seeded);
      expect(readExemplarRefs(tmp).map((e) => e.label)).toEqual([
        'true-positive',
        'false-positive',
      ]);
      expect(readExemplarRefs(tmp, join(tmp, 'missing.yaml'))).toEqual([]);
    });

    it('selects the exemplars sharing the most words, deterministically, up to the limit', () => {
      const refs = [
        { id: 'b', label: 'x', summary: 'cache layer sessions' },
        { id: 'a', label: 'x', summary: 'hiring plan' },
        { id: 'c', label: 'x', summary: '' },
      ];
      expect(selectRelevantExemplars(dec, refs, 2).map((e) => e.id)).toEqual(['b', 'a']);
    });
  });
});

describe('DECISION_JUDGMENT_SOURCE_KIND', () => {
  it('is not the trusted backlog kind, so a permissive outcome is never allowed', async () => {
    const { DECISION_JUDGMENT_SOURCE_KIND } = await import('./judged.js');
    expect(DECISION_JUDGMENT_SOURCE_KIND).not.toBe('backlog');
  });
});
