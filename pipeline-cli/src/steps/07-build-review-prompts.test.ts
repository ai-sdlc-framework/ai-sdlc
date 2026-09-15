import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewPrompts } from './07-build-review-prompts.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';
import type { TaskSpec } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
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
      .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
      .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\nb.ts\n'));
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

  // AISDLC-617 — opt-in merged reviewer set: exactly 2 reviewers. Opted in
  // via the operator/CI-controlled env var (the only trusted A/B lever from
  // inside a PR-controlled worktree — see the security test below).
  it('returns exactly 2 reviewer prompts (correctness + security) when AI_SDLC_REVIEWER_SET=code-test-merged', async () => {
    const prevEnv = process.env.AI_SDLC_REVIEWER_SET;
    process.env.AI_SDLC_REVIEWER_SET = 'code-test-merged';
    try {
      const fake = new FakeRunner()
        .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
        .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\nb.ts\n'));
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
      .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
      .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok(''));
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
      .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
      .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\nb.ts\n'));
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
      .on(/^git diff origin\/develop\.\.\.HEAD$/, ok('--- develop diff ---\n'))
      .on(/^git diff --name-only origin\/develop\.\.\.HEAD$/, ok('a.ts\n'));
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
