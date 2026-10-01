import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  REVIEWER_SET_SIGNAL_IDS,
  getJudgmentDefinition,
  resolveJudgmentConfig,
} from '@ai-sdlc/reference';
import type { ReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import { buildReviewsCli } from '../cli/reviews.js';
import { runJudgmentCli } from '../cli/judgment.js';
import {
  corpusToJsonl,
  gitDiffInputResolver,
  hasFirstPassBlockingFinding,
  ledgerToReviewerSetCorpus,
  reviewerSetInputFromDiff,
} from './reviewer-set-corpus.js';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n+const x = 1;\n';
const INPUT = reviewerSetInputFromDiff(DIFF);

function rec(over: Partial<ReviewLedgerRecord>): ReviewLedgerRecord {
  return {
    taskId: 'T-1',
    prNumber: 7,
    commitSha: 'a'.repeat(40),
    iteration: 1,
    role: 'code',
    harness: 'claude-code',
    timestamp: '2026-10-01T00:00:00Z',
    verdict: 'approved',
    findings: [],
    ...over,
  };
}
const finding = (severity: 'critical' | 'major' | 'minor' | 'suggestion') => ({
  severity,
  summary: 's',
  title: 's',
});

describe('ledger to corpus converter', () => {
  const convert = (records: ReviewLedgerRecord[]) =>
    ledgerToReviewerSetCorpus(records, () => INPUT);

  it.each([
    ['code', 'critical'],
    ['code', 'major'],
    ['test', 'critical'],
    ['test', 'major'],
    ['correctness', 'major'],
  ] as const)('a first-pass %s %s finding disagrees with a merged-set decision', (role, sev) => {
    const out = convert([rec({ role, findings: [finding(sev)], verdict: 'rejected' })]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].label).toMatchObject({ separateReviewBlocking: true, taskId: 'T-1' });
    expect(out.items[0].input).toEqual(INPUT);
  });

  it('minor findings, security findings and later iterations do not disagree', () => {
    const out = convert([
      rec({ role: 'code', findings: [finding('minor'), finding('suggestion')] }),
      rec({ role: 'security', findings: [finding('critical')] }),
      rec({ role: 'test', iteration: 2, findings: [finding('major')] }),
      rec({ role: 'test', iteration: 1 }),
    ]);
    expect(out.items[0].label).toMatchObject({ separateReviewBlocking: false });
  });

  it('skips tasks with no first-pass code or test record, or no diff', () => {
    const noFirst = ledgerToReviewerSetCorpus(
      [rec({ role: 'security' }), rec({ taskId: 'T-2', role: 'code', iteration: 2 })],
      () => INPUT,
    );
    expect(noFirst.items).toHaveLength(0);
    expect(noFirst.skipped.map((s) => s.taskId)).toEqual(['T-1', 'T-2']);
    const noDiff = ledgerToReviewerSetCorpus([rec({})], () => undefined);
    expect(noDiff.skipped).toEqual([{ taskId: 'T-1', reason: 'diff unavailable' }]);
  });

  it('groups per task and tolerates a record without findings', () => {
    const out = convert([
      rec({ taskId: 'A', findings: [finding('major')] }),
      rec({ taskId: 'B', prNumber: null, role: 'test', findings: undefined as never }),
    ]);
    expect(out.items.map((i) => (i.label as { taskId: string }).taskId)).toEqual(['A', 'B']);
    expect(hasFirstPassBlockingFinding([rec({ findings: undefined as never })])).toBe(false);
  });

  it('serialises to the JSONL eval reads', () => {
    const text = corpusToJsonl(convert([rec({})]).items);
    const row = JSON.parse(text.trim());
    expect(Object.keys(row)).toEqual(['input', 'label']);
  });
});

describe('cli-judgment eval review.reviewer-set on the converter output', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'reviewer-set-eval-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('runs with a fake provider and counts the blocking PR as a disagreement', async () => {
    const records = [
      rec({ taskId: 'A' }),
      rec({ taskId: 'B', role: 'test', findings: [finding('critical')] }),
      rec({ taskId: 'C' }),
    ];
    const { items } = ledgerToReviewerSetCorpus(records, (pr) =>
      reviewerSetInputFromDiff(DIFF + `+// ${pr.taskId}\n`),
    );
    const corpus = join(tmp, 'corpus.jsonl');
    writeFileSync(corpus, corpusToJsonl(items));

    const fake = new FakeJudgmentProvider();
    for (const id of REVIEWER_SET_SIGNAL_IDS) fake.script(id, { type: 'noul', probability: 0.01 });
    const key = 'fake@fake-1';
    const config = resolveJudgmentConfig({
      spec: {
        provider: 'fake',
        model: 'fake-1',
        egress: { allow: ['code-diff'] },
        judgments: {
          'review.reviewer-set': {
            thresholds: { [key]: Object.fromEntries(REVIEWER_SET_SIGNAL_IDS.map((i) => [i, 0.3])) },
          },
        },
      },
    });
    let out = '';
    let err = '';
    const code = await runJudgmentCli(
      ['eval', 'review.reviewer-set', '--corpus', corpus, '--artifacts-dir', join(tmp, 'art')],
      {
        out: (t) => (out += t),
        err: (t) => (err += t),
        cwd: tmp,
        env: {},
        now: () => new Date('2026-10-14T12:00:00Z'),
        loadConfig: () => config,
        getProvider: () => fake,
      },
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(fake.requests).toHaveLength(3);
    expect(out).toContain('n: 3');
    const report = JSON.parse(
      readFileSync(
        join(tmp, '.ai-sdlc', 'judgment-evals', 'review.reviewer-set-fake-fake-1-2026-10-14.json'),
        'utf8',
      ),
    );
    expect(report.riskClass).toBe('relax');
    expect(report.counts.act).toBe(3);
    expect(report.actAgreeing).toBe(2);
    expect(report.actBandPrecision).toBe(0.6667);
    expect(getJudgmentDefinition('review.reviewer-set')).toBeDefined();
  });
});

describe('gitDiffInputResolver and the reviewer-set-corpus command', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'reviewer-set-git-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'dev@example.invalid');
    git('config', 'user.name', 'Dev');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), '1\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'a.txt'), '2\n');
    git('commit', '-qam', 'change');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('resolves the diff for a recorded commit and fails closed otherwise', () => {
    const sha = git('rev-parse', 'HEAD').trim();
    const resolve = gitDiffInputResolver(repo, 'main');
    expect(resolve({ taskId: 'T', prNumber: 1, commitSha: sha })?.changedFiles).toEqual(['a.txt']);
    expect(resolve({ taskId: 'T', prNumber: 1, commitSha: 'not-a-sha' })).toBeUndefined();
    expect(resolve({ taskId: 'T', prNumber: 1, commitSha: 'f'.repeat(40) })).toBeUndefined();
    const same = git('rev-parse', 'main').trim();
    expect(resolve({ taskId: 'T', prNumber: 1, commitSha: same })).toBeUndefined();
  });

  it('the command writes the corpus from a ledger', async () => {
    const sha = git('rev-parse', 'HEAD').trim();
    mkdirSync(join(repo, '.ai-sdlc', 'reviews'), { recursive: true });
    writeFileSync(
      join(repo, '.ai-sdlc', 'reviews', 't.jsonl'),
      JSON.stringify(rec({ commitSha: sha, findings: [finding('major')] })) + '\n',
    );
    const outFile = join(repo, 'corpus.jsonl');
    await buildReviewsCli([
      'reviewer-set-corpus',
      '--repo-root',
      repo,
      '--base-ref',
      'main',
      '--out',
      outFile,
    ]).parseAsync();
    const row = JSON.parse(readFileSync(outFile, 'utf8').trim());
    expect(row.label.separateReviewBlocking).toBe(true);
    expect(row.input.changedFiles).toEqual(['a.txt']);
  });
});
