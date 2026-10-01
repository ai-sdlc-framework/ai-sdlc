import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disabledJudgmentConfig,
  FakeJudgmentProvider,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
  type JudgmentEvaluationRecord,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import {
  composeJudgmentNotes,
  getMergeBaseDiff,
  isFlaggedAnnotation,
  runAcCoverage,
  runFindingGrounding,
} from './agent-output-checks.js';
import { createJudgmentEventsSink } from './events-sink.js';
import { aggregateVerdicts } from '../steps/08-aggregate-verdicts.js';
import { parseDeveloperReturn } from '../steps/06-parse-dev-return.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import type { ReviewerVerdict } from '../types.js';
import type { Runner } from '../runtime/exec.js';

const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const choice = (c: string): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: { [c]: 0.9 },
  confidence: 0.9,
});

function enforceConfig(
  id: string,
  egress: string[],
  provider: FakeJudgmentProvider,
  mode: 'enforce' | 'shadow' | 'off' = 'enforce',
) {
  const key = `${provider.name}@${provider.modelId}`;
  return resolveJudgmentConfig({
    spec: {
      provider: provider.name,
      model: provider.modelId,
      egress: { allow: egress },
      judgments: {
        [id]: {
          mode,
          thresholds: { [key]: { covered: 0.5 } },
          promotion: { [key]: { path: 'override', evidence: 'reviewed a sample by hand' } },
        },
      },
    },
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-output-checks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(
  provider: FakeJudgmentProvider,
  config: ReturnType<typeof enforceConfig>,
): {
  ctx: EvaluateJudgmentContext;
  events: OrchestratorEvent[];
  records: JudgmentEvaluationRecord[];
} {
  const events: OrchestratorEvent[] = [];
  const records: JudgmentEvaluationRecord[] = [];
  const eventsSink = createJudgmentEventsSink({
    write: (e) => void events.push(e),
    now: () => new Date('2026-10-01T00:00:00Z'),
  });
  return {
    events,
    records,
    ctx: {
      config,
      getProvider: (n) => (n === provider.name ? provider : undefined),
      sinks: [{ record: (r) => void records.push(r) }, eventsSink],
      taskId: 'T-1',
    },
  };
}

describe('dev.ac-coverage', () => {
  const criteria = ['adds the flag', 'documents the flag', 'covers the edge case'];
  const getDiff = async () => 'diff --git a/x b/x\n+flag';

  it('sends one request with one noul per criterion and flags low ones', async () => {
    const provider = new FakeJudgmentProvider()
      .script('ac-0', noul(0.95))
      .script('ac-1', noul(0.1))
      .script('ac-2', noul(0.9));
    const h = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider));
    const r = await runAcCoverage({ ctx: h.ctx, acceptanceCriteria: criteria, getDiff });
    expect(provider.requests).toHaveLength(1);
    expect(Object.keys(provider.requests[0].questions)).toEqual(['ac-0', 'ac-1', 'ac-2']);
    expect(r?.uncovered).toBe(1);
    expect(r?.criteria.map((c) => c.likelyUncovered)).toEqual([false, true, false]);
    expect(h.events.filter((e) => e.type === 'JudgmentEscalated')).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ judgmentId: 'dev.ac-coverage', taskId: 'T-1' });
    expect(h.records).toHaveLength(1);
  });

  it('returns the decision and emits no event when everything is covered', async () => {
    const provider = new FakeJudgmentProvider()
      .script('ac-0', noul(0.9))
      .script('ac-1', noul(0.9))
      .script('ac-2', noul(0.9));
    const h = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider));
    const r = await runAcCoverage({ ctx: h.ctx, acceptanceCriteria: criteria, getDiff });
    expect(r?.uncovered).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it('abstains state-too-large without any provider request', async () => {
    const provider = new FakeJudgmentProvider({ capabilities: { maxStateTokens: 50 } });
    const h = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider));
    const r = await runAcCoverage({
      ctx: h.ctx,
      acceptanceCriteria: criteria,
      getDiff: async () => 'x'.repeat(5000),
    });
    expect(provider.requests).toHaveLength(0);
    expect(r).toEqual({ criteria: [], uncovered: 0, abstainReason: 'state-too-large' });
    expect(h.records[0].outcome).toEqual({ kind: 'abstain', reason: 'state-too-large' });
    expect(h.records[0].called).toBe(false);
  });

  it('reports nothing in shadow mode (answers are logged only)', async () => {
    const provider = new FakeJudgmentProvider()
      .script('ac-0', noul(0.1))
      .script('ac-1', noul(0.1))
      .script('ac-2', noul(0.1));
    const h = harness(
      provider,
      enforceConfig('dev.ac-coverage', ['code-diff'], provider, 'shadow'),
    );
    expect(await runAcCoverage({ ctx: h.ctx, acceptanceCriteria: criteria, getDiff })).toBe(
      undefined,
    );
    expect(h.events).toHaveLength(0);
    expect(h.records[0].answers).not.toBeNull();
  });

  it('is a no-op when disabled: no diff, no provider, no sinks', async () => {
    let diffCalls = 0;
    const r = await runAcCoverage({
      ctx: { config: disabledJudgmentConfig() },
      acceptanceCriteria: criteria,
      getDiff: async () => {
        diffCalls++;
        return 'd';
      },
    });
    expect(r).toBeUndefined();
    expect(diffCalls).toBe(0);
  });

  it('is a no-op with no criteria, an empty diff, a throwing diff, or mode off', async () => {
    const provider = new FakeJudgmentProvider();
    const on = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider));
    expect(await runAcCoverage({ ctx: on.ctx, acceptanceCriteria: [], getDiff })).toBeUndefined();
    expect(
      await runAcCoverage({ ctx: on.ctx, acceptanceCriteria: criteria, getDiff: async () => '' }),
    ).toBeUndefined();
    expect(
      await runAcCoverage({
        ctx: on.ctx,
        acceptanceCriteria: criteria,
        getDiff: async () => {
          throw new Error('boom');
        },
      }),
    ).toBeUndefined();
    const off = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider, 'off'));
    expect(
      await runAcCoverage({ ctx: off.ctx, acceptanceCriteria: criteria, getDiff }),
    ).toBeUndefined();
    expect(provider.requests).toHaveLength(0);
  });

  it('provider failure yields no result', async () => {
    const provider = new FakeJudgmentProvider().failWith('timeout');
    const h = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider));
    expect(
      await runAcCoverage({ ctx: h.ctx, acceptanceCriteria: criteria, getDiff }),
    ).toBeUndefined();
  });
});

describe('Step 6 integration', () => {
  const dev = {
    summary: 'ok',
    filesChanged: ['a.ts'],
    commitSha: 'abc1234',
    verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
    acceptanceCriteriaMet: [1],
  };

  it('is identical with and without a disabled hook', async () => {
    const plain = await parseDeveloperReturn({ developerReturn: dev });
    const hooked = await parseDeveloperReturn({
      developerReturn: dev,
      acCoverage: {
        ctx: { config: disabledJudgmentConfig() },
        acceptanceCriteria: ['a'],
        getDiff: async () => 'd',
      },
    });
    expect(hooked).toEqual(plain);
    expect('acCoverage' in hooked).toBe(false);
  });

  it('attaches acCoverage when the layer ran', async () => {
    const provider = new FakeJudgmentProvider().script('ac-0', noul(0.05));
    const h = harness(provider, enforceConfig('dev.ac-coverage', ['code-diff'], provider));
    const r = await parseDeveloperReturn({
      developerReturn: dev,
      acCoverage: { ctx: h.ctx, acceptanceCriteria: ['a'], getDiff: async () => 'd' },
    });
    expect(r.ok).toBe(true);
    expect(r.acCoverage?.uncovered).toBe(1);
  });
});

function writeFile(name: string, lines: number) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, name),
    Array.from({ length: lines }, (_, i) => `l${i + 1}`).join('\n') + '\n',
  );
}

const verdict = (
  agentId: string,
  findings: ReviewerVerdict['findings'],
  approved = true,
): ReviewerVerdict => ({ agentId, harness: 'claude-code', approved, findings });

describe('review.finding-grounding', () => {
  const egress = ['agent-output', 'code-diff'];

  it('annotates a missing file and an out-of-range line without calling the provider', async () => {
    writeFile('src/a.ts', 10);
    const provider = new FakeJudgmentProvider();
    const h = harness(provider, enforceConfig('review.finding-grounding', egress, provider));
    const ann = await runFindingGrounding(
      [
        verdict('code-reviewer', [
          { severity: 'major', file: 'src/gone.ts', line: 3, message: 'm1' },
          { severity: 'minor', file: 'src/a.ts', line: 999, message: 'm2' },
          { severity: 'minor', file: '../outside.ts', line: 1, message: 'm3' },
          { severity: 'minor', message: 'no location' },
        ]),
      ],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(provider.requests).toHaveLength(0);
    expect(ann?.map((a) => a.relation)).toEqual([
      'location-not-found',
      'location-not-found',
      'location-not-found',
    ]);
    expect(h.events.filter((e) => e.type === 'JudgmentEscalated')).toHaveLength(1);
    expect(h.records[0].called).toBe(false);
  });

  it('asks one choice per finding in one request with 30 lines of context', async () => {
    writeFile('src/a.ts', 100);
    const provider = new FakeJudgmentProvider()
      .script('finding-0', choice('supports'))
      .script('finding-1', choice('contradicts'));
    const h = harness(provider, enforceConfig('review.finding-grounding', egress, provider));
    const ann = await runFindingGrounding(
      [
        verdict('code-reviewer', [
          { severity: 'major', file: 'src/a.ts', line: 50, message: 'c1' },
        ]),
        verdict('security-reviewer', [
          { severity: 'minor', file: 'src/a.ts', line: 2, message: 'c2' },
        ]),
      ],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(provider.requests).toHaveLength(1);
    const state = provider.requests[0].state as { findings: Array<{ excerpt: string }> };
    expect(state.findings[0].excerpt.split('\n')).toHaveLength(61);
    expect(ann?.map((a) => [a.agentId, a.relation])).toEqual([
      ['code-reviewer', 'supports'],
      ['security-reviewer', 'contradicts'],
    ]);
    expect(h.events.filter((e) => e.type === 'JudgmentEscalated')).toHaveLength(1);
  });

  it('splits into several requests when the state budget requires it', async () => {
    writeFile('src/a.ts', 100);
    const provider = new FakeJudgmentProvider({ capabilities: { maxStateTokens: 450 } })
      .script('finding-0', choice('supports'))
      .script('finding-1', choice('supports'))
      .script('finding-2', choice('supports'));
    const h = harness(provider, enforceConfig('review.finding-grounding', egress, provider));
    // finding ids restart per request, so scripts cover every batch
    const findings = [10, 20, 30].map((line) => ({
      severity: 'minor' as const,
      file: 'src/a.ts',
      line,
      message: 'm',
    }));
    const ann = await runFindingGrounding([verdict('code-reviewer', findings)], {
      ctx: h.ctx,
      worktreePath: dir,
    });
    expect(provider.requests.length).toBeGreaterThan(1);
    expect(provider.requests.length).toBeLessThan(4);
    expect(ann).toHaveLength(3);
    expect(h.events).toHaveLength(0);
  });

  it('does not run when only one of agent-output and code-diff is allowed', async () => {
    writeFile('src/a.ts', 10);
    for (const only of [['agent-output'], ['code-diff']]) {
      const provider = new FakeJudgmentProvider().script('finding-0', choice('contradicts'));
      const h = harness(provider, enforceConfig('review.finding-grounding', only, provider));
      const ann = await runFindingGrounding(
        [
          verdict('code-reviewer', [
            { severity: 'major', file: 'src/gone.ts', line: 1, message: 'm' },
          ]),
        ],
        { ctx: h.ctx, worktreePath: dir },
      );
      expect(ann).toBeUndefined();
      expect(provider.requests).toHaveLength(0);
      expect(h.records).toHaveLength(0);
    }
  });

  it('shadow mode logs location misses but returns nothing', async () => {
    const provider = new FakeJudgmentProvider();
    const h = harness(
      provider,
      enforceConfig('review.finding-grounding', egress, provider, 'shadow'),
    );
    const ann = await runFindingGrounding(
      [verdict('code-reviewer', [{ severity: 'major', file: 'nope.ts', line: 1, message: 'm' }])],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann).toBeUndefined();
    expect(h.records[0].outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
    expect(h.events).toHaveLength(0);
  });

  it('is a no-op when disabled, with no locatable findings, or on error', async () => {
    expect(
      await runFindingGrounding(
        [verdict('r', [{ severity: 'minor', file: 'a', line: 1, message: 'm' }])],
        {
          ctx: { config: disabledJudgmentConfig() },
          worktreePath: dir,
        },
      ),
    ).toBeUndefined();
    const provider = new FakeJudgmentProvider();
    const h = harness(provider, enforceConfig('review.finding-grounding', egress, provider));
    expect(
      await runFindingGrounding([verdict('r', [{ severity: 'minor', message: 'm' }])], {
        ctx: h.ctx,
        worktreePath: dir,
      }),
    ).toBeUndefined();
    expect(
      await runFindingGrounding(
        [verdict('r', [{ severity: 'minor', file: 'a', line: 1, message: 'm' }])],
        {
          ctx: h.ctx,
          worktreePath: dir,
          readFile: () => {
            throw new Error('boom');
          },
        },
      ),
    ).toBeUndefined();
  });

  it('reads a directory path as not found', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const provider = new FakeJudgmentProvider();
    const h = harness(provider, enforceConfig('review.finding-grounding', egress, provider));
    const ann = await runFindingGrounding(
      [verdict('r', [{ severity: 'minor', file: 'src', line: 1, message: 'm' }])],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann?.[0].relation).toBe('location-not-found');
  });

  it('survives a throwing sink', async () => {
    const provider = new FakeJudgmentProvider();
    const h = harness(provider, enforceConfig('review.finding-grounding', egress, provider));
    h.ctx.sinks = [
      {
        record: () => {
          throw new Error('sink down');
        },
      },
    ];
    const ann = await runFindingGrounding(
      [verdict('r', [{ severity: 'minor', file: 'gone.ts', line: 1, message: 'm' }])],
      { ctx: h.ctx, worktreePath: dir },
    );
    expect(ann).toHaveLength(1);
  });
});

describe('Step 8 integration', () => {
  const verdicts = [
    verdict('code-reviewer', [{ severity: 'major', file: 'gone.ts', line: 1, message: 'm' }], true),
    verdict('test-reviewer', [{ severity: 'minor', message: 'nit' }], true),
  ];

  it('aggregation output is identical with and without annotations', async () => {
    const provider = new FakeJudgmentProvider();
    const h = harness(
      provider,
      enforceConfig('review.finding-grounding', ['agent-output', 'code-diff'], provider),
    );
    const before = JSON.stringify(verdicts);
    const plain = await aggregateVerdicts({ verdicts });
    const withGrounding = await aggregateVerdicts({
      verdicts,
      grounding: { ctx: h.ctx, worktreePath: dir },
    });
    expect(withGrounding.groundingAnnotations).toHaveLength(1);
    const { groundingAnnotations: _a, ...rest } = withGrounding;
    expect(rest).toEqual(plain);
    expect(JSON.stringify(verdicts)).toBe(before);
    expect(withGrounding.approved).toBe(plain.approved);
    expect(withGrounding.counts).toEqual(plain.counts);
  });

  it('disabled layer leaves the result byte-identical', async () => {
    const plain = await aggregateVerdicts({ verdicts });
    const hooked = await aggregateVerdicts({
      verdicts,
      grounding: { ctx: { config: disabledJudgmentConfig() }, worktreePath: dir },
    });
    expect(JSON.stringify(hooked)).toBe(JSON.stringify(plain));
    expect('groundingAnnotations' in hooked).toBe(false);
  });
});

describe('getMergeBaseDiff', () => {
  it('diffs against the integration branch and reports failure as undefined', async () => {
    const calls: string[][] = [];
    const ok: Runner = async (_c, args) => {
      calls.push(args);
      return { stdout: 'DIFF', stderr: '', code: 0 };
    };
    expect(await getMergeBaseDiff({ workDir: dir, worktreePath: dir, runner: ok })).toBe('DIFF');
    expect(calls[0]).toEqual(['diff', 'origin/main...HEAD']);
    const bad: Runner = async () => ({ stdout: '', stderr: 'x', code: 1 });
    expect(
      await getMergeBaseDiff({ workDir: dir, worktreePath: dir, runner: bad }),
    ).toBeUndefined();
  });
});

describe('composeJudgmentNotes', () => {
  it('is empty when nothing is flagged', () => {
    expect(composeJudgmentNotes({})).toBe('');
    expect(
      composeJudgmentNotes({
        acCoverage: {
          criteria: [{ index: 0, probability: 0.9, likelyUncovered: false }],
          uncovered: 0,
        },
        groundingAnnotations: [
          { agentId: 'r', findingIndex: 0, file: 'a', line: 1, relation: 'supports' },
          { agentId: 'r', findingIndex: 1, file: 'a', line: 2, relation: 'cannot-tell' },
        ],
      }),
    ).toBe('');
  });

  it('lists flagged criteria and findings without internal task ids', () => {
    const notes = composeJudgmentNotes({
      acCoverage: {
        criteria: [{ index: 1, probability: 0.12, likelyUncovered: true }],
        uncovered: 1,
      },
      acceptanceCriteria: ['first', 'x'.repeat(300)],
      groundingAnnotations: [
        {
          agentId: 'code-reviewer',
          findingIndex: 0,
          file: 'a.ts',
          line: 4,
          relation: 'contradicts',
        },
        { agentId: 'code-reviewer', findingIndex: 1, file: 'b.ts', line: 5, relation: 'unrelated' },
        {
          agentId: 'test-reviewer',
          findingIndex: 0,
          file: 'c.ts',
          line: 6,
          relation: 'location-not-found',
        },
      ],
    });
    expect(notes.startsWith('## Judgment notes (advisory)')).toBe(true);
    expect(notes).toContain('criterion 2');
    expect(notes).toContain('0.12');
    expect(notes).toContain('...');
    expect(notes).toContain('a.ts:4 is contradicted');
    expect(notes).toContain('b.ts:5 is unrelated');
    expect(notes).toContain('c.ts:6 cites a location that was not found');
    expect(notes).not.toMatch(/AISDLC|RFC-\d|[A-Z]{2,}-\d+/);
    expect(
      isFlaggedAnnotation({
        agentId: 'r',
        findingIndex: 0,
        file: 'a',
        line: 1,
        relation: 'supports',
      }),
    ).toBe(false);
  });
});
