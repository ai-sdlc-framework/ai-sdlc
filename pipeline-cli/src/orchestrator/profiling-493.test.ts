/**
 * AISDLC-493 — dispatch→merge lifecycle profiling instrumentation tests.
 *
 * Hermetic tests covering:
 *  - AC#1: durationMs wired into loop.ts OrchestratorCompleted events
 *    (tested via computeDurationMs + direct event assertions).
 *  - AC#3: PrOpened, ReconcileCompleted, DispatchToMergeCompleted event types
 *    can be written and read back from the events stream.
 *  - AC#4: DispatchToMergeCompleted correctly joins dispatchedAt + mergedAt
 *    → totalLifecycleMs.
 *  - AC#5: ReconcileCompleted emitted per pass with reSignCount + reconcileDurationMs.
 *  - AC#6: CI-wait derived retroactively in sweep (deriveCiWaitMs).
 *  - AC#7: aggregateProfile reports per-phase percentiles + reconcile counts.
 *  - AC#8: calibration records carry totalLifecycleMs fields when available.
 *  - AC#10: hermetic tests for every new event type + aggregator phase math.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeEvent, eventsFilePath } from './events.js';
import { computeDurationMs } from './profiling.js';
import { aggregateProfile } from '../cli/profile-aggregator.js';
import type { OrchestratorEvent } from './events.js';
import type { TimedVerdictRecord } from '../cli/profile-aggregator.js';
import { readDispatchedAtFromVerdict, deriveCiWaitMs } from '../steps/00-sweep.js';
import type { Runner } from '../runtime/exec.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'profiling-493-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ── AC#1: durationMs wired ────────────────────────────────────────────

describe('computeDurationMs (AC#1 — prerequisite for loop wiring)', () => {
  it('returns correct ms for a 5-minute window', () => {
    expect(computeDurationMs('2026-05-31T10:00:00.000Z', '2026-05-31T10:05:00.000Z')).toBe(300_000);
  });

  it('returns undefined for negative delta', () => {
    expect(
      computeDurationMs('2026-05-31T10:05:00.000Z', '2026-05-31T10:00:00.000Z'),
    ).toBeUndefined();
  });

  it('returns undefined for unparseable timestamps', () => {
    expect(computeDurationMs('bad', '2026-05-31T10:00:00.000Z')).toBeUndefined();
  });
});

// ── AC#3: new event types can be written + read ────────────────────────

describe('PrOpened event (AC#3)', () => {
  it('writes PrOpened event to the stream with expected fields', () => {
    const date = new Date('2026-05-31T10:00:00.000Z');
    const written = writeEvent(
      {
        ts: '',
        type: 'PrOpened',
        taskId: 'AISDLC-493',
        prUrl: 'https://github.com/org/repo/pull/999',
        prOpenedAt: date.toISOString(),
      },
      { artifactsDir: workdir, now: () => date, isEnabled: () => true },
    );
    expect(written).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.type).toBe('PrOpened');
    expect(parsed.taskId).toBe('AISDLC-493');
    expect(parsed.prUrl).toBe('https://github.com/org/repo/pull/999');
    expect(parsed.prOpenedAt).toBe('2026-05-31T10:00:00.000Z');
  });

  it('is a no-op when the orchestrator flag is off', () => {
    const date = new Date('2026-05-31T10:00:00.000Z');
    const written = writeEvent(
      { ts: '', type: 'PrOpened', taskId: 'AISDLC-493' },
      { artifactsDir: workdir, now: () => date, isEnabled: () => false },
    );
    expect(written).toBe(false);
    expect(existsSync(eventsFilePath(workdir, date))).toBe(false);
  });
});

describe('ReconcileCompleted event (AC#3, AC#5)', () => {
  it('writes ReconcileCompleted event with rebased + reSignCount + reconcileDurationMs', () => {
    const date = new Date('2026-05-31T11:00:00.000Z');
    const written = writeEvent(
      {
        ts: '',
        type: 'ReconcileCompleted',
        taskId: 'AISDLC-493',
        prUrl: 'https://github.com/org/repo/pull/999',
        rebased: true,
        reSignCount: 2,
        reconcileDurationMs: 45_000,
      },
      { artifactsDir: workdir, now: () => date, isEnabled: () => true },
    );
    expect(written).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.type).toBe('ReconcileCompleted');
    expect(parsed.rebased).toBe(true);
    expect(parsed.reSignCount).toBe(2);
    expect(parsed.reconcileDurationMs).toBe(45_000);
  });
});

describe('DispatchToMergeCompleted event (AC#3, AC#4)', () => {
  it('writes DispatchToMergeCompleted with correct totalLifecycleMs', () => {
    const date = new Date('2026-05-31T16:00:00.000Z');
    const dispatchedAt = '2026-05-31T10:00:00.000Z';
    const mergedAt = '2026-05-31T16:00:00.000Z';
    const dispMs = Date.parse(dispatchedAt);
    const mergedMs = Date.parse(mergedAt);
    const totalLifecycleMs = mergedMs - dispMs; // 6 hours = 21_600_000 ms

    const written = writeEvent(
      {
        ts: '',
        type: 'DispatchToMergeCompleted',
        taskId: 'AISDLC-493',
        dispatchedAt,
        mergedAt,
        totalLifecycleMs,
        ciWaitMs: 180_000,
      },
      { artifactsDir: workdir, now: () => date, isEnabled: () => true },
    );
    expect(written).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.type).toBe('DispatchToMergeCompleted');
    expect(parsed.dispatchedAt).toBe(dispatchedAt);
    expect(parsed.mergedAt).toBe(mergedAt);
    expect(parsed.totalLifecycleMs).toBe(21_600_000);
    expect(parsed.ciWaitMs).toBe(180_000);
  });

  it('accepts null ciWaitMs (best-effort field)', () => {
    const date = new Date('2026-05-31T16:00:00.000Z');
    const written = writeEvent(
      {
        ts: '',
        type: 'DispatchToMergeCompleted',
        taskId: 'AISDLC-493',
        dispatchedAt: '2026-05-31T10:00:00.000Z',
        mergedAt: '2026-05-31T16:00:00.000Z',
        totalLifecycleMs: 21_600_000,
        ciWaitMs: null,
      },
      { artifactsDir: workdir, now: () => date, isEnabled: () => true },
    );
    expect(written).toBe(true);
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.ciWaitMs).toBeNull();
  });
});

// ── AC#6: CI-wait derivation from sweep ───────────────────────────────

describe('readDispatchedAtFromVerdict (AC#6 prerequisite)', () => {
  it('reads dispatchedAt from done/ verdict', () => {
    const boardDir = join(workdir, 'dispatch');
    mkdirSync(join(boardDir, 'done'), { recursive: true });
    writeFileSync(
      join(boardDir, 'done', 'aisdlc-493.verdict.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-493',
        outcome: 'success',
        completedAt: '2026-05-31T16:00:00.000Z',
        workerId: 'w',
        dispatchedAt: '2026-05-31T10:00:00.000Z',
      }),
    );
    const result = readDispatchedAtFromVerdict(boardDir, 'aisdlc-493');
    expect(result).toBe('2026-05-31T10:00:00.000Z');
  });

  it('returns undefined when no verdict file exists', () => {
    const boardDir = join(workdir, 'dispatch');
    mkdirSync(join(boardDir, 'done'), { recursive: true });
    const result = readDispatchedAtFromVerdict(boardDir, 'aisdlc-999');
    expect(result).toBeUndefined();
  });

  it('returns undefined when verdict has no dispatchedAt field', () => {
    const boardDir = join(workdir, 'dispatch');
    mkdirSync(join(boardDir, 'done'), { recursive: true });
    writeFileSync(
      join(boardDir, 'done', 'aisdlc-493.verdict.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-493',
        outcome: 'success',
        completedAt: '2026-05-31T16:00:00.000Z',
        workerId: 'w',
        // no dispatchedAt
      }),
    );
    const result = readDispatchedAtFromVerdict(boardDir, 'aisdlc-493');
    expect(result).toBeUndefined();
  });
});

describe('deriveCiWaitMs (AC#6)', () => {
  it('returns null when gh run list exits non-zero', async () => {
    const runner: Runner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'auth failed',
    });
    const result = await deriveCiWaitMs('my-branch', workdir, runner);
    expect(result).toBeNull();
  });

  it('returns null when gh run list returns empty array', async () => {
    const runner: Runner = async () => ({
      code: 0,
      stdout: '[]',
      stderr: '',
    });
    const result = await deriveCiWaitMs('my-branch', workdir, runner);
    expect(result).toBeNull();
  });

  it('returns the duration of the first completed run', async () => {
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          conclusion: 'success',
          startedAt: '2026-05-31T15:00:00.000Z',
          completedAt: '2026-05-31T15:03:00.000Z',
        },
      ]),
      stderr: '',
    });
    const result = await deriveCiWaitMs('my-branch', workdir, runner);
    expect(result).toBe(180_000); // 3 minutes
  });

  it('skips runs with missing timestamps and falls through to null', async () => {
    const runner: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify([{ conclusion: 'success', startedAt: null, completedAt: null }]),
      stderr: '',
    });
    const result = await deriveCiWaitMs('my-branch', workdir, runner);
    expect(result).toBeNull();
  });
});

// ── AC#7: aggregateProfile per-phase percentiles ──────────────────────

describe('aggregateProfile — per-phase percentiles + reconcile counts (AC#7)', () => {
  const frozenNow = () => new Date('2026-05-31T20:00:00.000Z');

  function completedEvent(taskId: string, durationMs: number): OrchestratorEvent {
    return {
      ts: '2026-05-31T12:00:00.000Z',
      type: 'OrchestratorCompleted',
      taskId,
      outcome: 'success',
      durationMs,
    };
  }

  function reconcileEvent(taskId: string, reconcileDurationMs: number): OrchestratorEvent {
    return {
      ts: '2026-05-31T14:00:00.000Z',
      type: 'ReconcileCompleted',
      taskId,
      rebased: true,
      reSignCount: 1,
      reconcileDurationMs,
    };
  }

  function lifecycleEvent(
    taskId: string,
    totalLifecycleMs: number,
    ciWaitMs: number | null,
  ): OrchestratorEvent {
    return {
      ts: '2026-05-31T18:00:00.000Z',
      type: 'DispatchToMergeCompleted',
      taskId,
      dispatchedAt: '2026-05-31T10:00:00.000Z',
      mergedAt: '2026-05-31T16:00:00.000Z',
      totalLifecycleMs,
      ciWaitMs,
    };
  }

  it('computes phasePercentiles.devMs from OrchestratorCompleted durationMs', () => {
    const events: OrchestratorEvent[] = [
      completedEvent('T-1', 300_000),
      completedEvent('T-2', 600_000),
    ];
    const report = aggregateProfile([], events, frozenNow);
    expect(report.summary.phasePercentiles.devMs.p50).toBe(300_000);
    expect(report.summary.phasePercentiles.devMs.p95).toBe(600_000);
  });

  it('computes phasePercentiles.reconcileMs from ReconcileCompleted events', () => {
    const events: OrchestratorEvent[] = [
      completedEvent('T-1', 300_000),
      reconcileEvent('T-1', 30_000),
      reconcileEvent('T-1', 60_000), // two reconcile passes
    ];
    const report = aggregateProfile([], events, frozenNow);
    expect(report.summary.phasePercentiles.reconcileMs.p50).toBe(30_000);
    expect(report.summary.phasePercentiles.reconcileMs.p95).toBe(60_000);
  });

  it('counts reconcile cycles per task', () => {
    const events: OrchestratorEvent[] = [
      completedEvent('T-1', 300_000),
      reconcileEvent('T-1', 30_000),
      reconcileEvent('T-1', 45_000),
      reconcileEvent('T-2', 20_000),
    ];
    const report = aggregateProfile([], events, frozenNow);
    expect(report.summary.reconcileCycleCounts['T-1']).toBe(2);
    expect(report.summary.reconcileCycleCounts['T-2']).toBe(1);
  });

  it('computes phasePercentiles.totalLifecycleMs from DispatchToMergeCompleted', () => {
    const events: OrchestratorEvent[] = [
      completedEvent('T-1', 300_000),
      lifecycleEvent('T-1', 21_600_000, 180_000),
    ];
    const report = aggregateProfile([], events, frozenNow);
    expect(report.summary.lifecycleP50Ms).toBe(21_600_000);
    expect(report.summary.phasePercentiles.totalLifecycleMs.p50).toBe(21_600_000);
  });

  it('computes phasePercentiles.ciWaitMs from DispatchToMergeCompleted.ciWaitMs', () => {
    const events: OrchestratorEvent[] = [
      lifecycleEvent('T-1', 21_600_000, 180_000),
      lifecycleEvent('T-2', 7_200_000, 120_000),
    ];
    const report = aggregateProfile([], events, frozenNow);
    expect(report.summary.phasePercentiles.ciWaitMs.p50).toBe(120_000);
    expect(report.summary.phasePercentiles.ciWaitMs.p95).toBe(180_000);
  });

  it('returns null percentiles when no data is available for a phase', () => {
    const verdicts: TimedVerdictRecord[] = [
      { taskId: 'T-1', outcome: 'success', durationMs: 60_000 },
    ];
    const report = aggregateProfile(verdicts, [], frozenNow);
    expect(report.summary.phasePercentiles.reconcileMs.p50).toBeNull();
    expect(report.summary.phasePercentiles.ciWaitMs.p50).toBeNull();
    expect(report.summary.lifecycleP50Ms).toBeNull();
  });

  it('skips null ciWaitMs when computing ciWaitMs percentiles', () => {
    const events: OrchestratorEvent[] = [
      lifecycleEvent('T-1', 21_600_000, null), // ciWaitMs=null should be skipped
    ];
    const report = aggregateProfile([], events, frozenNow);
    // ciWaitMs had no valid samples
    expect(report.summary.phasePercentiles.ciWaitMs.p50).toBeNull();
    // but lifecycle is populated
    expect(report.summary.lifecycleP50Ms).toBe(21_600_000);
  });
});

// ── AC#8: calibration records carry totalLifecycleMs fields ──────────

describe('aggregateProfile — actuals include dispatch-anchor fields for downstream calibration (AC#8)', () => {
  const frozenNow = () => new Date('2026-05-31T20:00:00.000Z');

  it('actuals include dispatchedAt + completedAt when available from verdicts', () => {
    const verdicts: TimedVerdictRecord[] = [
      {
        taskId: 'T-1',
        outcome: 'success',
        durationMs: 300_000,
        dispatchedAt: '2026-05-31T10:00:00.000Z',
        completedAt: '2026-05-31T10:05:00.000Z',
      },
    ];
    const report = aggregateProfile(verdicts, [], frozenNow);
    expect(report.actuals).toHaveLength(1);
    expect(report.actuals[0]!.dispatchedAt).toBe('2026-05-31T10:00:00.000Z');
    expect(report.actuals[0]!.completedAt).toBe('2026-05-31T10:05:00.000Z');
    expect(report.actuals[0]!.actualWallClockSec).toBe(300); // 300_000ms = 300s
  });
});

// ── AC#1 + existing profiling still green ────────────────────────────

describe('existing profiling tests still pass (AC#10)', () => {
  it('OrchestratorCompleted events carry durationMs when present', () => {
    const date = new Date('2026-05-31T10:05:00.000Z');
    writeEvent(
      {
        ts: '',
        type: 'OrchestratorCompleted',
        taskId: 'AISDLC-493',
        outcome: 'success',
        durationMs: 300_000,
      },
      { artifactsDir: workdir, now: () => date, isEnabled: () => true },
    );
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.durationMs).toBe(300_000);
  });
});
