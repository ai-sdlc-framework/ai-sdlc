/**
 * Parallel-dispatch profiling aggregator (AISDLC-479).
 *
 * Reads the two timing surfaces AISDLC-479 wired up —
 *   1. `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl` —
 *      `OrchestratorCompleted` / `OrchestratorFailed` events carrying
 *      `taskId`, `ts`, `durationMs`, `outcome`.
 *   2. `.ai-sdlc/dispatch/done/<task-id>.verdict.json` (+ `failed/`) —
 *      Dispatch-Board verdicts carrying `dispatchedAt`, `completedAt`,
 *      `durationMs`, `outcome`.
 *
 * — and produces a per-task + summary throughput report (count, p50/p95
 * `durationMs`, success rate). It also derives `actualWallClockSec` from
 * each task's `durationMs` and returns `EstimateActualsRecorded` records
 * ready to append to `_estimates/calibration-YYYY-MM.jsonl` (AC-3, AC-4 —
 * using only the existing field names `durationMs`, `dispatchedAt`,
 * `completedAt`, `actualWallClockSec`).
 *
 * Pure functions only — no I/O beyond the explicit reader helpers — so the
 * math (percentiles, success rate) is unit-testable against synthetic
 * fixtures (AC-5).
 *
 * @module cli/profile-aggregator
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OrchestratorEvent } from '../orchestrator/events.js';
import { isCompletionOutcome } from '../orchestrator/profiling.js';

// ── Verdict shape (minimal) ───────────────────────────────────────────

/**
 * The subset of `DispatchVerdict` the aggregator reads. Duck-typed at the
 * boundary so a malformed or partial verdict file is skipped rather than
 * crashing the aggregation.
 */
export interface TimedVerdictRecord {
  taskId: string;
  outcome: string;
  dispatchedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

// ── Per-task + summary report shapes ──────────────────────────────────

export interface TaskProfile {
  taskId: string;
  /** Most-recent observed `durationMs` for the task (verdict preferred over event). */
  durationMs: number | null;
  /** Outcome carried on the timing record. */
  outcome: string;
  /** True when `outcome` is a successful completion. */
  success: boolean;
  /** Dispatch anchor (verdict source only). */
  dispatchedAt: string | null;
  /** Completion timestamp. */
  completedAt: string | null;
  /** Where the timing came from. */
  source: 'verdict' | 'event';
}

export interface ProfileSummary {
  /** Number of tasks with at least one timing record. */
  taskCount: number;
  /** Number of tasks whose outcome was a successful completion. */
  successCount: number;
  /** `successCount / taskCount`. `0` when `taskCount === 0`. */
  successRate: number;
  /** Number of tasks that carried a usable `durationMs`. */
  durationSampleCount: number;
  /** Median `durationMs` across tasks with duration data. `null` when none. */
  p50DurationMs: number | null;
  /** 95th-percentile `durationMs`. `null` when no duration data. */
  p95DurationMs: number | null;
  /** Sum of `durationMs` across tasks with duration data. */
  totalDurationMs: number;
  /**
   * AISDLC-493 — per-phase percentiles for dispatch→merge lifecycle phases.
   * Each phase carries `p50` and `p95` in milliseconds (`null` when no data).
   */
  phasePercentiles: PhasePercentiles;
  /**
   * AISDLC-493 — reconcile cycle counts per task (from `ReconcileCompleted`
   * events). Key = taskId, value = count of ReconcileCompleted events seen.
   * Tasks with no reconcile events are absent from the map.
   */
  reconcileCycleCounts: Record<string, number>;
  /**
   * AISDLC-493 — total dispatch→merge lifecycle percentiles across all tasks
   * where `DispatchToMergeCompleted` was observed.
   */
  lifecycleP50Ms: number | null;
  lifecycleP95Ms: number | null;
}

/**
 * AISDLC-493 — per-phase duration percentiles derived from the new phase events.
 */
export interface PhasePercentiles {
  /** Dev phase duration (OrchestratorDispatched → OrchestratorCompleted). */
  devMs: { p50: number | null; p95: number | null };
  /** Reconcile overhead per reconcile pass (from ReconcileCompleted.reconcileDurationMs). */
  reconcileMs: { p50: number | null; p95: number | null };
  /** CI-wait duration (from DispatchToMergeCompleted.ciWaitMs, best-effort). */
  ciWaitMs: { p50: number | null; p95: number | null };
  /** Total dispatch→merge lifecycle (from DispatchToMergeCompleted.totalLifecycleMs). */
  totalLifecycleMs: { p50: number | null; p95: number | null };
}

export interface ProfileReport {
  perTask: TaskProfile[];
  summary: ProfileSummary;
  /** `EstimateActualsRecorded` records ready to append to calibration. */
  actuals: EstimateActualsRecord[];
}

/**
 * One `EstimateActualsRecorded` JSONL record appended to
 * `_estimates/calibration-YYYY-MM.jsonl` (AC-3 / AC-4). Uses ONLY the
 * existing field names the task mandates plus the event envelope
 * (`ts`, `type`, `taskId`) shared by every record on that stream.
 */
export interface EstimateActualsRecord {
  ts: string;
  type: 'EstimateActualsRecorded';
  taskId: string;
  /** Net wall-clock in seconds (`round(durationMs / 1000)`). */
  actualWallClockSec: number;
  /** Raw wall-clock in ms (verbatim from the timing record). */
  durationMs: number;
  /** Dispatch anchor when available (verdict source). */
  dispatchedAt?: string;
  /** Completion timestamp when available. */
  completedAt?: string;
}

// ── Percentile math (AC-5) ────────────────────────────────────────────

/**
 * Nearest-rank percentile over a numeric sample. `p` is a fraction in
 * `[0, 1]` (e.g. `0.5` = median, `0.95` = p95). Returns `null` for an
 * empty sample.
 *
 * Nearest-rank (rather than linear interpolation) is chosen deliberately:
 * durations are a small, discrete corpus where "the actual observed value
 * at rank ceil(p·n)" is more interpretable to an operator than an
 * interpolated phantom value.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (p <= 0) return sorted[0]!;
  if (p >= 1) return sorted[sorted.length - 1]!;
  // Nearest-rank: rank = ceil(p * n), 1-indexed.
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

// ── Core aggregation (pure) ───────────────────────────────────────────

/**
 * Aggregate timing records from BOTH sources into a per-task + summary
 * report. Pure — no I/O — so tests pass synthetic arrays.
 *
 * De-duplication: a task may appear in BOTH the verdict set and the event
 * set (the Worker writes the verdict AND emits the event). When that
 * happens the VERDICT wins (it carries `dispatchedAt`/`completedAt` the
 * event omits); the event is the fallback for tasks that emitted an event
 * but whose verdict file was already swept by the Conductor.
 *
 * AISDLC-493: also computes per-phase percentiles and reconcile-cycle
 * counts from the new `PrOpened`, `ReconcileCompleted`, and
 * `DispatchToMergeCompleted` event types.
 */
export function aggregateProfile(
  verdicts: readonly TimedVerdictRecord[],
  events: readonly OrchestratorEvent[],
  now: () => Date = () => new Date(),
): ProfileReport {
  const byTask = new Map<string, TaskProfile>();

  // Pass 1 — events (lower priority).
  for (const e of events) {
    if (e.type !== 'OrchestratorCompleted' && e.type !== 'OrchestratorFailed') continue;
    if (typeof e.taskId !== 'string' || e.taskId.length === 0) continue;
    const outcome =
      typeof e.outcome === 'string'
        ? e.outcome
        : e.type === 'OrchestratorCompleted'
          ? 'success'
          : 'failed';
    const durationMs = typeof e.durationMs === 'number' && e.durationMs >= 0 ? e.durationMs : null;
    byTask.set(e.taskId, {
      taskId: e.taskId,
      durationMs,
      outcome,
      success: isCompletionOutcome(outcome),
      dispatchedAt: null,
      completedAt: typeof e.ts === 'string' && e.ts.length > 0 ? e.ts : null,
      source: 'event',
    });
  }

  // Pass 2 — verdicts (higher priority; overwrite the event row).
  for (const v of verdicts) {
    if (typeof v.taskId !== 'string' || v.taskId.length === 0) continue;
    const durationMs = typeof v.durationMs === 'number' && v.durationMs >= 0 ? v.durationMs : null;
    byTask.set(v.taskId, {
      taskId: v.taskId,
      durationMs,
      outcome: v.outcome,
      success: isCompletionOutcome(v.outcome),
      dispatchedAt: typeof v.dispatchedAt === 'string' ? v.dispatchedAt : null,
      completedAt: typeof v.completedAt === 'string' ? v.completedAt : null,
      source: 'verdict',
    });
  }

  const perTask = [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));

  const durations = perTask
    .map((t) => t.durationMs)
    .filter((d): d is number => typeof d === 'number');
  const successCount = perTask.filter((t) => t.success).length;
  const taskCount = perTask.length;

  // AISDLC-493 — extract per-phase samples from the new event types.
  const reconcileDurations: number[] = [];
  const ciWaitDurations: number[] = [];
  const totalLifecycleDurations: number[] = [];
  const reconcileCycleCounts: Record<string, number> = {};

  for (const e of events) {
    if (e.type === 'ReconcileCompleted') {
      if (typeof e.reconcileDurationMs === 'number' && e.reconcileDurationMs >= 0) {
        reconcileDurations.push(e.reconcileDurationMs as number);
      }
      if (typeof e.taskId === 'string' && e.taskId.length > 0) {
        reconcileCycleCounts[e.taskId] = (reconcileCycleCounts[e.taskId] ?? 0) + 1;
      }
    } else if (e.type === 'DispatchToMergeCompleted') {
      if (typeof e.totalLifecycleMs === 'number' && e.totalLifecycleMs >= 0) {
        totalLifecycleDurations.push(e.totalLifecycleMs as number);
      }
      const ciWait = e.ciWaitMs;
      if (typeof ciWait === 'number' && ciWait >= 0) {
        ciWaitDurations.push(ciWait);
      }
    }
  }

  const phasePercentiles: PhasePercentiles = {
    devMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    reconcileMs: {
      p50: percentile(reconcileDurations, 0.5),
      p95: percentile(reconcileDurations, 0.95),
    },
    ciWaitMs: {
      p50: percentile(ciWaitDurations, 0.5),
      p95: percentile(ciWaitDurations, 0.95),
    },
    totalLifecycleMs: {
      p50: percentile(totalLifecycleDurations, 0.5),
      p95: percentile(totalLifecycleDurations, 0.95),
    },
  };

  const summary: ProfileSummary = {
    taskCount,
    successCount,
    successRate: taskCount === 0 ? 0 : successCount / taskCount,
    durationSampleCount: durations.length,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    totalDurationMs: durations.reduce((acc, d) => acc + d, 0),
    phasePercentiles,
    reconcileCycleCounts,
    lifecycleP50Ms: percentile(totalLifecycleDurations, 0.5),
    lifecycleP95Ms: percentile(totalLifecycleDurations, 0.95),
  };

  // Build EstimateActualsRecorded records (AC-3 / AC-4) for every task
  // that carried a usable durationMs. Tasks without duration data can't
  // contribute an actuals record (no wall-clock to record).
  const ts = now().toISOString();
  const actuals: EstimateActualsRecord[] = [];
  for (const t of perTask) {
    if (t.durationMs === null) continue;
    const record: EstimateActualsRecord = {
      ts,
      type: 'EstimateActualsRecorded',
      taskId: t.taskId,
      actualWallClockSec: Math.round(t.durationMs / 1000),
      durationMs: t.durationMs,
    };
    if (t.dispatchedAt) record.dispatchedAt = t.dispatchedAt;
    if (t.completedAt) record.completedAt = t.completedAt;
    actuals.push(record);
  }

  return { perTask, summary, actuals };
}

// ── Readers (I/O) ─────────────────────────────────────────────────────

/**
 * Read every `OrchestratorCompleted` / `OrchestratorFailed` event under
 * `<artifactsDir>/_orchestrator/events-*.jsonl`. Malformed lines + missing
 * dir are tolerated (returns the events it could parse).
 */
export function readProfilingEvents(artifactsDir: string): OrchestratorEvent[] {
  const dir = join(artifactsDir, '_orchestrator');
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch {
    return [];
  }
  const out: OrchestratorEvent[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as OrchestratorEvent;
        if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

/**
 * Read every verdict under `<boardDir>/done/` and `<boardDir>/failed/`.
 * Malformed / partial verdict files are skipped. Mirrors the board's own
 * `.verdict.json` suffix convention.
 */
export function readBoardVerdicts(boardDir: string): TimedVerdictRecord[] {
  const out: TimedVerdictRecord[] = [];
  for (const sub of ['done', 'failed'] as const) {
    const dir = join(boardDir, sub);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.verdict.json')) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, entry), 'utf8');
      } catch {
        continue;
      }
      try {
        const v = JSON.parse(raw) as TimedVerdictRecord;
        if (
          v &&
          typeof v === 'object' &&
          typeof v.taskId === 'string' &&
          typeof v.outcome === 'string'
        ) {
          out.push(v);
        }
      } catch {
        /* skip malformed verdict */
      }
    }
  }
  return out;
}
