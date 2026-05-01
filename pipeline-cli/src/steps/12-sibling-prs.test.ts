import { describe, expect, it } from 'vitest';
import { siblingPrs } from './12-sibling-prs.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import type { DeveloperReturn, TaskSpec } from '../types.js';

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

const dev = (filesChangedExternal?: DeveloperReturn['filesChangedExternal']): DeveloperReturn => ({
  summary: 's',
  filesChanged: ['a.ts'],
  filesChangedExternal,
  commitSha: 'abc',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
});

describe('Step 12 — siblingPrs', () => {
  it('returns no prs when filesChangedExternal is empty', async () => {
    const r = await siblingPrs({
      taskId: 'AISDLC-1',
      workDir: '/tmp',
      task,
      developerReturn: dev(),
      mainPrUrl: 'https://x/1',
    });
    expect(r.prs).toEqual([]);
  });

  it('opens a PR per dirty sibling repo', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --show-toplevel/, ok('/sib\n'))
      .on(/status --porcelain/, ok(' M file.txt\n'))
      .on(/repo view --json nameWithOwner/, ok('owner/repo\n'))
      .on(/checkout -b/, ok())
      .on(/git -C \/sib add/, ok())
      .on(/git -C \/sib commit/, ok())
      .on(/git -C \/sib push/, ok())
      .on(/^gh -R owner\/repo pr create/, ok('https://github.com/owner/repo/pull/9\n'));
    const r = await siblingPrs({
      taskId: 'AISDLC-1',
      workDir: '/tmp',
      task,
      developerReturn: dev([{ repo: '/sib', files: ['file.txt'] }]),
      mainPrUrl: 'https://x/1',
      runner: fake.toRunner(),
    });
    expect(r.prs).toHaveLength(1);
    expect(r.prs[0].prUrl).toBe('https://github.com/owner/repo/pull/9');
  });

  it('skips siblings that are not git repos', async () => {
    const fake = new FakeRunner().on(
      /rev-parse --show-toplevel/,
      fail('fatal: not a git repo', 128),
    );
    const r = await siblingPrs({
      taskId: 'AISDLC-1',
      workDir: '/tmp',
      task,
      developerReturn: dev([{ repo: '/notrepo', files: ['x'] }]),
      mainPrUrl: 'https://x/1',
      runner: fake.toRunner(),
    });
    expect(r.prs[0].reason).toMatch(/not a git repository/);
  });

  it('skips siblings with no dirty files', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --show-toplevel/, ok('/sib\n'))
      .on(/status --porcelain/, ok(''));
    const r = await siblingPrs({
      taskId: 'AISDLC-1',
      workDir: '/tmp',
      task,
      developerReturn: dev([{ repo: '/sib', files: ['x'] }]),
      mainPrUrl: 'https://x/1',
      runner: fake.toRunner(),
    });
    expect(r.prs[0].reason).toMatch(/no dirty files/);
  });

  it('skips siblings without gh auth', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --show-toplevel/, ok('/sib\n'))
      .on(/status --porcelain/, ok(' M f\n'))
      .on(/repo view/, fail('gh: auth required', 1));
    const r = await siblingPrs({
      taskId: 'AISDLC-1',
      workDir: '/tmp',
      task,
      developerReturn: dev([{ repo: '/sib', files: ['x'] }]),
      mainPrUrl: 'https://x/1',
      runner: fake.toRunner(),
    });
    expect(r.prs[0].reason).toMatch(/gh auth not configured/);
  });

  it('reports failure but does not throw on commit failure', async () => {
    const fake = new FakeRunner()
      .on(/rev-parse --show-toplevel/, ok('/sib\n'))
      .on(/status --porcelain/, ok(' M f\n'))
      .on(/repo view/, ok('o/r\n'))
      .on(/checkout -b/, ok())
      .on(/git -C \/sib add/, ok())
      .on(/git -C \/sib commit/, fail('nothing to commit', 1));
    const r = await siblingPrs({
      taskId: 'AISDLC-1',
      workDir: '/tmp',
      task,
      developerReturn: dev([{ repo: '/sib', files: ['x'] }]),
      mainPrUrl: 'https://x/1',
      runner: fake.toRunner(),
    });
    expect(r.prs[0].prUrl).toBeNull();
    expect(r.prs[0].reason).toMatch(/git commit failed/);
  });
});
