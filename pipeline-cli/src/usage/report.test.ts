import { describe, expect, it } from 'vitest';
import type { ModelCallRecord, PriceRow } from '@ai-sdlc/reference';
import {
  GROUP_KEYS,
  buildContextView,
  buildUsageReport,
  renderContextText,
  renderReportCsv,
  renderReportJson,
  renderReportText,
  type GroupKey,
} from './report.js';
import { deriveUnitWeights } from './units.js';
import type { WindowSpec } from './usage-config.js';

const H = 3_600_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

function price(model: string, input: number): PriceRow {
  return {
    model,
    inputPer1M: input,
    outputPer1M: input * 5,
    cacheReadPer1M: input * 0.1,
    cacheWrite5mPer1M: input * 1.25,
    cacheWrite1hPer1M: input * 2,
    source: 'test',
    url: 'https://example.invalid/prices',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01',
    status: 'active',
  };
}

const PRICES = [price('model-sonnet-a', 2), price('model-opus-a', 10)];
const weights = deriveUnitWeights(PRICES, '2026-09-02T00:00:00Z');
const windowSpec: WindowSpec = { name: 'session', lengthHours: 5, mode: 'first-use' };

function rec(i: number, over: Partial<ModelCallRecord> & { hours?: number } = {}): ModelCallRecord {
  const { hours, ...rest } = over;
  return {
    schemaVersion: 'v1',
    callId: `call-${i}`,
    ts: new Date(T0 + (hours ?? i) * H).toISOString(),
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'model-sonnet-a',
    tokens: {
      input: 100 * (i + 1),
      cacheWrite5m: 10 * i,
      cacheWrite1h: 5 * i,
      cacheRead: 1000 * (i + 1),
      output: 50 * (i + 1),
    },
    billingPool: 'subscription-interactive',
    sessionId: `s${i % 2}`,
    agentRole: i % 2 === 0 ? 'main-session' : 'ai-sdlc:developer',
    scope: 'framework',
    repo: 'repo-a',
    taskId: i % 3 === 0 ? 'TASK-1' : 'TASK-2',
    ...rest,
  };
}

const RECORDS: ModelCallRecord[] = [
  rec(0),
  rec(1, { model: 'model-opus-a', billingPool: 'api-key' }),
  rec(2),
  rec(3, { model: 'model-opus-a' }),
  rec(4, { hours: 30 }),
  rec(5, { hours: 31, billingPool: 'agent-sdk-credit' }),
  rec(6, { hours: 60, taskId: undefined, repo: undefined }),
];

function report(groupBy: GroupKey[], records = RECORDS, extra: Partial<PriceRow>[] = []) {
  void extra;
  return buildUsageReport({ records, groupBy, weights, priceRows: PRICES, windowSpec });
}

describe('buildUsageReport', () => {
  it('prints one row per model with each token class in its own column', () => {
    const r = report(['model']);
    expect(r.rows.map((x) => x.keys.model)).toEqual(['model-opus-a', 'model-sonnet-a']);
    const opus = r.rows[0];
    expect(opus.calls).toBe(2);
    expect(opus.input).toBe(200 + 400);
    expect(opus.cacheWrite5m).toBe(10 + 30);
    expect(opus.cacheWrite1h).toBe(5 + 15);
    expect(opus.cacheRead).toBe(2000 + 4000);
    expect(opus.output).toBe(100 + 200);
  });

  it('JSON and CSV carry the same numbers as the rows', () => {
    const r = report(['model']);
    const json = JSON.parse(renderReportJson(r));
    const csv = renderReportCsv(r).trim().split('\n');
    expect(csv[0]).toBe(
      'model,calls,input,cache_write_5m,cache_write_1h,cache_read,output,units,cost_usd,cost_status',
    );
    r.rows.forEach((row, i) => {
      const cols = csv[i + 1].split(',');
      expect(json.rows[i].model).toBe(cols[0]);
      expect(json.rows[i].calls).toBe(Number(cols[1]));
      expect(json.rows[i].input).toBe(Number(cols[2]));
      expect(json.rows[i].cacheWrite5m).toBe(Number(cols[3]));
      expect(json.rows[i].cacheWrite1h).toBe(Number(cols[4]));
      expect(json.rows[i].cacheRead).toBe(Number(cols[5]));
      expect(json.rows[i].output).toBe(Number(cols[6]));
      expect(json.rows[i].units).toBeCloseTo(Number(cols[7]));
      expect(json.rows[i].costUsd).toBeCloseTo(Number(cols[8]));
      expect(row.calls).toBe(json.rows[i].calls);
    });
    expect(csv[csv.length - 1].startsWith('TOTAL,')).toBe(true);
    expect(json.totals.calls).toBe(RECORDS.length);
  });

  it.each([
    [['role']],
    [['task']],
    [['pool']],
    [['day']],
    [['window']],
    [['repo']],
    [['role', 'task']],
    [['model', 'day', 'pool']],
    [['window', 'role', 'model']],
    [[...GROUP_KEYS]],
  ] as Array<[GroupKey[]]>)('grouping by %j sums to the ungrouped total', (keys) => {
    const grouped = report(keys);
    const total = report([]);
    for (const f of [
      'calls',
      'input',
      'cacheWrite5m',
      'cacheWrite1h',
      'cacheRead',
      'output',
      'units',
      'costUsd',
    ] as const) {
      const sum = grouped.rows.reduce((s, r) => s + r[f], 0);
      expect(sum).toBeCloseTo(total.totals[f], 6);
      expect(grouped.totals[f]).toBeCloseTo(total.totals[f], 6);
    }
    expect(total.rows).toHaveLength(1);
  });

  it('buckets the window grouping by session window', () => {
    const r = report(['window']);
    // Calls at hours 0..3 share one 5h session; hours 30 and 31 another; hour 60 a third.
    expect(r.rows.map((x) => x.calls)).toEqual([4, 2, 1]);
    expect(r.rows[0].keys.window).toBe('session 2026-09-01T00:00Z');
  });

  it('groups missing task and repo under (none)', () => {
    const r = report(['task']);
    expect(r.rows.map((x) => x.keys.task)).toEqual(['(none)', 'TASK-1', 'TASK-2']);
  });

  it('labels an unpriced model and leaves it out of cost totals', () => {
    const records = [rec(0), rec(1, { model: 'model-mystery' })];
    const r = report(['model'], records);
    const mystery = r.rows.find((x) => x.keys.model === 'model-mystery');
    expect(mystery?.costStatus).toBe('unpriced');
    expect(r.totals.costPartial).toBe(true);
    expect(r.unpricedModels).toEqual(['model-mystery']);
    const sonnet = r.rows.find((x) => x.keys.model === 'model-sonnet-a');
    expect(r.totals.costUsd).toBeCloseTo(sonnet?.costUsd ?? -1);

    const text = renderReportText(r);
    expect(text).toContain('unpriced');
    expect(text).toContain('Cost total is partial: model-mystery has no price and is left out.');
    const json = JSON.parse(renderReportJson(r));
    expect(
      json.rows.find((x: { model: string }) => x.model === 'model-mystery').costUsd,
    ).toBeNull();
    expect(json.totals.costPartial).toBe(true);
    expect(renderReportCsv(r)).toContain('model-mystery');
    expect(renderReportCsv(r)).toContain(',unpriced,unpriced');
  });

  it('shows a mixed group as partial rather than unpriced', () => {
    const records = [rec(0), rec(1, { model: 'model-mystery' })];
    const r = report(['pool'], records);
    expect(r.rows[0].costStatus).toBe('partial');
    expect(renderReportText(r)).toContain('(partial)');
  });

  it('states that unit weights are a proxy in text and JSON', () => {
    const r = report(['model']);
    expect(renderReportText(r)).toMatch(/proxy/);
    expect(JSON.parse(renderReportJson(r)).unitsNote).toMatch(/proxy/);
  });

  it('notes models that have no unit weight', () => {
    const r = report([], [rec(0, { model: 'model-mystery' })]);
    expect(r.unweightedModels).toEqual(['model-mystery']);
    expect(renderReportText(r)).toContain('No unit weight for model-mystery');
  });

  it('renders an empty report and ungrouped totals', () => {
    expect(renderReportText(report([], []))).toBe('No usage recorded for this range.\n');
    expect(renderReportText(report([], [rec(0)]))).toContain('calls');
    expect(renderReportCsv(report([], [rec(0)])).split('\n')).toHaveLength(3);
  });

  it('escapes csv values with commas', () => {
    const r = report(['model'], [rec(0, { model: 'a,b"c' })]);
    expect(renderReportCsv(r)).toContain('"a,b""c"');
  });

  it('tolerates a bad timestamp in the day and window groupings', () => {
    const bad = rec(0, { ts: 'not-a-time' });
    const r = report(['day', 'window'], [bad]);
    expect(r.rows[0].keys).toEqual({ day: 'unknown', window: 'unknown' });
  });
});

describe('buildContextView', () => {
  it('lists sessions with first-call tokens, turns and cache read, largest first', () => {
    const rows = buildContextView(RECORDS);
    expect(rows[0].totalCacheRead).toBeGreaterThanOrEqual(rows[rows.length - 1].totalCacheRead);
    const s0 = rows.find((r) => r.session === 's0');
    // Earliest s0 call is rec(0): input 100 + write 0 + write 0 + cache read 1000.
    expect(s0?.firstCallTokens).toBe(1100);
    expect(s0?.turns).toBe(4);
    expect(s0?.agent).toBe('main-session');
  });

  it('shows no path for other-scope sessions, even if a record carried one', () => {
    const other = rec(0, {
      scope: 'other',
      source: { file: '/home/someone/private/transcript.jsonl', offset: 0 },
      sessionId: 'sx',
    });
    const fw = rec(1, {
      source: { file: '/repo/transcripts/t.jsonl', offset: 0 },
      sessionId: 'sy',
    });
    const rows = buildContextView([other, fw]);
    const o = rows.find((r) => r.session === 'sx');
    expect(o?.scope).toBe('other');
    expect(o?.path).toBeUndefined();
    expect(rows.find((r) => r.session === 'sy')?.path).toBe('/repo/transcripts/t.jsonl');
    const text = renderContextText(rows);
    expect(text).not.toContain('/home/someone');
    expect(text).toContain('/repo/transcripts/t.jsonl');
  });

  it('separates subagents of one session and handles an empty ledger', () => {
    const rows = buildContextView([
      rec(0, { agentId: 'a1' }),
      rec(1, { agentId: 'a2', sessionId: 's0' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(renderContextText([])).toBe('No sessions recorded for this range.\n');
  });
});
