import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFinalSummary, finalizeTask, moveTaskToCompleted } from './10-finalize.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';
import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';
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
  acceptanceCriteria: ['a', 'b', 'c'],
  acceptanceCriteriaChecked: [false, false, false],
  description: 'desc',
  rawBody: '',
  filePath: '',
};

const dev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts', 'b.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2, 3],
  notes: 'no follow-up needed',
};

function approved(): AggregatedVerdict {
  return {
    approved: true,
    decision: 'APPROVED',
    counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    verdicts: [],
    harnessNote: '',
    summary: 'APPROVED',
  };
}

function blocked(): AggregatedVerdict {
  return {
    approved: false,
    decision: 'CHANGES_REQUESTED',
    counts: { critical: 1, major: 0, minor: 0, suggestion: 0 },
    verdicts: [],
    harnessNote: '',
    summary: 'CHANGES_REQUESTED',
  };
}

describe('Step 10 — buildFinalSummary', () => {
  it('renders the canonical CLAUDE.md template', () => {
    const r = buildFinalSummary({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
    });
    expect(r.acceptanceCriteriaCheck).toEqual([1, 2, 3]);
    expect(r.finalSummary).toContain('## Summary');
    expect(r.finalSummary).toContain('shipped X');
    expect(r.finalSummary).toContain('- a.ts');
    expect(r.finalSummary).toContain('passed');
    expect(r.finalSummary).toContain('## Follow-up');
  });

  it('defaults acceptanceCriteriaCheck to all ACs when developer reports none', () => {
    const r = buildFinalSummary({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: { ...dev, acceptanceCriteriaMet: [] },
      verdict: approved(),
      iterations: 1,
    });
    expect(r.acceptanceCriteriaCheck).toEqual([1, 2, 3]);
  });

  it('appends harness note when present', () => {
    const r = buildFinalSummary({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: { ...approved(), harnessNote: '⚠ test note' },
      iterations: 1,
    });
    expect(r.finalSummary).toContain('⚠ test note');
  });
});

describe('Step 10 — moveTaskToCompleted', () => {
  it('moves the file from tasks/ to completed/', () => {
    const path = writeTaskFile(tmp, { id: 'AISDLC-2', title: 'm', status: 'In Progress' });
    const dest = moveTaskToCompleted(path);
    expect(dest).toBe(join(tmp, 'backlog', 'completed', 'aisdlc-2 - m.md'));
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

describe('Step 10 — finalizeTask', () => {
  it('skips entirely when verdict is not APPROVED', async () => {
    const r = await finalizeTask({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: blocked(),
      iterations: 2,
      skipCommit: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.choreCommitSha).toBeNull();
  });

  it('flips status to Done + moves file when APPROVED', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-3', title: 'three', status: 'In Progress' });
    const fake = new FakeRunner();
    const r = await finalizeTask({
      taskId: 'AISDLC-3',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      skipCommit: true,
    });
    expect(r.skipped).toBe(false);
    const completedPath = join(tmp, 'backlog', 'completed', 'aisdlc-3 - three.md');
    expect(existsSync(completedPath)).toBe(true);
    expect(readFileSync(completedPath, 'utf8')).toContain('status: Done');
  });

  it('runs git add + commit when skipCommit is false', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-4', title: 'four', status: 'In Progress' });
    const fake = new FakeRunner()
      .on(/^git add/, ok())
      .on(/^git commit/, ok())
      .on(/^git rev-parse --short HEAD/, ok('1234567\n'));
    const r = await finalizeTask({
      taskId: 'AISDLC-4',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
    });
    expect(r.choreCommitSha).toBe('1234567');
  });

  it('throws when task file is absent', async () => {
    await expect(
      finalizeTask({
        taskId: 'AISDLC-NOPE',
        workDir: tmp,
        worktreePath: tmp,
        task,
        developerReturn: dev,
        verdict: approved(),
        iterations: 1,
        skipCommit: true,
      }),
    ).rejects.toThrow(/cannot locate task file/);
  });
});
