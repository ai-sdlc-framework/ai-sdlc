/**
 * Dispatch board invariants enforced in code (AISDLC-800): one claim per worker,
 * resume manifests without a wave, and the guarded release.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDispatchCli } from '../cli/dispatch.js';
import {
  claimNext,
  ensureBoardDirs,
  findHeldClaim,
  listBoard,
  OneClaimPerWorkerError,
  readInflightManifest,
  writeManifest,
} from './board.js';
import { claimWithWait } from './claim-wait.js';
import { completeTask } from './complete.js';
import { enqueueTasks } from './enqueue.js';
import { findStrandedWork, guardedRelease } from './release-guard.js';
import { resumeDone } from './resume.js';
import type { DispatchManifest } from './types.js';

function mk(taskId: string, extra: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'any',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', verifyCommands: ['pnpm build'] },
    ...extra,
  };
}

let root: string;
let board: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'board-inv-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
  ensureBoardDirs(board);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('one claim per worker', () => {
  it('refuses a second claim and names the held task', () => {
    writeManifest(board, mk('AISDLC-900'));
    writeManifest(board, mk('AISDLC-901'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    expect(findHeldClaim(board, 'exec-a')).toBe('AISDLC-900');
    let caught: unknown;
    try {
      claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OneClaimPerWorkerError);
    expect((caught as Error).message).toMatch(/exec-a.*AISDLC-900/);
    expect(readInflightManifest(board, 'AISDLC-901')).toBeUndefined();
  });

  it('lets another worker claim, and the same worker claim again after a verdict', () => {
    writeManifest(board, mk('AISDLC-902'));
    writeManifest(board, mk('AISDLC-903'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    expect(claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' }).claimed).toBe(
      true,
    );
    completeTask(board, { taskId: 'AISDLC-902', outcome: 'success', workerId: 'exec-a' });
    writeManifest(board, mk('AISDLC-904'));
    expect(claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' }).claimed).toBe(
      true,
    );
  });

  it('does not apply to an anonymous claim', () => {
    writeManifest(board, mk('AISDLC-905'));
    writeManifest(board, mk('AISDLC-906'));
    expect(claimNext(board, 'in-session-agent').claimed).toBe(true);
    expect(claimNext(board, 'in-session-agent').claimed).toBe(true);
  });

  it('is surfaced through claim --wait and the CLI as an exit 1 naming the task', async () => {
    writeManifest(board, mk('AISDLC-907'));
    writeManifest(board, mk('AISDLC-908'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    await expect(
      claimWithWait(board, 'in-session-agent', { waitSec: 0, workerId: 'exec-a' }),
    ).rejects.toBeInstanceOf(OneClaimPerWorkerError);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
      stderr += c.toString();
      return true;
    }) as typeof process.stderr.write);
    const exit = await runDispatchCli([
      'claim',
      '--board-dir',
      board,
      '--worker-kind',
      'in-session-agent',
      '--worker',
      'exec-a',
    ]);
    expect(exit).toBe(1);
    expect(stderr).toContain('AISDLC-907');
  });
});

describe('resume ordering', () => {
  it('sorts a resume (priority, no wave) ahead of wave-less backlog entries', () => {
    writeManifest(board, mk('AISDLC-912', { wave: 5, priority: 1 }));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    completeTask(board, { taskId: 'AISDLC-912', outcome: 'success', workerId: 'exec-a' });
    enqueueTasks(board, [{ taskId: 'AISDLC-910' }, { taskId: 'AISDLC-911' }], {
      baseSha: 'abc1234',
      dispatchedBy: 'test',
      resolveTaskFile: (id) => `backlog/tasks/${id}.md`,
    });
    resumeDone(
      board,
      'AISDLC-912',
      { note: 'fix coverage' },
      { resumedBy: 'dispatch', now: () => new Date('2026-10-10T10:00:00.000Z') },
    );
    const order = listBoard(board)
      .filter((e) => e.state === 'queue')
      .map((e) => e.taskId);
    expect(order[0]).toBe('AISDLC-912');
    expect(listBoard(board).find((e) => e.taskId === 'AISDLC-912')?.wave).toBeUndefined();
    expect(
      claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-b' }).manifest?.taskId,
    ).toBe('AISDLC-912');
  });

  it('sorts enqueue --priority 1 with no wave first', () => {
    writeManifest(board, mk('AISDLC-913'));
    writeManifest(board, mk('AISDLC-914', { priority: 1 }));
    expect(listBoard(board).filter((e) => e.state === 'queue')[0]?.taskId).toBe('AISDLC-914');
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('guarded release', () => {
  let origin: string;
  let worktree: string;
  let baseSha: string;

  function setup(taskId: string): DispatchManifest {
    origin = path.join(root, 'origin.git');
    mkdirSync(origin);
    git(origin, 'init', '--bare', '-q');
    worktree = path.join(root, '.worktrees', taskId.toLowerCase());
    mkdirSync(worktree, { recursive: true });
    git(worktree, 'init', '-q', '-b', 'main');
    git(worktree, 'config', 'user.email', 't@example.com');
    git(worktree, 'config', 'user.name', 't');
    git(worktree, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(worktree, 'a.txt'), 'one\n');
    git(worktree, 'add', 'a.txt');
    git(worktree, 'commit', '-q', '-m', 'base');
    baseSha = git(worktree, 'rev-parse', 'HEAD');
    git(worktree, 'remote', 'add', 'origin', origin);
    const manifest = mk(taskId, { baseSha, branch: 'feature' });
    writeManifest(board, manifest);
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    return manifest;
  }

  const opts = (extra = {}) => ({
    workDir: root,
    now: () => new Date('2026-10-10T10:00:00.000Z'),
    ...extra,
  });

  it('releases a clean worktree whose branch is pushed', () => {
    const manifest = setup('AISDLC-920');
    git(worktree, 'checkout', '-q', '-b', 'feature');
    git(worktree, 'push', '-q', 'origin', 'feature');
    git(worktree, 'fetch', '-q', 'origin');
    expect(findStrandedWork(manifest, root)).toBeUndefined();
    expect(guardedRelease(board, 'AISDLC-920', opts())).toEqual({ released: true });
    expect(readInflightManifest(board, 'AISDLC-920')).toBeUndefined();
  });

  it('refuses on an unpushed commit and on an uncommitted tracked change', () => {
    setup('AISDLC-921');
    git(worktree, 'checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(worktree, 'b.txt'), 'two\n');
    git(worktree, 'add', 'b.txt');
    git(worktree, 'commit', '-q', '-m', 'work');
    expect(() => guardedRelease(board, 'AISDLC-921', opts())).toThrow(
      /1 commit not on any pushed branch.*--force --reason/,
    );
    writeFileSync(path.join(worktree, 'a.txt'), 'changed\n');
    expect(() => guardedRelease(board, 'AISDLC-921', opts())).toThrow(
      /1 uncommitted change to tracked files and 1 commit/,
    );
    expect(readInflightManifest(board, 'AISDLC-921')).toBeDefined();
  });

  it('counts commits ahead of the pushed branch', () => {
    const manifest = setup('AISDLC-922');
    git(worktree, 'checkout', '-q', '-b', 'feature');
    git(worktree, 'push', '-q', 'origin', 'feature');
    git(worktree, 'fetch', '-q', 'origin');
    for (const f of ['c.txt', 'd.txt']) {
      writeFileSync(path.join(worktree, f), f);
      git(worktree, 'add', f);
      git(worktree, 'commit', '-q', '-m', f);
    }
    expect(findStrandedWork(manifest, root)).toBe('2 commits not on origin/feature');
  });

  it('needs a reason with --force, and records it in the manifest history', () => {
    setup('AISDLC-923');
    writeFileSync(path.join(worktree, 'a.txt'), 'changed\n');
    expect(() => guardedRelease(board, 'AISDLC-923', opts({ force: true }))).toThrow(/--reason/);
    const r = guardedRelease(
      board,
      'AISDLC-923',
      opts({ force: true, reason: 'abandoned experiment', by: 'dispatch' }),
    );
    expect(r).toMatchObject({
      released: true,
      forced: true,
      unsafe: '1 uncommitted change to tracked files',
    });
    const queued = JSON.parse(
      readFileSync(path.join(board, 'queue', 'AISDLC-923.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    expect(queued.releaseHistory).toEqual([
      {
        at: '2026-10-10T10:00:00.000Z',
        by: 'dispatch',
        reason: 'abandoned experiment',
        forced: true,
        unsafe: '1 uncommitted change to tracked files',
      },
    ]);
  });

  it('releases when the worktree is missing, and reports an unknown task as not released', () => {
    writeManifest(board, mk('AISDLC-924'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    expect(guardedRelease(board, 'AISDLC-924', opts()).released).toBe(true);
    expect(guardedRelease(board, 'AISDLC-925', opts())).toEqual({ released: false });
  });

  it('records a forced release of a clean worktree without an unsafe note', () => {
    writeManifest(board, mk('AISDLC-926'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    const r = guardedRelease(board, 'AISDLC-926', opts({ force: true, reason: 'just because' }));
    expect(r).toEqual({ released: true, forced: true });
  });

  it('treats git failures as nothing found', () => {
    const manifest = mk('AISDLC-927');
    mkdirSync(path.join(root, manifest.worktree), { recursive: true });
    expect(findStrandedWork(manifest, root, () => null)).toBeUndefined();
  });

  it('is wired to the CLI: refuses with exit 1, then --force --reason releases', async () => {
    setup('AISDLC-928');
    writeFileSync(path.join(worktree, 'a.txt'), 'changed\n');
    let stderr = '';
    let stdout = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
      stderr += c.toString();
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
      stdout += c.toString();
      return true;
    }) as typeof process.stdout.write);
    const base = ['release', '--board-dir', board, '--work-dir', root, '--task-id', 'AISDLC-928'];
    expect(await runDispatchCli(base)).toBe(1);
    expect(stderr).toContain('cli-dispatch release:');
    expect(
      await runDispatchCli([...base, '--force', '--reason', 'dropping it', '--worker', 'dispatch']),
    ).toBe(0);
    expect(stdout).toContain('"forced":true');
  });
});
