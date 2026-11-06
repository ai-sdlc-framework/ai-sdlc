import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PRIORITY_RANK } from '../hierarchy/brief.js';
import {
  claimNext,
  ensureBoardDirs,
  peekQueueOrder,
  rankingShadow,
  writeManifest,
} from './board.js';
import { ageBonus, compareRankKeys, readRankingMode, shadowLine } from './ranking.js';
import type { DispatchManifest } from './types.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function mkRepo(
  mode: string | null,
  tasks: { id: string; priority: string; deps?: string[] }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ranking-'));
  roots.push(root);
  mkdirSync(path.join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(path.join(root, '.ai-sdlc'), { recursive: true });
  if (mode) writeFileSync(path.join(root, '.ai-sdlc', 'dispatch.yaml'), `ranking: ${mode}\n`);
  for (const t of tasks) {
    const deps = t.deps?.length
      ? `dependencies:\n${t.deps.map((d) => `  - ${d}`).join('\n')}\n`
      : '';
    writeFileSync(
      path.join(root, 'backlog', 'tasks', `${t.id.toLowerCase()} - t.md`),
      `---\nid: ${t.id}\ntitle: t\nstatus: To Do\npriority: ${t.priority}\n${deps}---\n`,
    );
  }
  return path.join(root, '.ai-sdlc', 'dispatch');
}

function manifest(taskId: string, o: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'any',
    dispatchedAt: '2026-11-01T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', budgetMs: 1, verifyCommands: [] },
    ...o,
  } as DispatchManifest;
}

function enqueue(
  board: string,
  ms: Record<string, number>,
  o: Record<string, Partial<DispatchManifest>> = {},
) {
  ensureBoardDirs(board);
  for (const id of Object.keys(ms)) {
    const file = writeManifest(board, manifest(id, o[id]));
    utimesSync(file, ms[id] / 1000, ms[id] / 1000);
  }
}

const fixture = [
  { id: 'AISDLC-1', priority: 'low' },
  { id: 'AISDLC-2', priority: 'critical', deps: ['AISDLC-1'] },
  { id: 'AISDLC-3', priority: 'high' },
];

describe('effective-priority ranking', () => {
  it('claims a low leaf that unblocks a critical task before an unrelated high task', () => {
    const board = mkRepo('effective-priority', fixture);
    enqueue(
      board,
      { 'AISDLC-3': 1000, 'AISDLC-1': 2000 },
      { 'AISDLC-3': { priority: 1 }, 'AISDLC-1': { priority: 3 } },
    );
    const res = claimNext(board, 'claude-p-shell');
    expect(res.manifest?.taskId).toBe('AISDLC-1');
  });

  it('legacy mode keeps the old order and reports the divergence', () => {
    const board = mkRepo(null, fixture);
    enqueue(
      board,
      { 'AISDLC-3': 1000, 'AISDLC-1': 2000 },
      { 'AISDLC-3': { priority: 1 }, 'AISDLC-1': { priority: 3 } },
    );
    expect(peekQueueOrder(board).map((e) => e.taskId)).toEqual(['AISDLC-3', 'AISDLC-1']);
    expect(rankingShadow(board)).toBe(
      'ranking: diverges at position 1: legacy AISDLC-3, effective-priority AISDLC-1',
    );
  });

  it('ties order by critical path, then id; mtime never matters', () => {
    const tasks = [
      { id: 'AISDLC-10', priority: 'medium' },
      { id: 'AISDLC-11', priority: 'medium' },
      { id: 'AISDLC-12', priority: 'medium' },
      { id: 'AISDLC-13', priority: 'medium', deps: ['AISDLC-12'] },
    ];
    const orders = [
      { 'AISDLC-10': 1, 'AISDLC-11': 2, 'AISDLC-12': 3 },
      { 'AISDLC-10': 3, 'AISDLC-11': 2, 'AISDLC-12': 1 },
    ].map((m) => {
      const board = mkRepo('effective-priority', tasks);
      enqueue(board, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v * 1e6])));
      return peekQueueOrder(board).map((e) => e.taskId);
    });
    expect(orders[0]).toEqual(['AISDLC-12', 'AISDLC-10', 'AISDLC-11']);
    expect(orders[1]).toEqual(orders[0]);
  });

  it('shadow line says identical when orders agree', () => {
    const board = mkRepo(null, [{ id: 'AISDLC-1', priority: 'high' }]);
    enqueue(board, { 'AISDLC-1': 1000 });
    expect(rankingShadow(board)).toBe('ranking: identical');
  });

  it('shadow is absent in effective-priority mode', () => {
    const board = mkRepo('effective-priority', []);
    expect(rankingShadow(board)).toBeUndefined();
  });
});

describe('ranking helpers', () => {
  it('PRIORITY_RANK covers all four levels with critical first', () => {
    expect(PRIORITY_RANK).toEqual({ critical: 0, high: 1, medium: 2, low: 3 });
  });

  it('critical sorts first in legacy mode', () => {
    const board = mkRepo(null, []);
    enqueue(
      board,
      { 'AISDLC-1': 1000, 'AISDLC-2': 2000 },
      {
        'AISDLC-1': { priority: PRIORITY_RANK.low },
        'AISDLC-2': { priority: PRIORITY_RANK.critical },
      },
    );
    expect(peekQueueOrder(board)[0].taskId).toBe('AISDLC-2');
  });

  it('age bonus clamps and orders ties before id', () => {
    const now = Date.parse('2027-01-01T00:00:00Z');
    expect(ageBonus(undefined, now)).toBe(0);
    expect(ageBonus('2026-12-25T00:00:00Z', now)).toBe(0);
    expect(ageBonus('2020-01-01T00:00:00Z', now)).toBe(1);
    const k = { wave: 0, effectivePriority: 2, criticalPathLength: 0, id: 'B' };
    expect(compareRankKeys({ ...k, ageBonus: 1 }, { ...k, ageBonus: 0, id: 'A' })).toBeLessThan(0);
    expect(compareRankKeys({ ...k, ageBonus: 0 }, { ...k, ageBonus: 0, id: 'A' })).toBeGreaterThan(
      0,
    );
  });

  it('readRankingMode tolerates bad config and no root', () => {
    expect(readRankingMode(undefined)).toBe('legacy');
    const board = mkRepo(null, []);
    const root = path.dirname(path.dirname(board));
    writeFileSync(path.join(root, '.ai-sdlc', 'dispatch.yaml'), ': : [');
    expect(readRankingMode(root)).toBe('legacy');
  });

  it('shadowLine handles unequal lengths', () => {
    expect(shadowLine(['A'], ['A', 'B'])).toContain('legacy -');
  });
});
