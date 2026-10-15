import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeBranchName } from '../steps/02-compute-branch.js';
import { parseTaskFile } from '../steps/01-validate.js';
import { enqueueTasks } from './enqueue.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'enqueue-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('enqueue and Step 2 share one branch name (AISDLC-851)', () => {
  it('writes the branch Step 2 computes for the same task', async () => {
    const rel = 'backlog/tasks/AISDLC-9 - A fix: the thing.md';
    mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      path.join(root, rel),
      '---\nid: AISDLC-9\ntitle: >-\n  A fix: the thing\nstatus: To Do\n---\n\n## Description\n\nx\n',
    );
    const board = path.join(root, 'board');
    const [written] = enqueueTasks(board, [{ taskId: 'AISDLC-9' }], {
      baseSha: 'abc',
      dispatchedBy: 'test',
      resolveTaskFile: () => rel,
      workDir: root,
    });
    const manifest = JSON.parse(readFileSync(written!, 'utf8')) as { branch: string };
    const step2 = await computeBranchName({
      taskId: 'AISDLC-9',
      task: parseTaskFile(path.join(root, rel)),
      workDir: root,
    });
    expect(manifest.branch).toBe(step2.branch);
    expect(manifest.branch).toBe('ai-sdlc/aisdlc-9-a-fix-the-thing');
  });

  it('falls back to the file name title without a work dir', () => {
    const board = path.join(root, 'board');
    const [written] = enqueueTasks(board, [{ taskId: 'AISDLC-9' }], {
      baseSha: 'abc',
      dispatchedBy: 'test',
      resolveTaskFile: () => 'backlog/tasks/AISDLC-9 - Some title.md',
    });
    expect((JSON.parse(readFileSync(written!, 'utf8')) as { branch: string }).branch).toBe(
      'ai-sdlc/aisdlc-9-some-title',
    );
  });

  it('falls back to the file name when the task file cannot be parsed', () => {
    const board = path.join(root, 'board');
    const [written] = enqueueTasks(board, [{ taskId: 'AISDLC-9' }], {
      baseSha: 'abc',
      dispatchedBy: 'test',
      resolveTaskFile: () => 'backlog/tasks/AISDLC-9 - Missing file.md',
      workDir: root,
    });
    expect((JSON.parse(readFileSync(written!, 'utf8')) as { branch: string }).branch).toBe(
      'ai-sdlc/aisdlc-9-missing-file',
    );
  });
});
