/**
 * Turns per dispatch tick (RFC-0051, AISDLC-667.1).
 *
 * The dispatch loop is meant to be mechanical: one `cli-hierarchy tick` per
 * wake-up, with the model only relaying and judging. This module makes that
 * measurable. Each wake-up writes a `DispatchTick` marker (tick id, start, end,
 * the steps it ran); the usage ledger holds the dispatch session's model calls.
 * A call is a turn, and it belongs to the tick that had started at or before it
 * while the next tick had not. The last tick's window ends when its sleep does.
 *
 * A call belongs to the latest step of its tick that had started at or before
 * it; a call before any step started belongs to the step `tick`.
 *
 * Pure functions only; reading the ledger and the events stream is the caller's job.
 *
 * @module usage/dispatch-turns
 */

import type { OrchestratorEvent } from '../orchestrator/events.js';

/** Role under which the dispatch session's calls are recorded. */
export const DISPATCH_ROLE = 'operator-dispatch';
/** Ticks the rolling median covers. */
export const BUDGET_WINDOW_TICKS = 20;
/** Step name for a call that precedes every recorded step of its tick. */
export const TICK_STEP = 'tick';

/** One step a tick ran. */
export interface TickStep {
  name: string;
  startedAt: string;
}

/** The `DispatchTick` event, validated. */
export interface DispatchTickMarker {
  tickId: string;
  startedAt: string;
  endedAt: string;
  steps: TickStep[];
  nextWakeSec: number;
}

/** Model turns one tick used, in total and per step. */
export interface TickTurns {
  tickId: string;
  startedAt: string;
  turns: number;
  byStep: Record<string, number>;
}

/** Median and p90 over a set of ticks, against the budget. */
export interface DispatchTurnsSummary {
  ticks: number;
  median: number | null;
  p90: number | null;
  budget: number;
  overBudget: boolean;
}

/** The step that used the most turns across a set of ticks. */
export interface CostliestStep {
  step: string;
  turns: number;
}

/** Result of checking the rolling median against the budget. */
export interface TurnBudgetFinding extends DispatchTurnsSummary {
  /** Ticks the check looked at (at most {@link BUDGET_WINDOW_TICKS}). */
  window: number;
  costliestStep?: CostliestStep;
}

const ISO = /^\d{4}-\d{2}-\d{2}T/;

function isoMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Valid `DispatchTick` markers out of an events stream, oldest first. Malformed ones are skipped. */
export function parseTickMarkers(events: readonly OrchestratorEvent[]): DispatchTickMarker[] {
  const out: DispatchTickMarker[] = [];
  for (const e of events) {
    if (e?.type !== 'DispatchTick') continue;
    const { tickId, startedAt, endedAt, steps, nextWakeSec } = e as Record<string, unknown>;
    if (typeof tickId !== 'string' || tickId === '') continue;
    if (isoMs(startedAt) === undefined || isoMs(endedAt) === undefined) continue;
    if (!Array.isArray(steps)) continue;
    const parsed: TickStep[] = [];
    for (const s of steps as unknown[]) {
      const step = s as { name?: unknown; startedAt?: unknown } | null;
      if (typeof step?.name !== 'string' || step.name === '') continue;
      if (isoMs(step.startedAt) === undefined) continue;
      parsed.push({ name: step.name, startedAt: step.startedAt as string });
    }
    out.push({
      tickId,
      startedAt: startedAt as string,
      endedAt: endedAt as string,
      steps: parsed,
      nextWakeSec:
        typeof nextWakeSec === 'number' && Number.isFinite(nextWakeSec) && nextWakeSec >= 0
          ? nextWakeSec
          : 0,
    });
  }
  const seen = new Set<string>();
  return out
    .filter((m) => !seen.has(m.tickId) && !!seen.add(m.tickId))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** True for a call recorded by the dispatch session. */
export function isDispatchCall(call: { agentRole?: unknown }): boolean {
  if (typeof call.agentRole !== 'string') return false;
  const role = call.agentRole.trim().toLowerCase();
  return (role.startsWith('ai-sdlc:') ? role.slice('ai-sdlc:'.length) : role) === DISPATCH_ROLE;
}

function stepOf(marker: DispatchTickMarker, ts: number): string {
  let name = TICK_STEP;
  let at = -Infinity;
  for (const s of marker.steps) {
    const start = Date.parse(s.startedAt);
    if (start <= ts && start >= at) {
      name = s.name;
      at = start;
    }
  }
  return name;
}

/**
 * Count the calls (timestamps) falling in each tick. Ticks come back oldest
 * first, one per marker, with zero turns when no call fell in it.
 */
export function turnsPerTick(
  calls: readonly { ts: string }[],
  markers: readonly DispatchTickMarker[],
): TickTurns[] {
  const sorted = [...markers].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const times = calls.map((c) => Date.parse(c.ts)).filter((t) => !Number.isNaN(t));
  return sorted.map((m, i) => {
    const start = Date.parse(m.startedAt);
    const next = sorted[i + 1];
    const end = next ? Date.parse(next.startedAt) : Date.parse(m.endedAt) + m.nextWakeSec * 1000;
    const byStep: Record<string, number> = {};
    let turns = 0;
    for (const t of times) {
      if (t < start || t >= end) continue;
      turns += 1;
      const step = stepOf(m, t);
      byStep[step] = (byStep[step] ?? 0) + 1;
    }
    return { tickId: m.tickId, startedAt: m.startedAt, turns, byStep };
  });
}

/** Nearest-rank percentile of an ascending list; null when empty. */
export function percentile(ascending: readonly number[], p: number): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * ascending.length));
  return ascending[Math.min(rank, ascending.length) - 1];
}

/** Median (the mean of the middle pair for an even count); null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median and p90 of turns per tick over the given ticks. */
export function summariseDispatchTurns(
  ticks: readonly TickTurns[],
  budget: number,
): DispatchTurnsSummary {
  const sorted = ticks.map((t) => t.turns).sort((a, b) => a - b);
  const med = median(sorted);
  return {
    ticks: ticks.length,
    median: med,
    p90: percentile(sorted, 90),
    budget,
    overBudget: med !== null && med > budget,
  };
}

/** The step with the most turns over the ticks (ties break by name); undefined when no turns. */
export function costliestStep(ticks: readonly TickTurns[]): CostliestStep | undefined {
  const totals = new Map<string, number>();
  for (const t of ticks) {
    for (const [step, n] of Object.entries(t.byStep)) totals.set(step, (totals.get(step) ?? 0) + n);
  }
  let best: CostliestStep | undefined;
  for (const [step, turns] of totals) {
    if (!best || turns > best.turns || (turns === best.turns && step < best.step)) {
      best = { step, turns };
    }
  }
  return best;
}

/**
 * Check the rolling median over the last {@link BUDGET_WINDOW_TICKS} ticks. The
 * window must be full before a finding can be an overrun: a handful of ticks
 * after a restart is not a trend. The newest tick is left out because its turns
 * are still being spent.
 */
export function evaluateTurnBudget(ticks: readonly TickTurns[], budget: number): TurnBudgetFinding {
  const completed = ticks.slice(0, -1);
  const window = completed.slice(-BUDGET_WINDOW_TICKS);
  const summary = summariseDispatchTurns(window, budget);
  const full = window.length >= BUDGET_WINDOW_TICKS;
  const costliest = costliestStep(window);
  return {
    ...summary,
    overBudget: full && summary.overBudget,
    window: window.length,
    ...(costliest ? { costliestStep: costliest } : {}),
  };
}
