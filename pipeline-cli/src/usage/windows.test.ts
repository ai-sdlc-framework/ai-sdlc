import { describe, expect, it } from 'vitest';
import type { ModelCallRecord } from '@ai-sdlc/reference';
import { deriveUnitWeights } from './units.js';
import type { WindowSpec } from './usage-config.js';
import { bucketStarter, recordTimes, usageInRange, viewWindow, windowRangeAt } from './windows.js';

const H = 3_600_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const weights = deriveUnitWeights([], '2026-09-01T00:00:00Z');

function rec(hoursFromT0: number, input: number, model = 'm1'): ModelCallRecord {
  return {
    schemaVersion: 'v1',
    callId: `c-${hoursFromT0}-${input}`,
    ts: new Date(T0 + hoursFromT0 * H).toISOString(),
    harness: 'claude-code',
    provider: 'anthropic',
    model,
    tokens: { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    billingPool: 'subscription-interactive',
    sessionId: 's',
    agentRole: 'main-session',
    scope: 'framework',
  };
}

const session: WindowSpec = { name: 'session', lengthHours: 5, mode: 'first-use' };
const weekly: WindowSpec = { name: 'weekly', lengthHours: 168, mode: 'trailing' };

describe('windowRangeAt', () => {
  const times = [0, 1, 2, 7, 8].map((h) => T0 + h * H);

  it('first-use: the window opens at the first call and lasts its length', () => {
    const r = windowRangeAt(session, times, T0 + 3 * H);
    expect(r).toEqual({ start: T0, end: T0 + 5 * H });
  });

  it('first-use: a call after the window ended opens the next one', () => {
    const r = windowRangeAt(session, times, T0 + 9 * H);
    expect(r).toEqual({ start: T0 + 7 * H, end: T0 + 12 * H });
  });

  it('first-use: no window is open when the last one has ended', () => {
    expect(windowRangeAt(session, times, T0 + 20 * H)).toBeUndefined();
    expect(windowRangeAt(session, [], T0)).toBeUndefined();
  });

  it('trailing: the last lengthHours before the instant', () => {
    expect(windowRangeAt(weekly, times, T0 + 10 * H)).toEqual({
      start: T0 + 10 * H - 168 * H,
      end: T0 + 10 * H,
    });
  });

  it('fixed: cycles counted from the anchor', () => {
    const fixed: WindowSpec = {
      name: 'weekly',
      lengthHours: 24,
      mode: 'fixed',
      anchor: new Date(T0 + 2 * H).toISOString(),
    };
    expect(windowRangeAt(fixed, [], T0 + 30 * H)).toEqual({ start: T0 + 26 * H, end: T0 + 50 * H });
    expect(windowRangeAt(fixed, [], T0)).toEqual({ start: T0 - 22 * H, end: T0 + 2 * H });
  });
});

describe('bucketStarter', () => {
  it('assigns every call to exactly one first-use bucket', () => {
    const times = [0, 1, 6, 7, 20].map((h) => T0 + h * H);
    const start = bucketStarter(session, times);
    expect(start(T0 + H)).toBe(T0);
    expect(start(T0 + 6 * H)).toBe(T0 + 6 * H);
    expect(start(T0 + 7 * H)).toBe(T0 + 6 * H);
    expect(start(T0 + 20 * H)).toBe(T0 + 20 * H);
  });

  it('uses the anchor for fixed windows', () => {
    const fixed: WindowSpec = {
      name: 'd',
      lengthHours: 24,
      mode: 'fixed',
      anchor: new Date(T0).toISOString(),
    };
    expect(bucketStarter(fixed, [])(T0 + 30 * H)).toBe(T0 + 24 * H);
  });

  it('falls back to the call time when there are no chains', () => {
    expect(bucketStarter(session, [])(T0 + H)).toBe(T0 + H);
  });
});

describe('usageInRange and viewWindow', () => {
  const records = [rec(0, 100), rec(1, 300, 'm2'), rec(2, 600), rec(30, 999)];

  it('sums units and model mix inside the range only', () => {
    const u = usageInRange(records, T0, T0 + 3 * H, weights);
    expect(u.units).toBe(1000);
    expect(u.calls).toBe(3);
    expect(u.modelMix.m1).toBeCloseTo(0.7);
    expect(u.modelMix.m2).toBeCloseTo(0.3);
    expect(u.firstCallAt).toBe(T0);
    expect(usageInRange(records, T0 + 100 * H, T0 + 101 * H, weights)).toEqual({
      units: 0,
      calls: 0,
      modelMix: {},
    });
  });

  it('projects time to the limit at the rate since the first call (hand calculation)', () => {
    // 1000 units over the 4 hours since the first call -> 250 units/hour.
    // Allotment 5000 -> 4000 left -> 16 hours.
    const v = viewWindow(session, records.slice(0, 3), weights, T0 + 4 * H, 5000);
    expect(v.units).toBe(1000);
    expect(v.ratePerHour).toBeCloseTo(250);
    expect(v.percentOfAllotment).toBeCloseTo(20);
    expect(v.hoursToLimit).toBeCloseTo(16);
    expect(v.start).toBe(new Date(T0).toISOString());
  });

  it('reports usage without a projection when no allotment is known', () => {
    const v = viewWindow(weekly, records.slice(0, 3), weights, T0 + 4 * H);
    expect(v.units).toBe(1000);
    expect(v.impliedAllotment).toBeUndefined();
    expect(v.hoursToLimit).toBeUndefined();
    expect(v.ratePerHour).toBeCloseTo(250);
  });

  it('reports an empty view when no window is open', () => {
    const v = viewWindow(session, records.slice(0, 3), weights, T0 + 40 * H, 100);
    expect(v.units).toBe(0);
    expect(v.start).toBeUndefined();
  });

  it('recordTimes sorts and drops bad timestamps', () => {
    const bad = { ...rec(0, 1), ts: 'nope' };
    expect(recordTimes([rec(2, 1), rec(1, 1), bad])).toEqual([T0 + H, T0 + 2 * H]);
  });
});
