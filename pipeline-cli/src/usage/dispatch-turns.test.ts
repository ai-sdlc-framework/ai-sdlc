/**
 * Turns per dispatch tick (AISDLC-667.1): markers, bucketing, median and p90,
 * and the rolling budget check. Pure: fixtures only.
 */

import { describe, expect, it } from 'vitest';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import {
  BUDGET_WINDOW_TICKS,
  costliestStep,
  evaluateTurnBudget,
  isDispatchCall,
  median,
  parseTickMarkers,
  percentile,
  summariseDispatchTurns,
  turnsPerTick,
  type DispatchTickMarker,
  type TickTurns,
} from './dispatch-turns.js';

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

function marker(i: number, over: Partial<DispatchTickMarker> = {}): DispatchTickMarker {
  return {
    tickId: `t${i}`,
    startedAt: at(i * 100),
    endedAt: at(i * 100 + 1),
    steps: [
      { name: 'ingest', startedAt: at(i * 100) },
      { name: 'reports', startedAt: at(i * 100 + 1) },
    ],
    nextWakeSec: 30,
    ...over,
  };
}

const event = (m: object): OrchestratorEvent => ({
  ts: at(0),
  type: 'DispatchTick',
  ...m,
});

describe('parseTickMarkers', () => {
  it('keeps valid markers, oldest first, and drops malformed or duplicate ones', () => {
    const parsed = parseTickMarkers([
      event(marker(2)),
      event(marker(1)),
      event(marker(1)),
      event({ ...marker(3), tickId: '' }),
      event({ ...marker(4), startedAt: 'yesterday' }),
      event({ ...marker(5), steps: 'none' }),
      { ts: at(0), type: 'OrchestratorTick' },
      event({
        ...marker(6),
        nextWakeSec: -1,
        steps: [
          { name: '', startedAt: at(1) },
          { name: 'x', startedAt: 'bad' },
          null,
          { name: 'ok', startedAt: at(2) },
        ],
      }),
    ] as OrchestratorEvent[]);
    expect(parsed.map((m) => m.tickId)).toEqual(['t1', 't2', 't6']);
    expect(parsed[2]).toMatchObject({ nextWakeSec: 0, steps: [{ name: 'ok', startedAt: at(2) }] });
  });
});

describe('isDispatchCall', () => {
  it('matches the dispatch role with or without the plugin prefix', () => {
    expect(isDispatchCall({ agentRole: 'operator-dispatch' })).toBe(true);
    expect(isDispatchCall({ agentRole: 'ai-sdlc:Operator-Dispatch' })).toBe(true);
    expect(isDispatchCall({ agentRole: 'developer' })).toBe(false);
    expect(isDispatchCall({})).toBe(false);
  });
});

describe('turnsPerTick', () => {
  it('buckets calls by tick and attributes each to the latest started step', () => {
    const ticks = turnsPerTick(
      [
        { ts: at(0.5) }, // before `reports` started
        { ts: at(5) },
        { ts: at(50) },
        { ts: at(105) }, // second tick
        { ts: at(-10) }, // before every tick
        { ts: 'not a date' },
      ],
      [marker(1), marker(0)],
    );
    expect(ticks).toEqual([
      { tickId: 't0', startedAt: at(0), turns: 3, byStep: { ingest: 1, reports: 2 } },
      { tickId: 't1', startedAt: at(100), turns: 1, byStep: { reports: 1 } },
    ]);
  });

  it('ends the last tick when its sleep ends, and names a call before any step', () => {
    const last = marker(0, { steps: [{ name: 'late', startedAt: at(10) }], nextWakeSec: 30 });
    const ticks = turnsPerTick(
      [{ ts: at(2) }, { ts: at(20) }, { ts: at(31) }, { ts: at(32) }],
      [last],
    );
    expect(ticks[0]).toMatchObject({ turns: 2, byStep: { tick: 1, late: 1 } });
  });

  it('gives a tick with no calls zero turns', () => {
    expect(turnsPerTick([], [marker(0)])[0].turns).toBe(0);
  });
});

describe('statistics', () => {
  it('computes nearest-rank percentiles and medians', () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([4], 90)).toBe(4);
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });

  it('summarises against the budget', () => {
    const ticks: TickTurns[] = [2, 8, 9].map((turns, i) => ({
      tickId: `t${i}`,
      startedAt: at(i),
      turns,
      byStep: {},
    }));
    expect(summariseDispatchTurns(ticks, 5)).toEqual({
      ticks: 3,
      median: 8,
      p90: 9,
      budget: 5,
      overBudget: true,
    });
    expect(summariseDispatchTurns([], 5)).toMatchObject({ median: null, overBudget: false });
  });

  it('finds the costliest step, ties by name, none without turns', () => {
    expect(costliestStep([])).toBeUndefined();
    const t = (byStep: Record<string, number>): TickTurns => ({
      tickId: 'x',
      startedAt: at(0),
      turns: 0,
      byStep,
    });
    expect(costliestStep([t({ b: 2, a: 2 }), t({ c: 1 })])).toEqual({ step: 'a', turns: 2 });
  });
});

describe('evaluateTurnBudget', () => {
  const series = (turns: number[], byStep: Record<string, number> = { reports: 1 }): TickTurns[] =>
    turns.map((n, i) => ({ tickId: `t${i}`, startedAt: at(i), turns: n, byStep }));

  it('needs a full window of completed ticks before it reports an overrun', () => {
    expect(evaluateTurnBudget(series(Array(BUDGET_WINDOW_TICKS).fill(9)), 5).overBudget).toBe(
      false,
    );
    const full = evaluateTurnBudget(series(Array(BUDGET_WINDOW_TICKS + 1).fill(9)), 5);
    expect(full).toMatchObject({ overBudget: true, window: BUDGET_WINDOW_TICKS, median: 9 });
    expect(full.costliestStep).toEqual({ step: 'reports', turns: BUDGET_WINDOW_TICKS });
  });

  it('uses only the last window and stays under budget at the budget', () => {
    const turns = [...Array(10).fill(50), ...Array(BUDGET_WINDOW_TICKS).fill(5), 0];
    expect(evaluateTurnBudget(series(turns), 5)).toMatchObject({ overBudget: false, median: 5 });
  });
});
