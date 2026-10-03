/**
 * Tests for the executor loop's board surface: claim by roster name, verdict
 * completion and sub-id allocation. Everything runs in temp directories; no
 * session, tmux server or network is touched.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDispatchCli } from '../cli/dispatch.js';
import { readInflightManifest, writeManifest } from './board.js';
import { completeTask, splitIdList } from './complete.js';
import { nextSubId } from './subid.js';
import type { DispatchManifest } from './types.js';

function mkManifest(taskId: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`, verifyCommands: ['pnpm build'] },
  };
}

let root: string;
let boardDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'executor-loop-'));
  boardDir = path.join(root, '.ai-sdlc', 'dispatch');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function cli(argv: string[], deps = {}): Promise<{ exit: number; stdout: string }> {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
    stdout += c.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
  const exit = await runDispatchCli(argv, deps);
  return { exit, stdout };
}

describe('claim by roster name', () => {
  it('records the roster name, suffix included, as the workerId', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-700'));
    const { exit } = await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-alpha-2',
    ]);
    expect(exit).toBe(0);
    expect(readInflightManifest(boardDir, 'AISDLC-700')?.workerId).toBe('executor-alpha-2');
  });
});

describe('completeTask', () => {
  it('lands a success verdict in done/ with pr, follow-ups and decisions', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-701'));
    await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-a',
    ]);
    const result = completeTask(boardDir, {
      taskId: 'AISDLC-701',
      outcome: 'success',
      workerId: 'executor-a',
      prNumber: 42,
      prUrl: 'https://example.test/pull/42',
      followUpIds: ['AISDLC-701.1'],
      decisionIds: ['DEC-1'],
      notes: 'ok',
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.state).toBe('done');
    const verdict = JSON.parse(readFileSync(result.verdictPath, 'utf-8'));
    expect(verdict).toMatchObject({
      taskId: 'AISDLC-701',
      outcome: 'success',
      workerId: 'executor-a',
      prNumber: 42,
      followUpIds: ['AISDLC-701.1'],
      decisionIds: ['DEC-1'],
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(readInflightManifest(boardDir, 'AISDLC-701')).toBeUndefined();
  });

  it('lands a failed verdict in failed/', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-702'));
    await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-a',
    ]);
    const result = completeTask(boardDir, {
      taskId: 'AISDLC-702',
      outcome: 'failed',
      workerId: 'executor-a',
      cause: 'verification-failed',
    });
    expect(result.state).toBe('failed');
    expect(result.verdictPath).toContain(`${path.sep}failed${path.sep}`);
    expect(existsSync(result.verdictPath)).toBe(true);
  });

  it('refuses bad input and a task that is not inflight', () => {
    const w = 'executor-a';
    expect(() =>
      completeTask(boardDir, { taskId: 'nope', outcome: 'success', workerId: w }),
    ).toThrow(/valid task id/);
    expect(() =>
      completeTask(boardDir, { taskId: 'AISDLC-1', outcome: 'meh', workerId: w }),
    ).toThrow(/outcome/);
    expect(() =>
      completeTask(boardDir, { taskId: 'AISDLC-1', outcome: 'success', prNumber: 0, workerId: w }),
    ).toThrow(/positive/);
    expect(() =>
      completeTask(boardDir, {
        taskId: 'AISDLC-1',
        outcome: 'success',
        followUpIds: ['AISDLC-2.1'],
        workerId: w,
      }),
    ).toThrow(/not a sub-id/);
    expect(() =>
      completeTask(boardDir, { taskId: 'AISDLC-1', outcome: 'success', workerId: w }),
    ).toThrow(/not inflight/);
  });

  it('refuses to complete a task that has no recorded claim holder', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-703'));
    await cli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    expect(() =>
      completeTask(boardDir, { taskId: 'AISDLC-703', outcome: 'success', workerId: 'w' }),
    ).toThrow(/no recorded worker/);
    expect(readInflightManifest(boardDir, 'AISDLC-703')).toBeDefined();
  });

  it('refuses a non-holder and leaves the manifest and board untouched', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-704'));
    await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-a',
    ]);
    const manifestFile = path.join(
      boardDir,
      'inflight',
      readdirSync(path.join(boardDir, 'inflight')).find(
        (f) => f.includes('AISDLC-704') && !f.includes('.resume') && !f.includes('.heartbeat'),
      )!,
    );
    const before = readFileSync(manifestFile, 'utf-8');
    expect(() =>
      completeTask(boardDir, { taskId: 'AISDLC-704', outcome: 'success', workerId: 'executor-b' }),
    ).toThrow(/claimed by 'executor-a'/);
    expect(readInflightManifest(boardDir, 'AISDLC-704')?.workerId).toBe('executor-a');
    expect(readFileSync(manifestFile, 'utf-8')).toBe(before);
    for (const state of ['done', 'failed']) {
      const dir = path.join(boardDir, state);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
    const { exit } = await cli([
      'complete',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-704',
      '--outcome',
      'success',
      '--worker',
      'executor-b',
    ]);
    expect(exit).toBe(1);
    expect(readInflightManifest(boardDir, 'AISDLC-704')?.workerId).toBe('executor-a');
  });

  it('lets the claim holder complete when it passes its recorded name', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-705'));
    await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-a',
    ]);
    const result = completeTask(boardDir, {
      taskId: 'AISDLC-705',
      outcome: 'success',
      workerId: 'executor-a',
    });
    expect(result.state).toBe('done');
    expect(result.verdict.workerId).toBe('executor-a');
  });

  it('refuses a completion that omits the worker name, library and cli', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-706'));
    await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-a',
    ]);
    const inflightDir = path.join(boardDir, 'inflight');
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(inflightDir).map((f) => [f, readFileSync(path.join(inflightDir, f), 'utf-8')]),
      );
    const before = snapshot();
    expect(() =>
      completeTask(boardDir, {
        taskId: 'AISDLC-706',
        outcome: 'success',
      } as unknown as Parameters<typeof completeTask>[1]),
    ).toThrow(/claimed by 'executor-a', not 'undefined'/);
    await expect(
      cli(['complete', '--board-dir', boardDir, '--task-id', 'AISDLC-706', '--outcome', 'success']),
    ).rejects.toThrow(/--worker is required/);
    expect(snapshot()).toEqual(before);
    for (const state of ['done', 'failed']) {
      const dir = path.join(boardDir, state);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
  });

  it('splits id lists on commas and spaces', () => {
    expect(splitIdList(undefined)).toEqual([]);
    expect(splitIdList('A-1.1, A-1.2 A-1.3,,')).toEqual(['A-1.1', 'A-1.2', 'A-1.3']);
  });

  it('is exercised through the cli', async () => {
    writeManifest(boardDir, mkManifest('AISDLC-704'));
    await cli([
      'claim',
      '--board-dir',
      boardDir,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'executor-b',
    ]);
    const ok = await cli([
      'complete',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-704',
      '--outcome',
      'success',
      '--worker',
      'executor-b',
      '--pr',
      '9',
      '--follow-ups',
      'AISDLC-704.1',
      '--decisions',
      'D-1',
      '--notes',
      'n',
    ]);
    expect(ok.exit).toBe(0);
    expect(JSON.parse(ok.stdout.trim().split('\n').pop()!).state).toBe('done');
    expect(
      (
        await cli([
          'complete',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-704',
          '--outcome',
          'success',
          '--worker',
          'executor-b',
        ])
      ).exit,
    ).toBe(1);
    expect(
      (
        await cli([
          'complete',
          '--board-dir',
          boardDir,
          '--task-id',
          'AISDLC-704',
          '--outcome',
          'success',
          '--worker',
          'executor-b',
          '--pr',
          'x',
        ])
      ).exit,
    ).toBe(2);
  });
});

describe('nextSubId', () => {
  function seedBacklog(...files: string[]): void {
    for (const f of files) {
      const full = path.join(root, 'backlog', f);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
  }

  it('returns .1 when nothing exists', () => {
    expect(nextSubId({ taskId: 'AISDLC-629', workDir: root, boardDir, openPrFiles: [] })).toBe(
      'AISDLC-629.1',
    );
  });

  it('skips ids found in the backlog, the board and open pull requests', () => {
    seedBacklog('tasks/aisdlc-629.1 - first.md', 'completed/aisdlc-629.2 - second.md');
    writeManifest(boardDir, mkManifest('AISDLC-629.3'));
    const subId = nextSubId({
      taskId: 'AISDLC-629',
      workDir: root,
      boardDir,
      openPrFiles: ['backlog/tasks/aisdlc-629.4 - from pr.md', 'src/unrelated.ts'],
    });
    expect(subId).toBe('AISDLC-629.5');
  });

  it('returns the first gap, and treats a deeper id as proof its parent exists', () => {
    seedBacklog('tasks/aisdlc-629.1 - a.md', 'tasks/aisdlc-629.3.1 - nested.md');
    expect(nextSubId({ taskId: 'AISDLC-629', workDir: root, boardDir, openPrFiles: [] })).toBe(
      'AISDLC-629.2',
    );
  });

  it('does not confuse longer ids or other prefixes', () => {
    seedBacklog('tasks/aisdlc-6291.1 - other.md', 'tasks/xaisdlc-629.1 - other.md');
    expect(nextSubId({ taskId: 'AISDLC-629', workDir: root, boardDir, openPrFiles: [] })).toBe(
      'AISDLC-629.1',
    );
  });

  it('rejects an invalid task id', () => {
    expect(() => nextSubId({ taskId: 'x y', workDir: root, boardDir, openPrFiles: [] })).toThrow(
      /valid task id/,
    );
  });

  it('is exercised through the cli, with and without open pull request data', async () => {
    seedBacklog('tasks/aisdlc-629.1 - a.md');
    const ok = await cli(
      ['next-subid', 'AISDLC-629', '--board-dir', boardDir, '--work-dir', root],
      {
        openPrFiles: () => ['backlog/tasks/aisdlc-629.2 - b.md'],
      },
    );
    expect(ok.exit).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toEqual({ subId: 'AISDLC-629.3', openPrScan: 'ok' });

    const degraded = await cli(
      ['next-subid', 'AISDLC-629', '--board-dir', boardDir, '--work-dir', root],
      {
        openPrFiles: () => {
          throw new Error('offline');
        },
      },
    );
    expect(degraded.exit).toBe(0);
    expect(JSON.parse(degraded.stdout.trim())).toEqual({
      subId: 'AISDLC-629.2',
      openPrScan: 'unavailable',
    });

    expect((await cli(['next-subid', '--board-dir', boardDir])).exit).toBe(2);
    expect(
      (
        await cli(['next-subid', 'bad id', '--board-dir', boardDir, '--work-dir', root], {
          openPrFiles: () => [],
        })
      ).exit,
    ).toBe(2);
  });
});
