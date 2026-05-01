import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeBranchName, readBranchPattern, slugify } from './02-compute-branch.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type { TaskSpec } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const baseTask: TaskSpec = {
  id: 'AISDLC-100',
  title: 'My Heavy Task: extract step functions',
  status: 'To Do',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};

describe('Step 2 — computeBranchName', () => {
  it('uses the default pattern when no yaml', async () => {
    const r = await computeBranchName({ taskId: 'AISDLC-100', task: baseTask, workDir: tmp });
    expect(r.branch).toMatch(/^ai-sdlc\/aisdlc-100-/);
    expect(r.slug).toMatch(/^my-heavy-task/);
    expect(r.taskIdLower).toBe('aisdlc-100');
    expect(r.worktreePath).toBe(join(tmp, '.worktrees', 'aisdlc-100'));
  });

  it('reads pipeline-backlog.yaml when present', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: 'feat/{issueIdLower}/{slug}'\n`,
    );
    const r = await computeBranchName({ taskId: 'AISDLC-100', task: baseTask, workDir: tmp });
    expect(r.branch).toMatch(/^feat\/aisdlc-100\/my-heavy/);
  });

  it('respects defaultPattern override', async () => {
    const r = await computeBranchName({
      taskId: 'AISDLC-100',
      task: baseTask,
      workDir: tmp,
      defaultPattern: 'custom/{issueIdLower}',
    });
    expect(r.branch).toBe('custom/aisdlc-100');
  });
});

describe('Step 2 — slugify', () => {
  it('lowercases + kebabs', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });

  it('collapses non-alphanumeric runs', () => {
    expect(slugify('A:::B---C')).toBe('a-b-c');
  });

  it('caps at 50 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBe(50);
  });

  it('strips leading/trailing dashes', () => {
    expect(slugify('--abc--')).toBe('abc');
  });
});

describe('Step 2 — readBranchPattern', () => {
  it('returns fallback for missing yaml', () => {
    expect(readBranchPattern('/no/such', 'fb')).toBe('fb');
  });

  it('returns fallback when key absent', () => {
    writeFileSync(join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'), 'branching: {}\n');
    expect(readBranchPattern(tmp, 'fb')).toBe('fb');
  });

  it('handles double-quoted patterns', () => {
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline-backlog.yaml'),
      `branching:\n  pattern: "test/{slug}"\n`,
    );
    expect(readBranchPattern(tmp)).toBe('test/{slug}');
  });
});
