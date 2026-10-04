import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewPrompts,
  parseBinaryNumstat,
  stubBinaryHunks,
} from './07-build-review-prompts.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import type { TaskSpec } from '../types.js';
import {
  FakeJudgmentProvider,
  REVIEWER_SET_SIGNAL_IDS,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';

let tmp: string;
let savedArts: string | undefined;
let savedUsage: string | undefined;
beforeEach(() => {
  tmp = makeTmpProject();
  savedArts = process.env.ARTIFACTS_DIR;
  savedUsage = process.env.AI_SDLC_USAGE_DIR;
  process.env.ARTIFACTS_DIR = join(tmp, 'arts');
  process.env.AI_SDLC_USAGE_DIR = join(tmp, 'usage');
});
afterEach(() => {
  cleanupTmpProject(tmp);
  if (savedArts === undefined) delete process.env.ARTIFACTS_DIR;
  else process.env.ARTIFACTS_DIR = savedArts;
  if (savedUsage === undefined) delete process.env.AI_SDLC_USAGE_DIR;
  else process.env.AI_SDLC_USAGE_DIR = savedUsage;
});

const task: TaskSpec = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'In Progress',
  acceptanceCriteria: ['a', 'b'],
  acceptanceCriteriaChecked: [false, false],
  description: 'demo desc',
  rawBody: '',
  filePath: '',
};

describe('Step 7 — buildReviewPrompts', () => {
  it('returns 3 reviewer prompts in canonical order', async () => {
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('--- diff content ---\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('a.ts\0b.ts\0'),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
    });
    expect(r.prompts).toHaveLength(3);
    expect(r.prompts.map((p) => p.reviewer)).toEqual([
      'code-reviewer',
      'test-reviewer',
      'security-reviewer',
    ]);
    expect(r.changedFiles).toEqual(['a.ts', 'b.ts']);
    expect(r.diff).toContain('diff content');
  });

  it('returns the resolved model per reviewer (security on opus, others on sonnet)', async () => {
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('d\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('a.ts\0'),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
      artifactsDir: join(tmp, 'arts'),
    });
    expect(r.prompts.map((p) => [p.reviewer, p.model, p.modelArm])).toEqual([
      ['code-reviewer', 'claude-sonnet-4-6', 'default'],
      ['test-reviewer', 'claude-sonnet-4-6', 'default'],
      ['security-reviewer', 'claude-opus-4-6', 'default'],
    ]);
  });

  it('records the routing assignment by default and leaves no trace when recordRouting is false', async () => {
    const mk = () =>
      new FakeRunner()
        .on(
          /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
          ok('--- diff content ---\n'),
        )
        .on(
          /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
          ok('a.ts\0'),
        );
    const base = {
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      codexAvailable: false,
      artifactsDir: join(tmp, 'arts'),
    };
    await buildReviewPrompts({ ...base, runner: mk().toRunner(), recordRouting: false });
    expect(existsSync(join(tmp, 'arts', '_routing', 'assignments.jsonl'))).toBe(false);
    await buildReviewPrompts({ ...base, runner: mk().toRunner() });
    expect(existsSync(join(tmp, 'arts', '_routing', 'assignments.jsonl'))).toBe(true);
  });

  // AISDLC-617 — opt-in merged reviewer set: exactly 2 reviewers. Opted in
  // via the operator/CI-controlled env var (the only trusted A/B lever from
  // inside a PR-controlled worktree — see the security test below).
  it('returns exactly 2 reviewer prompts (correctness + security) when AI_SDLC_REVIEWER_SET=code-test-merged', async () => {
    const prevEnv = process.env.AI_SDLC_REVIEWER_SET;
    process.env.AI_SDLC_REVIEWER_SET = 'code-test-merged';
    try {
      const fake = new FakeRunner()
        .on(
          /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
          ok('--- diff content ---\n'),
        )
        .on(
          /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
          ok('a.ts\0b.ts\0'),
        );
      const r = await buildReviewPrompts({
        taskId: 'AISDLC-1',
        task,
        branch: 'b',
        worktreePath: tmp,
        workDir: tmp,
        runner: fake.toRunner(),
        codexAvailable: false,
      });
      expect(r.prompts).toHaveLength(2);
      expect(r.prompts.map((p) => p.reviewer)).toEqual([
        'correctness-reviewer',
        'security-reviewer',
      ]);
    } finally {
      if (prevEnv === undefined) delete process.env.AI_SDLC_REVIEWER_SET;
      else process.env.AI_SDLC_REVIEWER_SET = prevEnv;
    }
  });

  // AISDLC-617 AC-4 — default reviewerSet is unchanged (three) even with an
  // unrelated config file present.
  it('still returns 3 reviewers by default when no reviewerSet flag is set', async () => {
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('--- diff content ---\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok(''),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
    });
    expect(r.prompts).toHaveLength(3);
  });

  // AISDLC-617 round-2 SECURITY fix — a `.ai-sdlc/review-config.yaml`
  // committed inside the PR-controlled worktree (opts.workDir) MUST NOT opt
  // the PR into the shallower 2-reviewer set. Only origin/main's committed
  // config (or the env var) can opt in. `tmp` here is a plain fixture dir,
  // not a git repo, so the trusted `git show origin/main:...` read
  // necessarily fails closed to the default three-reviewer set — exactly
  // the fail-safe behavior required even when origin/main is unreachable.
  it('SECURITY: a worktree-local review-config.yaml does NOT opt the PR into the merged set', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(tmp, '.ai-sdlc', 'review-config.yaml'), 'reviewerSet: code-test-merged\n');
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('--- diff content ---\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('a.ts\0b.ts\0'),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
    });
    expect(r.prompts).toHaveLength(3);
    expect(r.prompts.map((p) => p.reviewer)).toEqual([
      'code-reviewer',
      'test-reviewer',
      'security-reviewer',
    ]);
  });

  // AISDLC-606 — diff against the resolved target branch, not a hardcoded
  // origin/main.
  it('diffs against the resolved target branch when spec.branching.targetBranch is configured', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      ['spec:', '  branching:', '    targetBranch: develop'].join('\n') + '\n',
    );
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/develop\.\.\.HEAD$/,
        ok('--- develop diff ---\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/develop\.\.\.HEAD$/,
        ok('a.ts\0'),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
    });
    expect(r.diff).toContain('develop diff');
    expect(r.changedFiles).toEqual(['a.ts']);
  });

  it('emits an INDEPENDENCE warning when codex is not available', async () => {
    const fake = new FakeRunner();
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
    });
    expect(r.harnessNote).toMatch(/INDEPENDENCE NOT ENFORCED/);
    expect(r.prompts[0].prompt).toMatch(/INDEPENDENCE NOT ENFORCED/);
  });

  it('omits INDEPENDENCE warning when codex is available', async () => {
    const fake = new FakeRunner();
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: true,
    });
    expect(r.harnessNote).toBe('');
    expect(r.prompts[0].prompt).not.toMatch(/INDEPENDENCE/);
  });

  it('includes review-policy.md content when present', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(tmp, '.ai-sdlc', 'review-policy.md'), 'POLICY: be strict');
    const fake = new FakeRunner();
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: true,
    });
    expect(r.prompts[0].prompt).toContain('POLICY: be strict');
  });

  it('autodetects codex via `which`', async () => {
    const fake = new FakeRunner().on(/^which codex/, ok('/usr/local/bin/codex\n'));
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
    });
    expect(r.harnessNote).toBe('');
  });
});

describe('Step 7 — judgment-driven reviewer selection', () => {
  const judgmentCtx = (mode: 'shadow' | 'enforce', routing = 0): EvaluateJudgmentContext => {
    const fake = new FakeJudgmentProvider();
    for (const id of REVIEWER_SET_SIGNAL_IDS) {
      fake.script(id, { type: 'noul', probability: 0.01 });
    }
    for (const id of ['auth-session-secrets', 'input-handling', 'dependencies-ci']) {
      fake.script(id, { type: 'noul', probability: routing });
    }
    const key = 'fake@fake-1';
    return {
      getProvider: () => fake,
      config: resolveJudgmentConfig({
        spec: {
          provider: 'fake',
          model: 'fake-1',
          egress: { allow: ['code-diff'] },
          judgments: {
            'review.reviewer-set': {
              mode,
              thresholds: {
                [key]: Object.fromEntries(REVIEWER_SET_SIGNAL_IDS.map((id) => [id, 0.3])),
              },
              promotion: { [key]: { path: 'corpus', n: 60, actBandPrecision: 0.97 } },
            },
            'review.routing': {
              mode,
              thresholds: { [key]: { 'input-handling': 0.5 } },
              promotion: { [key]: { path: 'override', evidence: 'reviewed' } },
            },
          },
        },
      }),
    };
  };

  const runWith = async (
    judgment: EvaluateJudgmentContext | undefined,
    sourceKind: 'backlog' | 'gh-issue' | undefined,
  ) => {
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('diff --git a/src/a.ts b/src/a.ts\n+x\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('src/a.ts\0'),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
      artifactsDir: join(tmp, 'arts'),
      ...(judgment ? { judgment } : {}),
      ...(sourceKind ? { sourceKind } : {}),
    });
    return r.prompts.map((p) => p.reviewer);
  };

  const THREE = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

  it('selects the merged set for a trusted backlog task in enforce', async () => {
    expect(await runWith(judgmentCtx('enforce'), 'backlog')).toEqual([
      'correctness-reviewer',
      'security-reviewer',
    ]);
  });

  it('keeps the three-reviewer default in shadow, for gh-issue, and with no sourceKind', async () => {
    expect(await runWith(judgmentCtx('shadow'), 'backlog')).toEqual(THREE);
    expect(await runWith(judgmentCtx('enforce'), 'gh-issue')).toEqual(THREE);
    expect(await runWith(judgmentCtx('enforce'), undefined)).toEqual(THREE);
    expect(await runWith(undefined, 'backlog')).toEqual(THREE);
  });

  it('review.routing adds reviewers back after the merged set is selected', async () => {
    const out = await runWith(judgmentCtx('enforce', 0.9), 'backlog');
    expect(out).toEqual([
      'correctness-reviewer',
      'security-reviewer',
      'test-reviewer',
      'code-reviewer',
    ]);
  });

  it('offline replay never reaches the judgment layer', async () => {
    const ctx = judgmentCtx('enforce');
    const fake = new FakeRunner()
      .on(
        /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('d\n'),
      )
      .on(
        /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
        ok('src/a.ts\0'),
      );
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
      sourceKind: 'backlog',
      recordRouting: false,
      judgment: ctx,
    });
    expect(r.prompts).toHaveLength(3);
  });

  const DIFF_RE =
    /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/;
  const FILES_RE =
    /^git -c core\.quotePath=false diff --name-only -z --no-renames --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/;
  const GOOD_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+x\n';

  const runner = (diff: ReturnType<typeof ok>, files: ReturnType<typeof ok>) =>
    new FakeRunner().on(DIFF_RE, diff).on(FILES_RE, files);

  const reviewersFor = async (fake: FakeRunner, judgment: EvaluateJudgmentContext) =>
    (
      await buildReviewPrompts({
        taskId: 'AISDLC-1',
        task,
        branch: 'b',
        worktreePath: tmp,
        workDir: tmp,
        runner: fake.toRunner(),
        codexAvailable: false,
        artifactsDir: join(tmp, 'arts'),
        sourceKind: 'backlog',
        judgment,
      })
    ).prompts.map((p) => p.reviewer);

  it('reads paths NUL-separated, unquoted, with both sides of renames', async () => {
    const fake = runner(ok(GOOD_DIFF), ok('src/a.ts\0src/é.ts\0'));
    await reviewersFor(fake, judgmentCtx('enforce'));
    const call = fake.calls.find((c) => c.args.includes('--name-only'));
    expect(call?.args).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      'origin/main...HEAD',
    ]);
  });

  it('a non-ASCII workflow path from git vetoes the merged set', async () => {
    const fake = runner(ok(GOOD_DIFF), ok('.github/workflows/déploy.yml\0'));
    expect(await reviewersFor(fake, judgmentCtx('enforce'))).toEqual(THREE);
  });

  it('a quoted path from git fails closed', async () => {
    const fake = runner(ok(GOOD_DIFF), ok('".github/workflows/d\\303\\251ploy.yml"\0'));
    expect(await reviewersFor(fake, judgmentCtx('enforce'))).toEqual(THREE);
  });

  it.each([
    ['a failed diff', fail('boom', 1), ok('src/a.ts\0')],
    ['a failed file list', ok(GOOD_DIFF), fail('boom', 1)],
    ['an empty diff with changed files', ok(''), ok('src/a.ts\0')],
  ])('%s never selects the merged set', async (_n, diff, files) => {
    expect(await reviewersFor(runner(diff, files), judgmentCtx('enforce'))).toEqual(THREE);
  });

  it('the control case still selects the merged set', async () => {
    expect(
      await reviewersFor(runner(ok(GOOD_DIFF), ok('src/a.ts\0')), judgmentCtx('enforce')),
    ).toEqual(['correctness-reviewer', 'security-reviewer']);
  });

  it('a backlog dispatch reaches the judgment as backlog; gh-issue never reaches it', async () => {
    const seen: (string | undefined)[] = [];
    const withSink = (): EvaluateJudgmentContext => ({
      ...judgmentCtx('enforce'),
      sinks: [{ record: (r) => void seen.push(`${r.judgmentId}:${r.sourceKind}`) }],
    });
    await reviewersFor(runner(ok(GOOD_DIFF), ok('src/a.ts\0')), withSink());
    expect(seen).toContain('review.reviewer-set:backlog');

    seen.length = 0;
    const fake = runner(ok(GOOD_DIFF), ok('src/a.ts\0'));
    const r = await buildReviewPrompts({
      taskId: 'AISDLC-1',
      task,
      branch: 'b',
      worktreePath: tmp,
      workDir: tmp,
      runner: fake.toRunner(),
      codexAvailable: false,
      artifactsDir: join(tmp, 'arts'),
      sourceKind: 'gh-issue',
      judgment: withSink(),
    });
    expect(r.prompts.map((p) => p.reviewer)).toEqual(THREE);
    expect(seen.some((x) => x?.startsWith('review.reviewer-set:'))).toBe(false);
  });

  it('iteration 2 never selects the merged set, iteration 1 does', async () => {
    const run = async (iteration: number) =>
      (
        await buildReviewPrompts({
          taskId: 'AISDLC-1',
          task,
          branch: 'b',
          worktreePath: tmp,
          workDir: tmp,
          runner: runner(ok(GOOD_DIFF), ok('src/a.ts\0')).toRunner(),
          codexAvailable: false,
          artifactsDir: join(tmp, 'arts'),
          sourceKind: 'backlog',
          iteration,
          judgment: judgmentCtx('enforce'),
        })
      ).prompts.map((p) => p.reviewer);
    expect(await run(1)).toEqual(['correctness-reviewer', 'security-reviewer']);
    expect(await run(2)).toEqual(THREE);
  });

  it('the diff command forces a text diff so a -diff attribute cannot hide content', async () => {
    const fake = runner(ok(GOOD_DIFF), ok('src/a.ts\0'));
    await reviewersFor(fake, judgmentCtx('enforce'));
    const call = fake.calls.find((c) => c.args.includes('diff') && !c.args.includes('--name-only'));
    expect(call?.args).toEqual([
      '-c',
      'core.quotePath=false',
      'diff',
      '--text',
      '--no-ext-diff',
      '--no-textconv',
      'origin/main...HEAD',
    ]);
  });

  it('with a committed `* -diff` .gitattributes the real diff still shows content', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rev-attr-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'dev@example.invalid');
      git('config', 'user.name', 'Dev');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, '.gitattributes'), '* -diff\n');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(join(repo, 'a.txt'), 'two changed\n');
      git('commit', '-qam', 'change');
      const r = await buildReviewPrompts({
        taskId: 'AISDLC-1',
        task,
        branch: 'feature',
        worktreePath: repo,
        workDir: repo,
        codexAvailable: false,
        artifactsDir: join(tmp, 'arts'),
        recordRouting: false,
      });
      expect(r.diff).toContain('+two changed');
      expect(r.diff).not.toMatch(/Binary files/);
      expect(r.changedFiles).toEqual(['a.txt']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('parses numstat binary rows and stubs NUL sections', () => {
    expect([...parseBinaryNumstat('-\t-\timg.png\0' + '1\t2\ta.ts\0')]).toEqual(['img.png']);
    const diff = 'diff --git a/a.ts b/a.ts\n+x\n' + 'diff --git a/b.bin b/b.bin\n+a\u0000b\n';
    const { diff: out, stubbed } = stubBinaryHunks(diff, new Set());
    expect(stubbed).toBe(true);
    expect(out).toContain('+x');
    expect(out).not.toContain('\u0000');
    expect(out).toContain('Binary files a/b.bin and b/b.bin differ');
  });

  it('a numstat binary row vetoes the merged set even when the text diff looks clean', async () => {
    const NUMSTAT_RE = /diff --numstat -z/;
    const fake = runner(ok(GOOD_DIFF), ok('src/a.ts\0')).on(NUMSTAT_RE, ok('-\t-\tsrc/a.ts\0'));
    // runner() registers DIFF/FILES first; numstat never matches those, so it reaches NUMSTAT_RE.
    expect(await reviewersFor(fake, judgmentCtx('enforce'))).toEqual(THREE);
  });

  it('a failed numstat call marks the diff unavailable and vetoes', async () => {
    const fake = runner(ok(GOOD_DIFF), ok('src/a.ts\0')).on(/diff --numstat -z/, fail('boom', 1));
    expect(await reviewersFor(fake, judgmentCtx('enforce'))).toEqual(THREE);
  });

  it('reports diffUnavailable so callers refuse to spawn reviewers', async () => {
    const call = async (diff: ReturnType<typeof ok>, files: ReturnType<typeof ok>) =>
      (
        await buildReviewPrompts({
          taskId: 'AISDLC-1',
          task,
          branch: 'b',
          worktreePath: tmp,
          workDir: tmp,
          runner: runner(diff, files).toRunner(),
          codexAvailable: false,
          recordRouting: false,
        })
      ).diffUnavailable;
    expect(await call(fail('boom', 1), ok('a.ts\0'))).toBe(true);
    expect(await call(ok(''), ok('a.ts\0'))).toBe(true);
    expect(await call(ok(GOOD_DIFF), ok('a.ts\0'))).toBe(false);
  });

  it('a NaN iteration never selects the merged set', async () => {
    const reviewers = (
      await buildReviewPrompts({
        taskId: 'AISDLC-1',
        task,
        branch: 'b',
        worktreePath: tmp,
        workDir: tmp,
        runner: runner(ok(GOOD_DIFF), ok('src/a.ts\0')).toRunner(),
        codexAvailable: false,
        artifactsDir: join(tmp, 'arts'),
        sourceKind: 'backlog',
        iteration: Number.NaN,
        judgment: judgmentCtx('enforce'),
      })
    ).prompts.map((p) => p.reviewer);
    expect(reviewers).toEqual(THREE);
  });

  it('real repo: a committed binary file (NUL bytes) vetoes the merged set and is stubbed in the prompt', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rev-bin-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'dev@example.invalid');
      git('config', 'user.name', 'Dev');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      writeFileSync(join(repo, 'blob.dat'), Buffer.from([0x50, 0x00, 0x01, 0x00, 0xff, 0x42]));
      git('add', '.');
      git('commit', '-q', '-m', 'change');
      const r = await buildReviewPrompts({
        taskId: 'AISDLC-1',
        task,
        branch: 'feature',
        worktreePath: repo,
        workDir: repo,
        codexAvailable: false,
        artifactsDir: join(tmp, 'arts'),
        sourceKind: 'backlog',
        judgment: judgmentCtx('enforce'),
      });
      expect(r.prompts.map((p) => p.reviewer)).toEqual(THREE);
      expect(r.diffUnavailable).toBe(false);
      expect(r.diff).toContain('+two');
      expect(r.diff).not.toContain('\u0000');
      expect(r.diff).toContain('Binary files a/blob.dat and b/blob.dat differ');
      for (const p of r.prompts) expect(p.prompt).not.toContain('\u0000');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('real repo: the same text change without a binary file still selects the merged set', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'rev-nobin-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'dev@example.invalid');
      git('config', 'user.name', 'Dev');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', '-q', '-b', 'feature');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      git('commit', '-qam', 'change');
      const r = await buildReviewPrompts({
        taskId: 'AISDLC-1',
        task,
        branch: 'feature',
        worktreePath: repo,
        workDir: repo,
        codexAvailable: false,
        artifactsDir: join(tmp, 'arts'),
        sourceKind: 'backlog',
        judgment: judgmentCtx('enforce'),
      });
      expect(r.prompts.map((p) => p.reviewer)).toEqual([
        'correctness-reviewer',
        'security-reviewer',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('stubBinaryHunks: diff headers', () => {
  const NUL = String.fromCharCode(0);

  it('stubs a binary section with the paths of a plain, renamed and " b/" header', () => {
    for (const [header, oldPath, newPath] of [
      ['diff --git a/x.bin b/x.bin', 'x.bin', 'x.bin'],
      ['diff --git a/old.bin b/new.bin', 'old.bin', 'new.bin'],
      ['diff --git a/dir b/x.bin b/dir b/x.bin', 'dir b/x.bin', 'dir b/x.bin'],
    ] as const) {
      const { diff, stubbed } = stubBinaryHunks(`${header}\n+a${NUL}b\n`, new Set());
      expect(stubbed).toBe(true);
      expect(diff).toBe(`${header}\nBinary files a/${oldPath} and b/${newPath} differ\n`);
    }
  });

  it('stubs an unreadable header without echoing it, and leaves text sections alone', () => {
    const { diff, stubbed } = stubBinaryHunks(`diff --git x/a y/b\n+a${NUL}b\n`, new Set());
    expect(stubbed).toBe(true);
    expect(diff).toBe('Binary files a/(unreadable) and b/(unreadable) differ\n');
    const text = 'diff --git a/a.ts b/a.ts\n+x\n';
    expect(stubBinaryHunks(text, new Set())).toEqual({ diff: text, stubbed: false });
  });

  it('stubs a huge listed-binary file by either of its header paths', () => {
    const big = 'x'.repeat(200_001);
    const section = `diff --git a/old.bin b/new.bin\n+${big}\n`;
    expect(stubBinaryHunks(section, new Set(['old.bin'])).stubbed).toBe(true);
    expect(stubBinaryHunks(section, new Set(['new.bin'])).stubbed).toBe(true);
    expect(stubBinaryHunks(section, new Set(['other.bin'])).stubbed).toBe(false);
  });

  it('handles a hostile header in linear time (the bound is generous)', () => {
    // The \r tail makes the OLD regex fail to match and backtrack quadratically.
    const time = (reps: number): number => {
      const body = `diff --git a/a b/${'a b/a'.repeat(reps)}`;
      const start = performance.now();
      for (let i = 0; i < 5; i++) {
        for (const tail of ['\n', '\r\n']) stubBinaryHunks(`${body}${tail}+x${NUL}y\n`, new Set());
      }
      return performance.now() - start;
    };
    const small = Math.max(time(20_000), 20);
    const large = time(80_000);
    expect(large / small).toBeLessThan(12);
    expect(large).toBeLessThan(5000);
  }, 30000);
});
