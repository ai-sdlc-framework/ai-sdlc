/**
 * Usage window arithmetic (RFC-0050 A4).
 *
 * A window is bounded one of three ways (see the usage config schema):
 *   first-use  opens at the first call after the previous window ended
 *   fixed      repeating cycles counted from a configured anchor
 *   trailing   the last `lengthHours` before the instant asked about
 *
 * All arithmetic is in epoch milliseconds so tests can pin a clock.
 *
 * @module usage/windows
 */

import type { ModelCallRecord } from '@ai-sdlc/reference';
import { unitsForCall, type UnitWeights } from './units.js';
import type { WindowSpec } from './usage-config.js';

const HOUR_MS = 3_600_000;

export interface WindowRange {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end of the window, epoch ms (may be in the future). */
  end: number;
}

export function lengthMs(spec: WindowSpec): number {
  return spec.lengthHours * HOUR_MS;
}

/** Start times of the windows a sorted list of call times falls into (first-use chain). */
function chainStarts(spec: WindowSpec, sortedTimes: readonly number[]): number[] {
  const len = lengthMs(spec);
  const starts: number[] = [];
  let current: number | undefined;
  for (const t of sortedTimes) {
    if (current === undefined || t >= current + len) {
      current = t;
      starts.push(t);
    }
  }
  return starts;
}

/** The window of `spec` that contains `at`, or undefined when no window is open then. */
export function windowRangeAt(
  spec: WindowSpec,
  sortedTimes: readonly number[],
  at: number,
): WindowRange | undefined {
  const len = lengthMs(spec);
  if (spec.mode === 'trailing') return { start: at - len, end: at };
  if (spec.mode === 'fixed' && spec.anchor) {
    const anchor = Date.parse(spec.anchor);
    const k = Math.floor((at - anchor) / len);
    return { start: anchor + k * len, end: anchor + (k + 1) * len };
  }
  const upTo = sortedTimes.filter((t) => t <= at);
  const starts = chainStarts(spec, upTo);
  const start = starts[starts.length - 1];
  if (start === undefined || at >= start + len) return undefined;
  return { start, end: start + len };
}

/**
 * Maps a call time to the start of the window bucket it belongs to. Every call
 * lands in exactly one bucket, so bucket totals sum to the overall total.
 */
export function bucketStarter(
  spec: WindowSpec,
  sortedTimes: readonly number[],
): (t: number) => number {
  const len = lengthMs(spec);
  if (spec.mode === 'fixed' && spec.anchor) {
    const anchor = Date.parse(spec.anchor);
    return (t) => anchor + Math.floor((t - anchor) / len) * len;
  }
  const starts = chainStarts(spec, sortedTimes);
  return (t) => {
    let found = starts[0] ?? t;
    for (const s of starts) {
      if (s <= t) found = s;
      else break;
    }
    return found;
  };
}

export function recordTimes(records: readonly ModelCallRecord[]): number[] {
  return records
    .map((r) => Date.parse(r.ts))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
}

export interface WindowUsage {
  units: number;
  calls: number;
  /** Share of units per model, summing to 1 (empty when there is no usage). */
  modelMix: Record<string, number>;
  /** Time of the earliest call in the range, epoch ms. */
  firstCallAt?: number;
}

/** Units consumed by calls with `start <= ts <= until`. */
export function usageInRange(
  records: readonly ModelCallRecord[],
  start: number,
  until: number,
  weights: UnitWeights,
): WindowUsage {
  let units = 0;
  let calls = 0;
  let firstCallAt: number | undefined;
  const byModel: Record<string, number> = {};
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < start || t > until) continue;
    const u = unitsForCall(r, weights);
    units += u;
    calls += 1;
    byModel[r.model] = (byModel[r.model] ?? 0) + u;
    if (firstCallAt === undefined || t < firstCallAt) firstCallAt = t;
  }
  const modelMix: Record<string, number> = {};
  if (units > 0) for (const [m, u] of Object.entries(byModel)) modelMix[m] = u / units;
  return { units, calls, modelMix, ...(firstCallAt !== undefined ? { firstCallAt } : {}) };
}

export interface WindowView {
  window: string;
  lengthHours: number;
  /** ISO bounds of the current window, absent when none is open. */
  start?: string;
  end?: string;
  units: number;
  calls: number;
  /** Latest implied allotment for this window, in units. */
  impliedAllotment?: number;
  percentOfAllotment?: number;
  /** Units per hour: units in the window divided by hours since its first call. */
  ratePerHour?: number;
  /** Hours until the implied allotment is used up at the rate above. */
  hoursToLimit?: number;
}

/** The current usage of one window and, when an allotment is known, the projection. */
export function viewWindow(
  spec: WindowSpec,
  records: readonly ModelCallRecord[],
  weights: UnitWeights,
  now: number,
  impliedAllotment?: number,
): WindowView {
  const times = recordTimes(records);
  const range = windowRangeAt(spec, times, now);
  const base: WindowView = {
    window: spec.name,
    lengthHours: spec.lengthHours,
    units: 0,
    calls: 0,
    ...(impliedAllotment !== undefined ? { impliedAllotment } : {}),
  };
  if (!range) return base;
  const usage = usageInRange(records, range.start, now, weights);
  const view: WindowView = {
    ...base,
    start: new Date(range.start).toISOString(),
    end: new Date(range.end).toISOString(),
    units: usage.units,
    calls: usage.calls,
  };
  if (impliedAllotment !== undefined && impliedAllotment > 0) {
    view.percentOfAllotment = (usage.units / impliedAllotment) * 100;
  }
  if (usage.firstCallAt !== undefined && usage.units > 0) {
    const elapsedH = Math.max((now - usage.firstCallAt) / HOUR_MS, 1 / 60);
    view.ratePerHour = usage.units / elapsedH;
    if (impliedAllotment !== undefined && impliedAllotment > 0) {
      view.hoursToLimit = Math.max(0, impliedAllotment - usage.units) / view.ratePerHour;
    }
  }
  return view;
}
