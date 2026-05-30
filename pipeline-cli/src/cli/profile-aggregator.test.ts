/**
 * Profile aggregator tests (AISDLC-479) — AC-5 math coverage.
 *
 * Hermetic: percentile + success-rate math run against synthetic arrays;
 * the readers run against a seeded tmpdir.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OrchestratorEvent } from '../orchestrator/events.js';
import {
  aggregateProfile,
  percentile,
  readBoardVerdicts,
  readProfilingEvents,
  type TimedVerdictRecord,
} from './profile-aggregator.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'profile-agg-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('percentile (AC-5)', () => {
  it('returns null for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it('computes median via nearest-rank', () => {
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
  });

  it('computes p95 via nearest-rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    // ceil(0.95 * 20) = 19 → 1-indexed rank 19 → value 1900.
    expect(percentile(values, 0.95)).toBe(1900);
  });

  it('returns min/max for p<=0 and p>=1', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1);
    expect(percentile([5, 1, 9], 1)).toBe(9);
  });

  it('does not mutate the input array', () => {
    const input = [3, 1, 2];
    percentile(input, 0.5);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('aggregateProfile — verdict source', () => {
  it('computes per-task rows + summary p50/p95/success rate', () => {
    const verdicts: TimedVerdictRecord[] = [
      { taskId: 'A-1', outcome: 'success', durationMs: 100, dispatchedAt: 'd1', completedAt: 'c1' },
      { taskId: 'A-2', outcome: 'success', durationMs: 200, dispatchedAt: 'd2', completedAt: 'c2' },
      { taskId: 'A-3', outcome: 'failed', durationMs: 300, dispatchedAt: 'd3', completedAt: 'c3' },
    ];
    const report = aggregateProfile(verdicts, [], () => new Date('2026-05-29T00:00:00.000Z'));

    expect(report.perTask).toHaveLength(3);
    expect(report.summary.taskCount).toBe(3);
    expect(report.summary.successCount).toBe(2);
    expect(report.summary.successRate).toBeCloseTo(2 / 3);
    expect(report.summary.durationSampleCount).toBe(3);
    expect(report.summary.p50DurationMs).toBe(200);
    expect(report.summary.totalDurationMs).toBe(600);
  });

  it('builds EstimateActualsRecorded records with the mandated field names', () => {
    const verdicts: TimedVerdictRecord[] = [
      {
        taskId: 'A-1',
        outcome: 'success',
        durationMs: 90_000,
        dispatchedAt: '2026-05-29T00:00:00.000Z',
        completedAt: '2026-05-29T00:01:30.000Z',
      },
    ];
    const report = aggregateProfile(verdicts, [], () => new Date('2026-05-29T12:00:00.000Z'));
    expect(report.actuals).toHaveLength(1);
    const rec = report.actuals[0]!;
    expect(rec.type).toBe('EstimateActualsRecorded');
    expect(rec.taskId).toBe('A-1');
    expect(rec.durationMs).toBe(90_000);
    expect(rec.actualWallClockSec).toBe(90);
    expect(rec.dispatchedAt).toBe('2026-05-29T00:00:00.000Z');
    expect(rec.completedAt).toBe('2026-05-29T00:01:30.000Z');
    expect(rec.ts).toBe('2026-05-29T12:00:00.000Z');
  });

  it('omits actuals for tasks without durationMs', () => {
    const verdicts: TimedVerdictRecord[] = [{ taskId: 'A-1', outcome: 'success' }];
    const report = aggregateProfile(verdicts, []);
    expect(report.actuals).toHaveLength(0);
    expect(report.summary.durationSampleCount).toBe(0);
    expect(report.summary.p50DurationMs).toBeNull();
  });
});

describe('aggregateProfile — event source + de-dup', () => {
  it('derives rows from completion/failure events', () => {
    const events: OrchestratorEvent[] = [
      {
        ts: '2026-05-29T00:05:00.000Z',
        type: 'OrchestratorCompleted',
        taskId: 'E-1',
        durationMs: 500,
        outcome: 'approved',
      },
      {
        ts: '2026-05-29T00:06:00.000Z',
        type: 'OrchestratorFailed',
        taskId: 'E-2',
        durationMs: 700,
        outcome: 'failed',
      },
    ];
    const report = aggregateProfile([], events);
    expect(report.summary.taskCount).toBe(2);
    expect(report.summary.successCount).toBe(1);
    expect(report.perTask.find((t) => t.taskId === 'E-1')!.source).toBe('event');
  });

  it('prefers verdict over event for the same task', () => {
    const events: OrchestratorEvent[] = [
      {
        ts: '2026-05-29T00:05:00.000Z',
        type: 'OrchestratorCompleted',
        taskId: 'DUP',
        durationMs: 111,
        outcome: 'approved',
      },
    ];
    const verdicts: TimedVerdictRecord[] = [
      { taskId: 'DUP', outcome: 'success', durationMs: 999, dispatchedAt: 'd', completedAt: 'c' },
    ];
    const report = aggregateProfile(verdicts, events);
    expect(report.summary.taskCount).toBe(1);
    const row = report.perTask[0]!;
    expect(row.source).toBe('verdict');
    expect(row.durationMs).toBe(999);
  });

  it('ignores non-timing event types', () => {
    const events: OrchestratorEvent[] = [
      { ts: '2026-05-29T00:00:00.000Z', type: 'OrchestratorDispatched', taskId: 'X' },
      { ts: '2026-05-29T00:00:01.000Z', type: 'OrchestratorTick' },
    ];
    const report = aggregateProfile([], events);
    expect(report.summary.taskCount).toBe(0);
  });
});

describe('readProfilingEvents', () => {
  it('reads completion/failure events from rotated files; skips malformed lines', () => {
    const dir = join(tmp, '_orchestrator');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events-2026-05-29.jsonl'),
      [
        JSON.stringify({ ts: '2026-05-29T00:00:00Z', type: 'OrchestratorCompleted', taskId: 'A' }),
        'garbage-line',
        JSON.stringify({ ts: '2026-05-29T00:01:00Z', type: 'OrchestratorFailed', taskId: 'B' }),
        '',
      ].join('\n'),
    );
    const events = readProfilingEvents(tmp);
    expect(events).toHaveLength(2);
  });

  it('returns [] when the dir is missing', () => {
    expect(readProfilingEvents(join(tmp, 'nope'))).toEqual([]);
  });
});

describe('readBoardVerdicts', () => {
  it('reads done/ + failed/ verdicts; skips malformed', () => {
    const done = join(tmp, 'done');
    const failed = join(tmp, 'failed');
    mkdirSync(done, { recursive: true });
    mkdirSync(failed, { recursive: true });
    writeFileSync(
      join(done, 'A-1.verdict.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'A-1', outcome: 'success', durationMs: 10 }),
    );
    writeFileSync(
      join(failed, 'A-2.verdict.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'A-2', outcome: 'failed' }),
    );
    writeFileSync(join(done, 'broken.verdict.json'), '{not json');
    const verdicts = readBoardVerdicts(tmp);
    expect(verdicts.map((v) => v.taskId).sort()).toEqual(['A-1', 'A-2']);
  });

  it('returns [] when board dirs are missing', () => {
    expect(readBoardVerdicts(join(tmp, 'nope'))).toEqual([]);
  });
});
