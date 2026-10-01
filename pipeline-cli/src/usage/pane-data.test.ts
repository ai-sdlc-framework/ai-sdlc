import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendModelCalls, type ModelCallRecord } from '@ai-sdlc/reference';
import { loadUsagePaneData, pickConsumerWindow } from './pane-data.js';
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

describe('loadUsagePaneData', () => {
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
