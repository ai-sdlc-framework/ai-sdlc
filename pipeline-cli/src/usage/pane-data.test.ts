import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendModelCalls, ledgerFileForTs, type ModelCallRecord } from '@ai-sdlc/reference';
import { loadUsagePaneData, pickConsumerWindow, top } from './pane-data.js';
import type { ReportRow } from './report.js';
import { LIMIT_EVENTS_FILE, SNAPSHOTS_FILE } from './snapshots.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-pane-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function call(n: number, over: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    schemaVersion: 'v1',
    callId: `c${n}`,
    ts: new Date(NOW.getTime() - n * 60_000).toISOString(),
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-x',
    tokens: { input: 100, cacheWrite5m: 10, cacheWrite1h: 5, cacheRead: 1000, output: 50 },
    billingPool: 'subscription-interactive',
    sessionId: 's1',
    agentRole: 'ai-sdlc:developer',
    scope: 'framework',
    repo: 'r',
    taskId: 'T-1',
    ...over,
  };
}

const load = (extra = {}) =>
  loadUsagePaneData({ usageDir: dir, now: () => NOW, priceRows: [], ...extra });

describe('loadUsagePaneData', { timeout: 15_000 }, () => {
  it('reports an empty ledger', async () => {
    const d = await load();
    expect(d.empty).toBe(true);
    expect(d.topByRole).toEqual([]);
  });

  it('builds windows, top consumers, the last limit event and an allotment change', async () => {
    const recs = [
      call(1),
      call(2, { model: 'claude-opus-y', agentRole: 'main-session' }),
      ...Array.from({ length: 6 }, (_, i) => call(10 + i, { agentRole: `role-${i}` })),
    ];
    appendModelCalls(recs, { dir });
    const snap = (ts: string, usedPercent: number, units: number) =>
      JSON.stringify({
        ts,
        window: 'weekly',
        usedPercent,
        units,
        source: 'manual',
        modelMix: { 'claude-sonnet-x': 1 },
      });
    writeFileSync(
      join(dir, SNAPSHOTS_FILE),
      `${snap('2026-09-09T00:00:00.000Z', 10, 1000)}\n${snap('2026-09-10T00:00:00.000Z', 10, 3000)}\n`,
    );
    writeFileSync(
      join(dir, LIMIT_EVENTS_FILE),
      `${JSON.stringify({ ts: '2026-09-08T00:00:00.000Z', window: 'weekly', usedPercent: 50 })}\n` +
        `${JSON.stringify({ ts: '2026-09-09T06:00:00.000Z', window: 'session', usedPercent: 20 })}\n`,
    );
    const d = await load();
    expect(d.empty).toBe(false);
    expect(d.windows.map((w) => w.window)).toEqual(['session', 'weekly']);
    expect(d.windows[1].impliedAllotment).toBeGreaterThan(0);
    expect(d.consumerWindow).toBe('weekly');
    expect(d.topByRole).toHaveLength(5);
    expect(d.topByModel.map((r) => r.keys.model)).toContain('claude-opus-y');
    expect(d.lastLimitEvent?.window).toBe('session');
    expect(d.allotmentChange?.suspected).toBe(true);
  });

  it('uses an injected record reader and config', async () => {
    const d = await loadUsagePaneData({
      now: () => NOW,
      priceRows: [],
      usageDir: dir,
      readRecords: async () => [call(1)],
      loadConfig: () => ({
        windows: [{ name: 'only', lengthHours: 24, mode: 'trailing' }],
        weights: { tokenClasses: {}, modelFamilies: {} },
        allotmentTolerance: 0.25,
        modelMixSimilarity: 0.8,
        source: 'defaults',
        warnings: [],
      }),
    });
    expect(d.consumerWindow).toBe('only');
    expect(d.topByRole[0].keys.role).toBe('ai-sdlc:developer');
  });

  it('picks the weekly window, else the longest, else none', () => {
    const w = (name: string, lengthHours: number) => ({
      name,
      lengthHours,
      mode: 'trailing' as const,
    });
    expect(pickConsumerWindow([w('a', 5), w('weekly', 168), w('z', 900)])?.name).toBe('weekly');
    expect(pickConsumerWindow([w('a', 5), w('z', 900)])?.name).toBe('z');
    expect(pickConsumerWindow([])).toBeUndefined();
  });
});

describe('bounded ledger read', { timeout: 15_000 }, () => {
  const HOUR = 3_600_000;
  const at = (
    hoursAgo: number,
    over: Partial<ModelCallRecord> = {},
    n = Math.round(hoursAgo * 100),
  ) =>
    call(0, {
      callId: `b${n}-${over.model ?? ''}`,
      ts: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
      ...over,
    });

  async function same(records: ModelCallRecord[]): Promise<void> {
    appendModelCalls(records, { dir });
    const bounded = await load();
    const full = await load({ readRecords: async () => records });
    expect(bounded).toEqual(full);
  }

  it('matches a full read when old records lie outside every window', async () => {
    await same([at(24 * 40), at(24 * 39), at(24 * 20), at(3), at(1, { model: 'm2' })]);
  });

  it('matches a full read when a first-use chain began long before the lookback', async () => {
    // A call every hour for 60 hours keeps one session chain going across the lookback.
    await same(Array.from({ length: 60 }, (_, i) => at(i + 0.5)));
  });

  it('matches a full read when a limit observation refers to an older window', async () => {
    writeFileSync(
      join(dir, LIMIT_EVENTS_FILE),
      `${JSON.stringify({ ts: new Date(NOW.getTime() - 24 * 12 * HOUR).toISOString(), window: 'weekly', usedPercent: 40 })}\n`,
    );
    await same([at(24 * 14), at(24 * 13), at(24 * 12.5), at(24 * 12.2), at(2)]);
  });

  it('is not empty when every record is older than the lookback', async () => {
    appendModelCalls([at(24 * 90)], { dir });
    const d = await load();
    expect(d.empty).toBe(false);
    expect(d.topByRole).toEqual([]);
  });
});

describe('top consumers ordering and robustness', { timeout: 15_000 }, () => {
  const row = (role: string, units: number): ReportRow => ({
    keys: { role },
    calls: 1,
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    units,
    costUsd: 0,
    costStatus: 'unpriced',
  });

  it('orders by units descending with a name tiebreak and keeps five', () => {
    const rows = [
      row('b', 5),
      row('a', 5),
      row('z', 9),
      row('c', 1),
      row('d', 2),
      row('e', 3),
      row('f', 0),
    ];
    expect(top(rows).map((r) => r.keys.role)).toEqual(['z', 'a', 'b', 'e', 'd']);
  });

  it('rejects when the real reader meets a non-object ledger line', async () => {
    appendModelCalls([call(1)], { dir });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, ledgerFileForTs(call(1).ts)), 'null\n');
    await expect(load()).rejects.toBeInstanceOf(Error);
  });
});
