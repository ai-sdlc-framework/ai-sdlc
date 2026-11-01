import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyRebuild,
  backlogTaskIds,
  backupBoard,
  boardIsEmpty,
  boardRecoveryHint,
  classifyRebuild,
  listAllPrs,
  repoId,
  restoreBoard,
  rotateBackups,
  taskIdFromTitle,
  type RebuildPr,
} from './board-recovery.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'board-recovery-'));

const pr = (
  n: number,
  title: string,
  state: string,
  extra: Partial<RebuildPr> = {},
): RebuildPr => ({
  number: n,
  title,
  state,
  ...extra,
});

describe('classifyRebuild', () => {
  it('maps merged to done, open ready to failed, open draft to queued', () => {
    const plan = classifyRebuild(
      [
        pr(1, 'feat: a (AISDLC-1)', 'MERGED', { mergedAt: '2026-10-01T00:00:00Z' }),
        pr(2, 'feat: b (AISDLC-2)', 'OPEN'),
        pr(3, 'feat: c (AISDLC-3)', 'OPEN', { isDraft: true, headRefName: 'ai-sdlc/c' }),
        pr(4, 'feat: d (AISDLC-4)', 'CLOSED'),
        pr(5, 'no id here', 'MERGED'),
      ],
      ['AISDLC-9'],
    );
    expect(plan.counts).toEqual({ done: 2, failed: 1, queued: 1 });
    expect(plan.items.map((i) => [i.taskId, i.action])).toEqual([
      ['AISDLC-1', 'done'],
      ['AISDLC-2', 'failed'],
      ['AISDLC-3', 'queued'],
      ['AISDLC-9', 'done'],
    ]);
  });

  it('prefers an open PR over a merged one for the same task, in either order', () => {
    for (const prs of [
      [pr(1, 'x (AISDLC-1)', 'MERGED'), pr(2, 'x (AISDLC-1)', 'OPEN')],
      [pr(2, 'x (AISDLC-1)', 'OPEN'), pr(1, 'x (AISDLC-1)', 'MERGED')],
    ]) {
      const plan = classifyRebuild(prs, ['AISDLC-1']);
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0]?.action).toBe('failed');
    }
  });

  it('keeps the newest merged PR and skips active ids', () => {
    const plan = classifyRebuild(
      [
        pr(5, 'x (AISDLC-1)', 'MERGED'),
        pr(3, 'x (AISDLC-1)', 'MERGED'),
        pr(6, 'y (AISDLC-2)', 'MERGED'),
      ],
      [],
      ['AISDLC-2'],
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.prNumber).toBe(5);
  });
});

describe('taskIdFromTitle', () => {
  it('reads a trailing id, a dotted id, and falls back to any id', () => {
    expect(taskIdFromTitle('feat: x (AISDLC-12.3)')).toBe('AISDLC-12.3');
    expect(taskIdFromTitle('AISDLC-7 fix thing')).toBe('AISDLC-7');
    expect(taskIdFromTitle('nothing')).toBeUndefined();
  });
});

describe('applyRebuild and listing', () => {
  it('writes rebuilt verdicts and manifests and leaves existing entries alone', () => {
    const root = tmp();
    const board = path.join(root, 'board');
    const plan = classifyRebuild(
      [
        pr(1, 'a (AISDLC-1)', 'MERGED', { url: 'https://x/1' }),
        pr(2, 'b (AISDLC-2)', 'OPEN'),
        pr(3, 'c (AISDLC-3)', 'OPEN', { isDraft: true }),
      ],
      [],
    );
    const written = applyRebuild(plan, {
      boardDir: board,
      repoRoot: root,
      baseSha: 'abcdef1',
      now: new Date('2026-11-01T00:00:00Z'),
    });
    expect(written).toEqual({ done: 1, failed: 1, queued: 1 });
    const done = JSON.parse(
      readFileSync(path.join(board, 'done', 'AISDLC-1.verdict.json'), 'utf-8'),
    );
    expect(done).toMatchObject({ outcome: 'success', rebuilt: true, prNumber: 1 });
    expect(existsSync(path.join(board, 'failed', 'AISDLC-2.verdict.json'))).toBe(true);
    expect(existsSync(path.join(board, 'queue', 'AISDLC-3.dispatch.json'))).toBe(true);
    expect(
      applyRebuild(plan, { boardDir: board, repoRoot: root, baseSha: 'abcdef1', now: new Date() }),
    ).toEqual({ done: 0, failed: 0, queued: 0 });
  });

  it('reads task ids from a backlog directory', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'aisdlc-5 - thing.md'), '');
    writeFileSync(path.join(dir, 'README.txt'), '');
    expect(backlogTaskIds(dir)).toEqual(['AISDLC-5']);
    expect(backlogTaskIds(path.join(dir, 'missing'))).toEqual([]);
  });

  it('listAllPrs parses one gh call and throws on failure', () => {
    const ok = listAllPrs(
      () => ({ status: 0, stdout: '[{"number":1,"title":"t","state":"OPEN"}]', stderr: '' }),
      '.',
    );
    expect(ok).toHaveLength(1);
    expect(() => listAllPrs(() => ({ status: 1, stdout: '', stderr: 'rate' }), '.')).toThrow(
      /rate/,
    );
  });
});

describe('backup rotation', () => {
  const seed = (): string => {
    const board = path.join(tmp(), 'board');
    mkdirSync(path.join(board, 'done'), { recursive: true });
    writeFileSync(path.join(board, 'done', 'AISDLC-1.verdict.json'), '{}');
    return board;
  };

  it('writes once a day, keeps seven, and skips an empty board', () => {
    const board = seed();
    const dir = path.join(tmp(), 'backups');
    for (let d = 1; d <= 9; d++) {
      const r = backupBoard(
        board,
        dir,
        new Date(`2026-10-${String(d).padStart(2, '0')}T10:00:00Z`),
      );
      expect(r.status).toBe('written');
    }
    expect(backupBoard(board, dir, new Date('2026-10-09T23:00:00Z')).status).toBe('skipped-today');
    expect(readdirSync(dir).sort()).toHaveLength(7);
    expect(readdirSync(dir)).not.toContain('2026-10-01.tar.gz');
    expect(backupBoard(path.join(tmp(), 'empty'), dir, new Date()).status).toBe('skipped-empty');
    expect(rotateBackups(path.join(dir, 'nope'))).toEqual([]);
  });

  it('restores a backup, refusing a non-empty board without force', () => {
    const board = seed();
    const dir = path.join(tmp(), 'backups');
    const { file } = backupBoard(board, dir, new Date('2026-10-01T00:00:00Z'));
    const target = path.join(tmp(), 'restored');
    restoreBoard(file!, target);
    expect(existsSync(path.join(target, 'done', 'AISDLC-1.verdict.json'))).toBe(true);
    expect(() => restoreBoard(file!, target)).toThrow(/not empty/);
    restoreBoard(file!, target, true);
    expect(() => restoreBoard(path.join(dir, 'missing.tar.gz'), target)).toThrow(/not found/);
  });

  it('builds a stable repo id', () => {
    expect(repoId('/a/b/repo')).toBe(repoId('/a/b/repo'));
    expect(repoId('/a/b/repo')).toMatch(/^repo-[0-9a-f]{8}$/);
  });
});

describe('boardRecoveryHint', () => {
  it('hints only when the board is empty and backlog/completed is not', () => {
    const root = tmp();
    const board = path.join(root, '.ai-sdlc', 'dispatch');
    expect(boardRecoveryHint(board, root)).toBeNull();
    mkdirSync(path.join(root, 'backlog', 'completed'), { recursive: true });
    writeFileSync(path.join(root, 'backlog', 'completed', 'aisdlc-1 - x.md'), '');
    expect(boardRecoveryHint(board, root)).toContain('rebuild --from-github');
    mkdirSync(path.join(board, 'done'), { recursive: true });
    writeFileSync(path.join(board, 'done', 'AISDLC-1.verdict.json'), '{}');
    expect(boardIsEmpty(board)).toBe(false);
    expect(boardRecoveryHint(board, root)).toBeNull();
  });
});
