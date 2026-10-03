/**
 * Tests for re-queueing a failed task by id. Everything runs in a temp
 * directory; the board is the real filesystem board.
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
import { claimNext, ensureBoardDirs, writeManifest, writeVerdict } from './board.js';
import { completeTask } from './complete.js';
import { FAILED_MANIFEST_SUFFIX, requeueFailed, snapshotFailedManifest } from './requeue.js';
import type { DispatchManifest } from './types.js';

function mkManifest(taskId: string, extra: Partial<DispatchManifest> = {}): DispatchManifest {
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
    ...extra,
  };
}

let root: string;
let board: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'requeue-'));
  board = path.join(root, '.ai-sdlc', 'dispatch');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Every file on the board with its content, for before/after comparison. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of readdirSync(board)) {
    const dir = path.join(board, sub);
    for (const f of readdirSync(dir)) {
      out[`${sub}/${f}`] = readFileSync(path.join(dir, f), 'utf-8');
    }
  }
  return out;
}

/** Enqueue, claim and fail a task the way an executor does. */
function failTask(taskId: string, extra: Partial<DispatchManifest> = {}): void {
  for (const prerequisite of extra.after ?? []) {
    if (!existsSync(path.join(board, 'done', `${prerequisite}.verdict.json`))) {
      writeVerdict(board, {
        schemaVersion: 'v1',
        taskId: prerequisite,
        outcome: 'success',
        completedAt: '2026-05-20T10:30:00.000Z',
        workerId: 'executor-a',
      });
    }
  }
  writeManifest(board, mkManifest(taskId, extra));
  const claim = claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-a' });
  expect(claim.claimed).toBe(true);
  completeTask(board, {
    taskId,
    outcome: 'failed',
    cause: 'transient',
    workerId: 'executor-a',
    now: () => new Date('2026-05-20T11:00:00.000Z'),
  });
}

describe('failing a task keeps a manifest copy', () => {
  it('writes the manifest next to the failure record, with the claim name', () => {
    failTask('AISDLC-901', { after: ['AISDLC-900'], wave: 2 });
    const files = readdirSync(path.join(board, 'failed')).sort();
    expect(files).toEqual([`AISDLC-901${FAILED_MANIFEST_SUFFIX}`, 'AISDLC-901.verdict.json']);
    const kept = JSON.parse(
      readFileSync(path.join(board, 'failed', `AISDLC-901${FAILED_MANIFEST_SUFFIX}`), 'utf-8'),
    ) as DispatchManifest;
    expect(kept.after).toEqual(['AISDLC-900']);
    expect(kept.wave).toBe(2);
    expect(kept.workerId).toBe('executor-a');
  });

  it('keeps nothing for a success', () => {
    writeManifest(board, mkManifest('AISDLC-902'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-a' });
    completeTask(board, { taskId: 'AISDLC-902', outcome: 'success', workerId: 'executor-a' });
    expect(readdirSync(path.join(board, 'failed'))).toEqual([]);
  });
});

describe('the manifest copy is written atomically and before the verdict', () => {
  it('leaves no temp file behind after a failure completes', () => {
    failTask('AISDLC-915');
    expect(readdirSync(path.join(board, 'failed')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('writes the copy first: when it cannot be written, no verdict is written and the claim is untouched', () => {
    writeManifest(board, mkManifest('AISDLC-916'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-a' });
    // A directory where the copy must go makes the final rename fail.
    mkdirSync(path.join(board, 'failed', `AISDLC-916${FAILED_MANIFEST_SUFFIX}`), {
      recursive: true,
    });
    const inflightBefore = readFileSync(
      path.join(board, 'inflight', 'AISDLC-916.dispatch.json'),
      'utf-8',
    );
    expect(() =>
      completeTask(board, { taskId: 'AISDLC-916', outcome: 'failed', workerId: 'executor-a' }),
    ).toThrow();
    const failed = readdirSync(path.join(board, 'failed'));
    expect(failed).toEqual([`AISDLC-916${FAILED_MANIFEST_SUFFIX}`]);
    expect(failed.some((f) => f.endsWith('.verdict.json') || f.includes('.tmp-'))).toBe(false);
    expect(readFileSync(path.join(board, 'inflight', 'AISDLC-916.dispatch.json'), 'utf-8')).toBe(
      inflightBefore,
    );
  });

  it('snapshotFailedManifest removes its temp file and rethrows when the rename fails', () => {
    ensureBoardDirs(board);
    mkdirSync(path.join(board, 'failed', `AISDLC-917${FAILED_MANIFEST_SUFFIX}`));
    expect(() => snapshotFailedManifest(board, mkManifest('AISDLC-917'))).toThrow();
    expect(readdirSync(path.join(board, 'failed')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a task failed without a copy is refused by requeue, never rebuilt from a guess', () => {
    ensureBoardDirs(board);
    writeFileSync(
      path.join(board, 'failed', 'AISDLC-918.verdict.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-918', outcome: 'failed' }),
    );
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-918')).toThrow(/no saved manifest/);
    expect(snapshot()).toEqual(before);
    expect(readdirSync(path.join(board, 'queue'))).toEqual([]);
  });
});

describe('requeueFailed', () => {
  it('returns a failed task to the queue with the retry count incremented and its ordering intact', () => {
    failTask('AISDLC-903', { after: ['AISDLC-900'], sequenceGroup: 'g', priority: 1, wave: 3 });
    const result = requeueFailed(board, 'AISDLC-903');
    expect(result.retryCount).toBe(1);
    const queued = JSON.parse(readFileSync(result.queuePath, 'utf-8')) as DispatchManifest;
    expect(queued).toMatchObject({
      taskId: 'AISDLC-903',
      retryCount: 1,
      after: ['AISDLC-900'],
      sequenceGroup: 'g',
      priority: 1,
      wave: 3,
    });
    expect(queued.workerId).toBeUndefined();
    expect(readdirSync(path.join(board, 'failed'))).toEqual([]);
    expect(readdirSync(path.join(board, 'queue'))).toEqual(['AISDLC-903.dispatch.json']);
  });

  it('can be claimed and run again, and counts each re-queue', () => {
    failTask('AISDLC-904');
    expect(requeueFailed(board, 'AISDLC-904').retryCount).toBe(1);
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-b' });
    completeTask(board, {
      taskId: 'AISDLC-904',
      outcome: 'failed',
      cause: 'transient',
      workerId: 'executor-b',
    });
    expect(requeueFailed(board, 'AISDLC-904').retryCount).toBe(2);
  });

  it('refuses a task that is not in failed/, changing nothing', () => {
    ensureBoardDirs(board);
    writeManifest(board, mkManifest('AISDLC-905'));
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-905')).toThrow(/not in failed\//);
    expect(() => requeueFailed(board, 'AISDLC-999')).toThrow(/not in failed\//);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a task that succeeded, changing nothing', () => {
    writeManifest(board, mkManifest('AISDLC-906'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-a' });
    completeTask(board, { taskId: 'AISDLC-906', outcome: 'success', workerId: 'executor-a' });
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-906')).toThrow(/not in failed\//);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a task past the retry limit, leaving it in failed/ unchanged', () => {
    failTask('AISDLC-907');
    requeueFailed(board, 'AISDLC-907', { retryLimit: 1 });
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-a' });
    completeTask(board, {
      taskId: 'AISDLC-907',
      outcome: 'failed',
      cause: 'transient',
      workerId: 'executor-a',
    });
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-907', { retryLimit: 1 })).toThrow(/limit is 1/);
    expect(snapshot()).toEqual(before);
    expect(readdirSync(path.join(board, 'queue'))).toEqual([]);
  });

  it('refuses a failure with no saved manifest, changing nothing', () => {
    ensureBoardDirs(board);
    writeFileSync(
      path.join(board, 'failed', 'AISDLC-908.diagnostic.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-908', outcome: 'failed' }),
    );
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-908')).toThrow(/no saved manifest/);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a task that is already queued, changing nothing', () => {
    failTask('AISDLC-909');
    writeManifest(board, mkManifest('AISDLC-909'));
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-909')).toThrow(/already in queue\//);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a malformed id', () => {
    expect(() => requeueFailed(board, '../x')).toThrow(/not a valid task id/);
    expect(() => snapshotFailedManifest(board, mkManifest('nope'))).toThrow(/not a valid task id/);
  });

  it('ignores a damaged manifest copy', () => {
    ensureBoardDirs(board);
    mkdirSync(path.join(board, 'failed'), { recursive: true });
    writeFileSync(path.join(board, 'failed', 'AISDLC-910.verdict.json'), '{}');
    writeFileSync(path.join(board, 'failed', `AISDLC-910${FAILED_MANIFEST_SUFFIX}`), 'not json');
    const before = snapshot();
    expect(() => requeueFailed(board, 'AISDLC-910')).toThrow(/no saved manifest/);
    expect(snapshot()).toEqual(before);
  });
});

describe('cli-dispatch requeue', () => {
  async function cli(argv: string[]): Promise<{ exit: number; stdout: string }> {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
      stdout += c.toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (() => true) as typeof process.stderr.write,
    );
    const exit = await runDispatchCli(argv);
    return { exit, stdout };
  }

  it('requeues a failed task and exits 0', async () => {
    failTask('AISDLC-911');
    const r = await cli(['requeue', '--board-dir', board, '--task-id', 'AISDLC-911']);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout.trim()).retryCount).toBe(1);
  });

  it('exits 1 and changes nothing when the task is not in failed/', async () => {
    ensureBoardDirs(board);
    writeManifest(board, mkManifest('AISDLC-912'));
    const before = snapshot();
    const r = await cli(['requeue', '--board-dir', board, '--task-id', 'AISDLC-912']);
    expect(r.exit).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it('exits 1 past the retry limit and honours --retry-limit', async () => {
    failTask('AISDLC-913');
    const before = snapshot();
    const refused = await cli([
      'requeue',
      '--board-dir',
      board,
      '--task-id',
      'AISDLC-913',
      '--retry-limit',
      '0',
    ]);
    expect(refused.exit).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it('exits 2 for a malformed id or limit', async () => {
    expect((await cli(['requeue', '--board-dir', board, '--task-id', 'x'])).exit).toBe(2);
    expect(
      (
        await cli([
          'requeue',
          '--board-dir',
          board,
          '--task-id',
          'AISDLC-914',
          '--retry-limit',
          'many',
        ])
      ).exit,
    ).toBe(2);
  });
});
