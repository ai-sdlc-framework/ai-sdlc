import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelCallRecord } from '@ai-sdlc/reference';
import {
  SNAPSHOTS_FILE,
  appendSnapshot,
  buildAllotmentSeries,
  latestAllotments,
  modelMixOverlap,
  readLimitObservations,
  readSnapshots,
  snapshotsFromObservations,
  type Snapshot,
} from './snapshots.js';
import { deriveUnitWeights } from './units.js';
import type { WindowSpec } from './usage-config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-snap-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rules = { allotmentTolerance: 0.25, modelMixSimilarity: 0.8 };
const weights = deriveUnitWeights([], '2026-09-01T00:00:00Z');

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    ts: '2026-09-01T00:00:00.000Z',
    window: 'weekly',
    usedPercent: 10,
    units: 1000,
    source: 'manual',
    modelMix: { m1: 1 },
    ...over,
  };
}

describe('implied allotment', () => {
  it('equals units divided by the fraction used', () => {
    const rows = buildAllotmentSeries([snap({ units: 4200, usedPercent: 42 })], rules);
    expect(rows).toHaveLength(1);
    expect(rows[0].impliedAllotment).toBeCloseTo(10000);
    expect(rows[0].suspected).toBe(false);
  });

  it('flags a shift beyond the tolerance when the model mix is similar', () => {
    const rows = buildAllotmentSeries(
      [
        snap({ ts: '2026-09-01T00:00:00Z', units: 1000, usedPercent: 10 }),
        snap({ ts: '2026-09-08T00:00:00Z', units: 1000, usedPercent: 20 }),
      ],
      rules,
    );
    expect(rows[1].impliedAllotment).toBeCloseTo(5000);
    expect(rows[1].changeRatio).toBeCloseTo(-0.5);
    expect(rows[1].suspected).toBe(true);
    expect(rows[1].previousAllotment).toBeCloseTo(10000);
  });

  it('does not flag a shift within the tolerance', () => {
    const rows = buildAllotmentSeries(
      [
        snap({ ts: '2026-09-01T00:00:00Z', units: 1000, usedPercent: 10 }),
        snap({ ts: '2026-09-08T00:00:00Z', units: 1100, usedPercent: 10 }),
      ],
      rules,
    );
    expect(rows[1].changeRatio).toBeCloseTo(0.1);
    expect(rows[1].suspected).toBe(false);
  });

  it('does not flag a shift when the model mix differs', () => {
    const rows = buildAllotmentSeries(
      [
        snap({ ts: '2026-09-01T00:00:00Z', units: 1000, usedPercent: 10, modelMix: { a: 1 } }),
        snap({ ts: '2026-09-08T00:00:00Z', units: 1000, usedPercent: 20, modelMix: { b: 1 } }),
      ],
      rules,
    );
    expect(rows[1].mixOverlap).toBe(0);
    expect(rows[1].suspected).toBe(false);
  });

  it('compares only snapshots of the same window, oldest first', () => {
    const rows = buildAllotmentSeries(
      [
        snap({ ts: '2026-09-08T00:00:00Z', window: 'weekly', units: 1000, usedPercent: 20 }),
        snap({ ts: '2026-09-02T00:00:00Z', window: 'session', units: 50, usedPercent: 50 }),
        snap({ ts: '2026-09-01T00:00:00Z', window: 'weekly', units: 1000, usedPercent: 10 }),
        snap({ ts: '2026-09-03T00:00:00Z', window: 'weekly', units: 0, usedPercent: 10 }),
      ],
      rules,
    );
    expect(rows.map((r) => `${r.window}@${r.ts.slice(0, 10)}`)).toEqual([
      'session@2026-09-02',
      'weekly@2026-09-01',
      'weekly@2026-09-08',
    ]);
    expect(rows[0].suspected).toBe(false);
    expect(latestAllotments(rows).get('weekly')).toBeCloseTo(5000);
    expect(latestAllotments(rows).get('session')).toBeCloseTo(100);
  });

  it('model mix overlap is 1 for identical mixes', () => {
    expect(modelMixOverlap({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 })).toBeCloseTo(1);
    expect(modelMixOverlap({ a: 1 }, { b: 1 })).toBe(0);
  });
});

describe('snapshot store', () => {
  it('appends and reads back a calibration point', () => {
    appendSnapshot(snap({ usedPercent: 42 }), { dir });
    expect(readSnapshots({ dir })).toEqual([snap({ usedPercent: 42 })]);
  });

  it('rejects a percentage outside (0, 100]', () => {
    expect(() => appendSnapshot(snap({ usedPercent: 0 }), { dir })).toThrow(/greater than 0/);
    expect(() => appendSnapshot(snap({ usedPercent: 101 }), { dir })).toThrow();
  });

  it('skips corrupt and malformed lines and reads nothing when absent', () => {
    expect(readSnapshots({ dir })).toEqual([]);
    writeFileSync(
      join(dir, SNAPSHOTS_FILE),
      `not json\n${JSON.stringify({ ts: 'x' })}\n${JSON.stringify(snap({}))}\n\n`,
    );
    expect(readSnapshots({ dir })).toHaveLength(1);
  });

  it('stores counts and ids only', () => {
    appendSnapshot(snap({}), { dir });
    const keys = Object.keys(JSON.parse(readFileSync(join(dir, SNAPSHOTS_FILE), 'utf-8')));
    expect(keys.sort()).toEqual(['modelMix', 'source', 'ts', 'units', 'usedPercent', 'window']);
  });
});

describe('limit observations as snapshots', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z');
  function call(hours: number, input: number): ModelCallRecord {
    return {
      schemaVersion: 'v1',
      callId: `c${hours}`,
      ts: new Date(T0 + hours * 3_600_000).toISOString(),
      harness: 'codex',
      provider: 'openai',
      model: 'm1',
      tokens: { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
      billingPool: 'codex-plan',
      sessionId: 's',
      agentRole: 'main-session',
      scope: 'framework',
    };
  }
  const records = [call(0, 100), call(1, 200), call(30, 400)];

  it('reads only valid observations from the limit-event log', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'limit-events.jsonl'),
      [
        { ts: '2026-09-01T02:00:00Z', sessionId: 's', category: 'rate-limit' },
        {
          ts: '2026-09-01T02:00:00Z',
          window: 'primary',
          usedPercent: 25,
          windowMinutes: 300,
          resetsAt: '2026-09-01T05:00:00Z',
        },
        { ts: '2026-09-01T02:00:00Z', window: 'secondary', usedPercent: 0 },
        { ts: 'bad', window: 'primary', usedPercent: 10 },
        'garbage',
      ]
        .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
        .join('\n'),
    );
    const obs = readLimitObservations({ dir });
    expect(obs).toEqual([
      {
        ts: '2026-09-01T02:00:00Z',
        window: 'primary',
        usedPercent: 25,
        windowMinutes: 300,
        resetsAt: '2026-09-01T05:00:00Z',
      },
    ]);
    expect(readLimitObservations({ dir: join(dir, 'missing') })).toEqual([]);
  });

  it('bounds the window by its reported length and reset time', () => {
    const snaps = snapshotsFromObservations(
      [
        {
          ts: new Date(T0 + 2 * 3_600_000).toISOString(),
          window: 'primary',
          usedPercent: 50,
          windowMinutes: 300,
          resetsAt: new Date(T0 + 4 * 3_600_000).toISOString(),
        },
      ],
      records,
      [],
      weights,
    );
    // Window starts at reset minus 300 minutes = T0 - 1h, ends at T0 + 2h: 300 units.
    expect(snaps).toHaveLength(1);
    expect(snaps[0].units).toBe(300);
    expect(snaps[0].source).toBe('harness');
    expect(buildAllotmentSeries(snaps, rules)[0].impliedAllotment).toBeCloseTo(600);
  });

  it('uses the configured window when the observation has no length, and skips unknown windows', () => {
    const windows: WindowSpec[] = [{ name: 'weekly', lengthHours: 168, mode: 'trailing' }];
    const at = new Date(T0 + 31 * 3_600_000).toISOString();
    const snaps = snapshotsFromObservations(
      [
        { ts: at, window: 'weekly', usedPercent: 10 },
        { ts: at, window: 'mystery', usedPercent: 10 },
      ],
      records,
      windows,
      weights,
    );
    expect(snaps).toHaveLength(1);
    expect(snaps[0].units).toBe(700);
  });

  it('falls back to now minus the length when no reset time is given', () => {
    const snaps = snapshotsFromObservations(
      [
        {
          ts: new Date(T0 + 31 * 3_600_000).toISOString(),
          window: 'primary',
          usedPercent: 10,
          windowMinutes: 60 * 24,
        },
      ],
      records,
      [],
      weights,
    );
    expect(snaps[0].units).toBe(400);
  });
});
