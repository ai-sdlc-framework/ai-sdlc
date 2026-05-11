import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeBody, composeTitle, pushAndPr, readTitleTemplate } from './11-push-and-pr.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';

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
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};

const dev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
};

const approved: AggregatedVerdict = {
  approved: true,
  decision: 'APPROVED',
  counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
  verdicts: [
    {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: true,
      findings: [],
      summary: 'lgtm',
    },
  ],
  harnessNote: '',
  summary: 'APPROVED',
};

describe('Step 11 — readTitleTemplate', () => {
  it('returns default when yaml missing', () => {
    expect(readTitleTemplate('/no/such')).toMatch(/feat: \{issueTitle\}/);
  });

  it('reads pullRequest.titleTemplate from legacy pipeline-backlog.yaml (deprecated shim)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `pullRequest:\n  titleTemplate: 'fix: {issueTitle} ({issueId})'\n`,
    );
    expect(readTitleTemplate(tmp)).toBe('fix: {issueTitle} ({issueId})');
  });

  it('reads pullRequest.titleTemplate from pipeline.yaml spec.backlog section (canonical, AISDLC-245.5)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'spec:',
        '  backlog:',
        '    pullRequest:',
        "      titleTemplate: 'chore: {issueTitle} ({issueId})'",
      ].join('\n') + '\n',
    );
    expect(readTitleTemplate(tmp)).toBe('chore: {issueTitle} ({issueId})');
  });

  it('prefers pipeline.yaml over pipeline-backlog.yaml for title template (canonical wins)', () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      [
        'spec:',
        '  backlog:',
        '    pullRequest:',
        "      titleTemplate: 'canonical: {issueTitle}'",
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `pullRequest:\n  titleTemplate: 'legacy: {issueTitle}'\n`,
    );
    expect(readTitleTemplate(tmp)).toBe('canonical: {issueTitle}');
  });
});

describe('Step 11 — composeTitle', () => {
  it('substitutes both vars', () => {
    expect(composeTitle('{issueTitle} ({issueId})', 'AISDLC-1', 'demo', false)).toBe(
      'demo (AISDLC-1)',
    );
  });

  it('appends [needs-human-attention] when flagged', () => {
    expect(composeTitle('{issueTitle} ({issueId})', 'AISDLC-1', 'demo', true)).toBe(
      'demo [needs-human-attention] (AISDLC-1)',
    );
  });
});

describe('Step 11 — composeBody', () => {
  it('produces a body with summary, files, and code-reviewer block', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
    });
    expect(body).toContain('shipped X');
    expect(body).toContain('- a.ts');
    expect(body).toContain('Code reviewer verdict');
    expect(body).toContain('lgtm');
    expect(body).toContain('References AISDLC-1');
  });

  it('opens with the [needs-human-attention] warning when flagged', () => {
    const body = composeBody({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      needsHumanAttention: true,
    });
    expect(body).toMatch(/⚠ This PR exceeded the auto-iteration cap/);
  });
});

describe('Step 11 — pushAndPr', () => {
  it('happy path returns prUrl', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBe('https://github.com/x/y/pull/1');
  });

  // AISDLC-218: regression guard — `gh pr create` must include `--draft`.
  // Without this assertion, removing the flag wouldn't be caught by any
  // other test in the suite (the `/^gh pr create/` matcher is permissive).
  it('opens the PR as DRAFT (AISDLC-218 regression guard)', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/x/y/pull/1\n'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    const ghPrCreateCall = fake.calls.find(
      (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create',
    );
    expect(ghPrCreateCall, '`gh pr create` must be invoked').toBeDefined();
    expect(
      ghPrCreateCall!.args.includes('--draft'),
      `gh pr create args must include --draft (AISDLC-218); got: ${ghPrCreateCall!.args.join(' ')}`,
    ).toBe(true);
  });

  it('returns pushed=false with reason on non-fast-forward', async () => {
    const fake = new FakeRunner().on(
      /^git push -u origin/,
      fail('! [rejected] b -> b (non-fast-forward)\nerror: failed to push some refs', 1),
    );
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(false);
    expect(r.reason).toMatch(/non-fast-forward/);
  });

  it('returns prUrl=null when gh pr create fails', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, fail('gh: bad token', 1));
    const r = await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    expect(r.pushed).toBe(true);
    expect(r.prUrl).toBeNull();
    expect(r.reason).toMatch(/gh pr create failed/);
  });

  it('does NOT call git push --force under any circumstance', async () => {
    const fake = new FakeRunner()
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://example/1'));
    await pushAndPr({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      branch: 'b',
      task,
      developerReturn: dev,
      verdict: approved,
      runner: fake.toRunner(),
    });
    const dangerous = fake.calls.find(
      (c) => c.command === 'git' && c.args.some((a) => a === '--force' || a === '-f'),
    );
    expect(dangerous).toBeUndefined();
  });
});
