/**
 * `cli-orchestrator-corpus profile` subcommand + calibration-append tests
 * (AISDLC-479).
 *
 * Hermetic: seeds a tmpdir with events + a Dispatch Board, drives the CLI
 * in-process with stdout captured, and asserts the throughput report +
 * EstimateActualsRecorded append (AC-3 / AC-4).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendActualsToCalibration, buildOrchestratorCorpusCli } from './orchestrator-corpus.js';
import type { EstimateActualsRecord } from './profile-aggregator.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'corpus-profile-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.exit = savedExit;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli', ...args];
}

function seedBoard(boardDir: string): void {
  const done = join(boardDir, 'done');
  mkdirSync(done, { recursive: true });
  writeFileSync(
    join(done, 'A-1.verdict.json'),
    JSON.stringify({
      schemaVersion: 'v1',
      taskId: 'A-1',
      outcome: 'success',
      durationMs: 120_000,
      dispatchedAt: '2026-05-29T00:00:00.000Z',
      completedAt: '2026-05-29T00:02:00.000Z',
      workerId: 'w',
    }),
  );
  const failed = join(boardDir, 'failed');
  mkdirSync(failed, { recursive: true });
  writeFileSync(
    join(failed, 'A-2.verdict.json'),
    JSON.stringify({
      schemaVersion: 'v1',
      taskId: 'A-2',
      outcome: 'failed',
      durationMs: 60_000,
      dispatchedAt: '2026-05-29T00:00:00.000Z',
      completedAt: '2026-05-29T00:01:00.000Z',
      workerId: 'w',
    }),
  );
}

describe('appendActualsToCalibration (AC-3 / AC-4)', () => {
  it('appends EstimateActualsRecorded records to the monthly file', () => {
    const actuals: EstimateActualsRecord[] = [
      {
        ts: '2026-05-29T12:00:00.000Z',
        type: 'EstimateActualsRecorded',
        taskId: 'A-1',
        actualWallClockSec: 120,
        durationMs: 120_000,
      },
    ];
    const result = appendActualsToCalibration(tmp, actuals);
    expect(result.appended).toBe(1);
    const path = join(tmp, '_estimates', 'calibration-2026-05.jsonl');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(parsed.type).toBe('EstimateActualsRecorded');
    expect(parsed.actualWallClockSec).toBe(120);
    expect(parsed.durationMs).toBe(120_000);
  });

  it('is idempotent by taskId (re-run does not double-append)', () => {
    const actuals: EstimateActualsRecord[] = [
      {
        ts: '2026-05-29T12:00:00.000Z',
        type: 'EstimateActualsRecorded',
        taskId: 'A-1',
        actualWallClockSec: 120,
        durationMs: 120_000,
      },
    ];
    appendActualsToCalibration(tmp, actuals);
    const second = appendActualsToCalibration(tmp, actuals);
    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(1);
    const path = join(tmp, '_estimates', 'calibration-2026-05.jsonl');
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('routes records into the month derived from their own ts', () => {
    appendActualsToCalibration(tmp, [
      {
        ts: '2026-04-15T00:00:00.000Z',
        type: 'EstimateActualsRecorded',
        taskId: 'OLD',
        actualWallClockSec: 1,
        durationMs: 1000,
      },
    ]);
    expect(existsSync(join(tmp, '_estimates', 'calibration-2026-04.jsonl'))).toBe(true);
  });
});

describe('cli-orchestrator-corpus profile', () => {
  it('emits a JSON throughput report from board verdicts', async () => {
    const boardDir = join(tmp, 'dispatch');
    seedBoard(boardDir);
    setArgv('profile', '--artifacts-dir', tmp, '--board-dir', boardDir, '--format', 'json');
    await buildOrchestratorCorpusCli().parseAsync();
    const out = JSON.parse(stdoutChunks.join(''));
    expect(out.summary.taskCount).toBe(2);
    expect(out.summary.successCount).toBe(1);
    expect(out.summary.p50DurationMs).not.toBeNull();
    expect(out.actuals).toHaveLength(2);
  });

  it('renders a table when --format table', async () => {
    const boardDir = join(tmp, 'dispatch');
    seedBoard(boardDir);
    setArgv('profile', '--artifacts-dir', tmp, '--board-dir', boardDir, '--format', 'table');
    await buildOrchestratorCorpusCli().parseAsync();
    const out = stdoutChunks.join('');
    expect(out).toContain('Success rate:');
    expect(out).toContain('p50:');
  });

  it('writes actuals to calibration when --write-actuals', async () => {
    const boardDir = join(tmp, 'dispatch');
    seedBoard(boardDir);
    setArgv(
      'profile',
      '--artifacts-dir',
      tmp,
      '--board-dir',
      boardDir,
      '--write-actuals',
      '--format',
      'json',
    );
    await buildOrchestratorCorpusCli().parseAsync();
    const out = JSON.parse(stdoutChunks.join(''));
    expect(out.actualsWrite.appended).toBe(2);
    // calibration-YYYY-MM.jsonl now exists with 2 EstimateActualsRecorded rows.
    const estimatesDir = join(tmp, '_estimates');
    const files = existsSync(estimatesDir)
      ? readFileSync(join(estimatesDir, 'calibration-2026-05.jsonl'), 'utf8')
      : '';
    expect(files.trim().split('\n')).toHaveLength(2);
  });
});
