/**
 * Tests for `cli-dispatch` — the operator CLI surface for the Dispatch Board
 * (RFC-0041 §4.4, AISDLC-377.1).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchEnsureBoardDirs, dispatchWriteManifest } from '../index.js';
import type { DispatchManifest } from '../index.js';

import { parseArgv, runDispatchCli } from './dispatch.js';

describe('parseArgv', () => {
  it('parses subcommand + key/value flag pairs', () => {
    const { subcommand, flags } = parseArgv([
      'claim',
      '--worker-kind',
      'in-session-agent',
      '--board-dir',
      '/tmp/x',
    ]);
    expect(subcommand).toBe('claim');
    expect(flags).toEqual({
      'worker-kind': 'in-session-agent',
      'board-dir': '/tmp/x',
    });
  });

  it('treats bare flags as true', () => {
    const { flags } = parseArgv(['collect-verdicts', '--include-failed']);
    expect(flags['include-failed']).toBe('true');
  });

  it('handles empty argv', () => {
    expect(parseArgv([])).toEqual({ subcommand: '', flags: {} });
  });
});

// ---------------------------------------------------------------------------
// CLI integration — drive each subcommand and assert on the JSON it prints
// to stdout + the on-disk side effects.
// ---------------------------------------------------------------------------

function mkBoard(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'dispatch-cli-')), 'dispatch');
}

function mkManifest(taskId: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`,
      verifyCommands: ['pnpm build'],
    },
  };
}

interface CapturedStdout {
  lines: string[];
  raw: string;
}

function captureStdout(fn: () => Promise<number>): Promise<{
  exit: number;
  captured: CapturedStdout;
}> {
  const lines: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write);
  return fn().then((exit) => {
    writeSpy.mockRestore();
    return { exit, captured: { lines, raw: lines.join('') } };
  });
}

function readLastJson(out: CapturedStdout): unknown {
  const trimmed = out.raw.trim().split('\n').filter(Boolean);
  return JSON.parse(trimmed[trimmed.length - 1]);
}

describe('runDispatchCli', () => {
  let boardDir: string;

  beforeEach(() => {
    boardDir = mkBoard();
    dispatchEnsureBoardDirs(boardDir);
  });
  afterEach(() => {
    try {
      rmSync(path.dirname(boardDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('peek returns zero counts on a fresh board', async () => {
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['peek', '--board-dir', boardDir]),
    );
    expect(exit).toBe(0);
    expect(readLastJson(captured)).toEqual({
      queued: 0,
      inflight: 0,
      done: 0,
      failed: 0,
    });
  });

  it('claim returns claimed:false when queue is empty', async () => {
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']),
    );
    expect(exit).toBe(0);
    expect(readLastJson(captured)).toEqual({ claimed: false });
  });

  it('claim requires --worker-kind', async () => {
    const { exit } = await captureStdout(() => runDispatchCli(['claim', '--board-dir', boardDir]));
    expect(exit).toBe(2);
  });

  it('claim rejects invalid worker kinds', async () => {
    const { exit } = await captureStdout(() =>
      runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'not-a-kind']),
    );
    expect(exit).toBe(2);
  });

  it('claim succeeds and prints the manifest', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2000'));
    const { exit, captured } = await captureStdout(() =>
      runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']),
    );
    expect(exit).toBe(0);
    const result = readLastJson(captured) as {
      claimed: boolean;
      manifest: DispatchManifest;
    };
    expect(result.claimed).toBe(true);
    expect(result.manifest.taskId).toBe('AISDLC-2000');
  });

  it('write-verdict routes success to done/', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2001'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    const { exit } = await captureStdout(() =>
      runDispatchCli([
        'write-verdict',
        '--board-dir',
        boardDir,
        '--task-id',
        'AISDLC-2001',
        '--outcome',
        'success',
        '--worker-id',
        'w1',
        '--worker-kind',
        'in-session-agent',
        '--commit-sha',
        'def5678',
        '--verifications',
        JSON.stringify({ build: 'passed', test: 'passed' }),
        '--acceptance-criteria-met',
        '[1,2,3]',
        '--duration-ms',
        '12345',
      ]),
    );
    expect(exit).toBe(0);
    const verdict = JSON.parse(
      readFileSync(path.join(boardDir, 'done', 'AISDLC-2001.verdict.json'), 'utf-8'),
    );
    expect(verdict.outcome).toBe('success');
    expect(verdict.commitSha).toBe('def5678');
    expect(verdict.verifications).toEqual({ build: 'passed', test: 'passed' });
    expect(verdict.acceptanceCriteriaMet).toEqual([1, 2, 3]);
    expect(verdict.durationMs).toBe(12345);
  });

  it('write-verdict routes quota-exhausted to failed/ with retryAfter', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2002'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'write-verdict',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2002',
      '--outcome',
      'quota-exhausted',
      '--worker-id',
      'w1',
      '--cause',
      'quota-exhausted',
      '--retry-after',
      '600',
      '--notes',
      'simulated 429',
    ]);
    const diag = JSON.parse(
      readFileSync(path.join(boardDir, 'failed', 'AISDLC-2002.verdict.json'), 'utf-8'),
    );
    expect(diag.outcome).toBe('quota-exhausted');
    expect(diag.retryAfter).toBe(600);
    expect(diag.notes).toBe('simulated 429');
  });

  it('collect-verdicts prints done verdicts as JSON array', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2010'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'write-verdict',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2010',
      '--outcome',
      'success',
      '--worker-id',
      'w1',
    ]);
    const { captured } = await captureStdout(() =>
      runDispatchCli(['collect-verdicts', '--board-dir', boardDir]),
    );
    const verdicts = readLastJson(captured) as unknown[];
    expect(Array.isArray(verdicts)).toBe(true);
    expect((verdicts[0] as { taskId: string }).taskId).toBe('AISDLC-2010');
  });

  it('remove-verdict idempotent for missing files', async () => {
    const { exit } = await captureStdout(() =>
      runDispatchCli(['remove-verdict', '--board-dir', boardDir, '--task-id', 'AISDLC-NOPE']),
    );
    expect(exit).toBe(0);
  });

  it('heartbeat writes inflight state file', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2020'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'heartbeat',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2020',
      '--worker-id',
      'w1',
      '--worker-kind',
      'in-session-agent',
      '--current-step',
      'pnpm test',
      '--pid',
      '99999',
    ]);
    const state = JSON.parse(
      readFileSync(path.join(boardDir, 'inflight', 'AISDLC-2020.state.json'), 'utf-8'),
    );
    expect(state.currentStep).toBe('pnpm test');
    expect(state.pid).toBe(99999);
  });

  it('sweep returns no reaped IDs when nothing is stale', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2030'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    await runDispatchCli([
      'heartbeat',
      '--board-dir',
      boardDir,
      '--task-id',
      'AISDLC-2030',
      '--worker-id',
      'w1',
      '--worker-kind',
      'in-session-agent',
    ]);
    const { captured } = await captureStdout(() =>
      runDispatchCli(['sweep', '--board-dir', boardDir, '--stale-ms', '60000']),
    );
    expect(readLastJson(captured)).toEqual({ reapedTaskIds: [] });
  });

  it('release moves inflight back to queue', async () => {
    dispatchWriteManifest(boardDir, mkManifest('AISDLC-2040'));
    await runDispatchCli(['claim', '--board-dir', boardDir, '--worker-kind', 'in-session-agent']);
    const { captured } = await captureStdout(() =>
      runDispatchCli(['release', '--board-dir', boardDir, '--task-id', 'AISDLC-2040']),
    );
    expect(readLastJson(captured)).toEqual({ released: true });
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-2040.dispatch.json'))).toBe(true);
  });

  it('write-manifest reads a JSON file and queues it', async () => {
    const tmpFile = path.join(boardDir, '..', 'manifest.json');
    writeFileSync(tmpFile, JSON.stringify(mkManifest('AISDLC-2050')), 'utf-8');
    const { exit } = await captureStdout(() =>
      runDispatchCli(['write-manifest', '--board-dir', boardDir, '--json', tmpFile]),
    );
    expect(exit).toBe(0);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-2050.dispatch.json'))).toBe(true);
  });

  it('help subcommand prints usage', async () => {
    const { exit, captured } = await captureStdout(() => runDispatchCli(['help']));
    expect(exit).toBe(0);
    expect(captured.raw).toMatch(/cli-dispatch/);
    expect(captured.raw).toMatch(/Subcommands/);
  });

  it('unknown subcommand exits 2', async () => {
    const { exit } = await captureStdout(() => runDispatchCli(['no-such-cmd']));
    expect(exit).toBe(2);
  });
});
