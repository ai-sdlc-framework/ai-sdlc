/**
 * Operator-question gate, checks 2 and 3 (AISDLC-1443). Hermetic: a fake
 * provider, a temporary git repository, no network.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  resolveJudgmentConfig,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import type { Decision } from './decision-record.js';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
} from './event-log.js';
import { judgeOperatorQuestion, readAnsweredDecisionsAtRef } from './question-judgment.js';
import { runJudgmentCli } from '../cli/judgment.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeFixtureDir(d);
});

function answered(id: string, summary: string, chosen = 'opt-a'): Decision {
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
        { id: 'opt-a', description: 'Use the prebuilt image', consequences: ['x'] },
        { id: 'opt-b', description: 'Mount the store', consequences: ['y'] },
      ],
    },
    status: { lifecycle: 'answered', answeredOptionId: chosen },
  } as Decision;
}

const noul = (probability: number): JudgmentAnswer => ({ type: 'noul', probability });
const choice = (c: string, p: number): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries(
    ['reversible', 'one-way', 'unknown'].map((k) => [k, k === c ? p : (1 - p) / 2]),
  ),
  confidence: p,
});

function config(mode: 'enforce' | 'shadow') {
  return resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow' },
      judgments: Object.fromEntries(
        ['decision.duplicate', 'decision.reversibility'].map((id) => [
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
}

const QUESTION = {
  summary: 'How does the toolchain get into the untrusted gate sandbox?',
  options: [{ id: 'prebuilt image', description: 'Bake the toolchain into an image' }],
};
const MAIN = [
  answered('DEC-0101', 'How does the toolchain get into the untrusted-PR gate sandbox?'),
  answered('DEC-0102', 'Which colour should the dashboard use?'),
];

function provider(dup = 0.95, rev = choice('reversible', 0.95)): FakeJudgmentProvider {
  return new FakeJudgmentProvider().script('dup-DEC-0101', noul(dup)).script('reversibility', rev);
}

describe('judgeOperatorQuestion', () => {
  it('enforce: an act duplicate names the answered decision, its option and summary', async () => {
    const p = provider();
    const r = await judgeOperatorQuestion(
      QUESTION,
      MAIN,
      { config: config('enforce'), getProvider: () => p },
      { sourceKind: 'backlog' },
    );
    expect(r.duplicate?.outcome).toBe('act');
    expect(r.duplicate?.mode).toBe('enforce');
    expect(r.duplicate?.decision).toEqual({ duplicateOf: 'DEC-0101' });
    expect(r.duplicate?.match).toEqual({
      id: 'DEC-0101',
      option: 'opt-a',
      optionDescription: 'Use the prebuilt image',
      summary: MAIN[0]!.spec.summary,
    });
    expect(r.duplicate?.basis).toMatch(/^decision\.duplicate@/);
    expect(r.reversibility).toMatchObject({ outcome: 'act', decision: 'reversible' });
    // Only the shortlisted pair is put to the judgment.
    const dupReq = p.requests.find((q) => 'dup-DEC-0101' in q.questions);
    expect(Object.keys(dupReq!.questions)).toEqual(['dup-DEC-0101']);
  });

  it('shadow: the evaluator abstains and the would-be outcome is reported', async () => {
    const r = await judgeOperatorQuestion(
      QUESTION,
      MAIN,
      { config: config('shadow'), getProvider: () => provider() },
      { sourceKind: 'backlog' },
    );
    expect(r.duplicate).toMatchObject({
      outcome: 'abstain',
      reason: 'shadow',
      mode: 'shadow',
      shadow: { outcome: 'act', decision: { duplicateOf: 'DEC-0101' } },
      match: { id: 'DEC-0101' },
    });
    expect(r.reversibility).toMatchObject({
      outcome: 'abstain',
      shadow: { outcome: 'act', decision: 'reversible' },
    });
  });

  it('untrusted source kind escalates the permissive outcomes instead of acting', async () => {
    const r = await judgeOperatorQuestion(
      QUESTION,
      MAIN,
      { config: config('enforce'), getProvider: () => provider() },
      { sourceKind: 'untrusted-external' },
    );
    expect(r.duplicate?.outcome).toBe('escalate');
    expect(r.duplicate?.match).toBeUndefined();
    expect(r.reversibility?.outcome).toBe('escalate');
  });

  it('makes no duplicate request when nothing is shortlisted, and skips check 3 on request', async () => {
    const p = provider();
    const r = await judgeOperatorQuestion(
      { summary: 'Completely unrelated wording about invoices', options: [] },
      MAIN,
      { config: config('enforce'), getProvider: () => p },
      { sourceKind: 'backlog', skipReversibility: true },
    );
    expect(r).toEqual({});
    expect(p.requests).toHaveLength(0);
  });

  it('no provider: both abstain with no basis', async () => {
    const r = await judgeOperatorQuestion(QUESTION, MAIN, {
      config: resolveJudgmentConfig({ spec: {} }),
    });
    expect(r.duplicate).toMatchObject({ outcome: 'abstain', basis: null });
    expect(r.duplicate?.match).toBeUndefined();
    expect(r.reversibility).toMatchObject({ outcome: 'abstain', mode: 'off' });
  });

  it('a non-duplicate verdict carries no match', async () => {
    const r = await judgeOperatorQuestion(
      QUESTION,
      MAIN,
      { config: config('enforce'), getProvider: () => provider(0.1) },
      { sourceKind: 'backlog' },
    );
    expect(r.duplicate).toMatchObject({ outcome: 'act', decision: { duplicateOf: null } });
    expect(r.duplicate?.match).toBeUndefined();
  });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

describe('readAnsweredDecisionsAtRef', () => {
  it('returns only answered decisions committed at the ref, never local events', () => {
    const repo = mkdtempSync(join(tmpdir(), 'qgate-repo-'));
    dirs.push(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    const opts = (id: string) => ({
      decisionId: id,
      source: 'ad-hoc' as const,
      scope: 'workspace',
      summary: `Decision ${id}`,
      options: [
        { id: 'opt-a', description: 'A', consequences: ['x'] },
        { id: 'opt-b', description: 'B', consequences: ['y'] },
      ],
      now: new Date('2026-01-01T00:00:00Z'),
    });
    appendDecisionEvent(makeDecisionOpenedEvent(opts('DEC-0001')), { workDir: repo });
    appendDecisionEvent(
      makeOperatorAnsweredEvent({
        decisionId: 'DEC-0001',
        chosenOptionId: 'opt-b',
        by: 'op',
        now: new Date('2026-01-02T00:00:00Z'),
      }),
      { workDir: repo },
    );
    appendDecisionEvent(makeDecisionOpenedEvent(opts('DEC-0002')), { workDir: repo });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'decisions');
    // Answered locally only: not a candidate.
    appendDecisionEvent(
      makeOperatorAnsweredEvent({
        decisionId: 'DEC-0002',
        chosenOptionId: 'opt-a',
        by: 'op',
        now: new Date('2026-01-03T00:00:00Z'),
      }),
      { workDir: repo },
    );
    const got = readAnsweredDecisionsAtRef(repo, 'main');
    expect(got.map((d) => [d.metadata.id, d.status.answeredOptionId])).toEqual([
      ['DEC-0001', 'opt-b'],
    ]);
    expect(readAnsweredDecisionsAtRef(repo, 'no-such-ref')).toEqual([]);
  });
});

describe('cli-judgment question-gate', () => {
  // A private directory per run: the judgment log lands under `<cwd>/.ai-sdlc`,
  // and a shared `tmpdir()` would make every tmp path look like a framework repo.
  const run = async (stdin: string, withProvider: boolean, extra: string[] = []) => {
    let stdout = '';
    let stderr = '';
    const code = await runJudgmentCli(['question-gate', ...extra], {
      out: (t) => (stdout += t),
      err: (t) => (stderr += t),
      cwd: mkdtempSync(join(tmpdir(), 'qgate-cli-')),
      env: {},
      readStdin: () => stdin,
      loadConfig: () => (withProvider ? config('enforce') : resolveJudgmentConfig({ spec: {} })),
      getProvider: () => provider(),
      readAnswered: () => MAIN,
    });
    return { code, stdout, stderr };
  };

  it('prints {} when no provider is configured', async () => {
    const r = await run(JSON.stringify(QUESTION), false);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({});
  });

  it('prints both results, honouring skipReversibility and --source-kind', async () => {
    const r = await run(
      JSON.stringify({ ...QUESTION, options: [...QUESTION.options, 7], skipReversibility: true }),
      true,
      ['--source-kind', 'backlog'],
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.duplicate).toMatchObject({ outcome: 'act', match: { id: 'DEC-0101' } });
    expect(parsed.reversibility).toBeUndefined();
  });

  it('refuses stdin with no summary', async () => {
    const r = await run(JSON.stringify({ options: [] }), true);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('non-empty "summary"');
  });
});
