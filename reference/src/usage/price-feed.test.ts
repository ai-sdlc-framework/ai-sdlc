import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCapability } from '../capabilities/index.js';
import {
  confirmHeldPrice,
  defaultPriceSources,
  isPriceStale,
  listPrices,
  readPriceFeedState,
  refreshPrices,
  setManualPrice,
} from './price-feed.js';
import { createLiteLlmSource, LITELLM_URL } from './price-source-litellm.js';
import { createOpenRouterSource, OPENROUTER_URL } from './price-source-openrouter.js';
import {
  perTokenToPer1M,
  sourceRowProblem,
  type PriceSource,
  type SourcePriceRow,
} from './price-source.js';
import { appendFetchedPriceRows, priceCall, readPriceHistory } from './prices.js';
import type { PriceRow } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, '__fixtures__', name), 'utf-8');

const T1 = new Date('2026-10-01T09:00:00.000Z');
const T2 = new Date('2026-10-02T09:00:00.000Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'price-feed-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(bodies: Record<string, string | number>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = bodies[url];
    if (typeof body === 'number') return new Response('nope', { status: body });
    if (body === undefined) throw new Error('network down');
    return new Response(body, { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function srow(model: string, vals: Partial<SourcePriceRow> = {}): SourcePriceRow {
  return {
    model,
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheWrite5mPer1M: 1.25,
    cacheWrite1hPer1M: 2,
    url: 'https://example.test/prices',
    fetchedAt: T1.toISOString(),
    ...vals,
  };
}

function source(name: string, rows: SourcePriceRow[] | Error): PriceSource {
  return {
    name,
    fetchPrices: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
}

describe('pricing.feed capability', () => {
  it('is registered so reports are not flagged unregistered', () => {
    expect(getCapability('pricing.feed')?.specifiedBy).toBe('RFC-0050');
  });
});

describe('perTokenToPer1M', () => {
  it('scales per-token strings and numbers without binary noise', () => {
    expect(perTokenToPer1M('0.000002')).toBe(2);
    expect(perTokenToPer1M(1e-7)).toBe(0.1);
    expect(perTokenToPer1M(undefined)).toBeUndefined();
    expect(perTokenToPer1M(null)).toBeUndefined();
  });

  it('turns unparsable values into NaN rather than treating them as unpublished', () => {
    expect(perTokenToPer1M('abc')).toBeNaN();
    expect(perTokenToPer1M('')).toBeNaN();
    expect(perTokenToPer1M({})).toBeNaN();
    expect(perTokenToPer1M(Infinity)).toBeNaN();
  });
});

describe('sourceRowProblem', () => {
  it('accepts unpublished classes and rejects zero, negative, NaN and bad metadata', () => {
    expect(sourceRowProblem(srow('m', { cacheWrite1hPer1M: undefined }))).toBeUndefined();
    expect(sourceRowProblem(srow('m', { inputPer1M: 0 }))).toMatch(/input/);
    expect(sourceRowProblem(srow('m', { outputPer1M: -1 }))).toMatch(/output/);
    expect(sourceRowProblem(srow('m', { cacheReadPer1M: Number.NaN }))).toMatch(/cacheRead/);
    expect(sourceRowProblem(srow('', {}))).toMatch(/model/);
    expect(sourceRowProblem(srow('m', { fetchedAt: 'x' }))).toMatch(/fetch time/);
  });
});

describe('OpenRouter adapter', () => {
  it('turns the recorded fixture into per-million rows keyed by ledger model id', async () => {
    const { fn } = fakeFetch({ [OPENROUTER_URL]: fixture('openrouter-models.json') });
    const rows = await createOpenRouterSource({ fetch: fn, now: () => T1 }).fetchPrices();
    const byModel = new Map(rows.map((r) => [r.model, r]));
    // claude-haiku-4-5 and its dated id share one source entry
    expect(byModel.get('claude-haiku-4-5')).toMatchObject({
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: 0.1,
      cacheWrite5mPer1M: 1.25,
      cacheWrite1hPer1M: 2,
      url: OPENROUTER_URL,
      fetchedAt: T1.toISOString(),
    });
    expect(byModel.get('claude-haiku-4-5-20251001')?.inputPer1M).toBe(1);
    expect(byModel.get('claude-opus-4-1-20250805')?.inputPer1M).toBe(15);
    // 1h write not published: undefined, not zero
    expect(byModel.get('claude-sonnet-4-6')?.cacheWrite1hPer1M).toBeUndefined();
    expect(byModel.get('claude-sonnet-4-6')?.cacheWrite5mPer1M).toBe(3.75);
    // a published zero is carried so the refresh can reject it
    expect(byModel.get('claude-opus-5')?.inputPer1M).toBe(0);
    // batch variant, unlisted model and entry without pricing are never used
    expect(rows.map((r) => r.model)).not.toContain('vendor/unlisted-model');
    expect(byModel.has('claude-opus-4-8')).toBe(false);
  });

  it('fails on a bad status or response shape', async () => {
    const bad = fakeFetch({ [OPENROUTER_URL]: 503 });
    await expect(createOpenRouterSource({ fetch: bad.fn }).fetchPrices()).rejects.toThrow(
      /HTTP 503/,
    );
    const shape = fakeFetch({ [OPENROUTER_URL]: '{"data":"x"}' });
    await expect(createOpenRouterSource({ fetch: shape.fn }).fetchPrices()).rejects.toThrow(
      /unexpected/,
    );
  });
});

describe('LiteLLM adapter', () => {
  it('turns the recorded fixture into per-million rows keyed by ledger model id', async () => {
    const { fn } = fakeFetch({ [LITELLM_URL]: fixture('litellm-prices.json') });
    const rows = await createLiteLlmSource({ fetch: fn, now: () => T1 }).fetchPrices();
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.get('claude-haiku-4-5')).toMatchObject({
      inputPer1M: 1,
      outputPer1M: 5,
      cacheReadPer1M: 0.1,
      cacheWrite5mPer1M: 1.25,
      cacheWrite1hPer1M: 2,
      url: LITELLM_URL,
    });
    expect(byModel.get('claude-sonnet-5')?.cacheWrite1hPer1M).toBeUndefined();
    expect(byModel.get('claude-opus-4-8')?.inputPer1M).toBeNaN();
    expect(byModel.has('claude-3-haiku-20240307')).toBe(false);
  });

  it('fails on a non-object body', async () => {
    const { fn } = fakeFetch({ [LITELLM_URL]: '[]' });
    await expect(createLiteLlmSource({ fetch: fn }).fetchPrices()).rejects.toThrow(/unexpected/);
  });
});

describe('adapter requests carry no repository data', () => {
  it('sends a bare GET to a fixed public URL', async () => {
    const { fn, calls } = fakeFetch({
      [OPENROUTER_URL]: fixture('openrouter-models.json'),
      [LITELLM_URL]: fixture('litellm-prices.json'),
    });
    // Put recognisable repo / task / token data in the process context.
    const prevCwd = process.cwd();
    process.env.AI_SDLC_ACTIVE_TASK_ID = 'AISDLC-659';
    try {
      for (const s of defaultPriceSources({ fetch: fn, now: () => T1 })) await s.fetchPrices();
    } finally {
      delete process.env.AI_SDLC_ACTIVE_TASK_ID;
    }
    expect(calls.map((c) => c.url).sort()).toEqual([LITELLM_URL, OPENROUTER_URL].sort());
    for (const c of calls) {
      const recorded = JSON.stringify({
        url: c.url,
        method: c.init?.method,
        headers: c.init?.headers,
      });
      expect(c.init?.method).toBe('GET');
      expect(c.init?.body).toBeUndefined();
      expect(new URL(c.url).search).toBe('');
      expect(recorded).not.toContain('AISDLC');
      expect(recorded).not.toContain('ai-sdlc-framework');
      expect(recorded).not.toContain(prevCwd);
      expect(recorded).not.toMatch(/token/i);
    }
  });
});

describe('refreshPrices', () => {
  it('appends nothing when prices are unchanged against the seed', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [source('a', [srow('claude-haiku-4-5')])],
    });
    expect(res.unchanged).toBe(1);
    expect(res.appended).toBe(0);
    expect(res.changes).toEqual([]);
    expect(existsSync(join(dir, 'prices.jsonl'))).toBe(false);
  });

  it('appends one row for a changed price, dated to the fetch, and prices calls around it', async () => {
    const rows = [srow('claude-haiku-4-5', { inputPer1M: 1.2 })];
    const res = await refreshPrices({ dir, now: () => T1, sources: [source('a', rows)] });
    expect(res.appended).toBe(1);
    expect(res.changes).toEqual([
      { model: 'claude-haiku-4-5', tokenClass: 'input', oldPrice: 1, newPrice: 1.2 },
    ]);
    const written = readPriceHistory({ dir }).filter((r) => r.source === 'a');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ effectiveFrom: '2026-10-01', status: 'active' });

    const tokens = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
    const before = priceCall(
      { model: 'claude-haiku-4-5', ts: '2026-09-30T12:00:00Z', tokens },
      { dir },
    );
    const after = priceCall(
      { model: 'claude-haiku-4-5', ts: '2026-10-01T12:00:00Z', tokens },
      { dir },
    );
    expect(before).toBe(1);
    expect(after).toBe(1.2);

    // A second refresh with the same prices appends nothing more.
    const again = await refreshPrices({ dir, now: () => T2, sources: [source('a', rows)] });
    expect(again.appended).toBe(0);
    expect(again.unchanged).toBe(1);
  });

  it('prices a brand new model without a change event', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [source('a', [srow('brand-new-model')])],
    });
    expect(res.appended).toBe(1);
    expect(res.changes).toEqual([]);
  });

  it('rejects zero, negative and non-numeric prices before the history', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [
        source('a', [
          srow('m-zero', { inputPer1M: 0 }),
          srow('m-neg', { outputPer1M: -2 }),
          srow('m-nan', { cacheReadPer1M: Number.NaN }),
        ]),
      ],
    });
    expect(res.rejected.map((r) => r.model).sort()).toEqual(['m-nan', 'm-neg', 'm-zero']);
    expect(res.appended).toBe(0);
    expect(readPriceHistory({ dir }).some((r) => r.model.startsWith('m-'))).toBe(false);
  });

  it('merges classes across sources and reports unresolvable models as incomplete', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [
        source('primary', [
          srow('merged', { cacheWrite1hPer1M: undefined }),
          srow('partial', { cacheWrite1hPer1M: undefined }),
        ]),
        source('secondary', [srow('merged', { cacheWrite1hPer1M: 2 })]),
      ],
    });
    expect(res.incomplete).toEqual(['partial']);
    const merged = readPriceHistory({ dir }).find((r) => r.model === 'merged');
    expect(merged?.cacheWrite1hPer1M).toBe(2);
    expect(merged?.source).toBe('primary+secondary');
    expect(readPriceHistory({ dir }).some((r) => r.model === 'partial')).toBe(false);
  });

  it('holds a row when sources disagree beyond the tolerance, and priceCall ignores it', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [
        source('a', [srow('claude-haiku-4-5', { inputPer1M: 1.1 })]),
        source('b', [srow('claude-haiku-4-5', { inputPer1M: 1.3 })]),
      ],
    });
    expect(res.held).toEqual([{ model: 'claude-haiku-4-5', reason: 'sources-disagree' }]);
    expect(res.appended).toBe(0);
    const tokens = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
    expect(
      priceCall({ model: 'claude-haiku-4-5', ts: '2026-10-05T00:00:00Z', tokens }, { dir }),
    ).toBe(1);

    // The same disagreement tomorrow does not pile up another held row.
    await refreshPrices({
      dir,
      now: () => T2,
      sources: [
        source('a', [srow('claude-haiku-4-5', { inputPer1M: 1.1 })]),
        source('b', [srow('claude-haiku-4-5', { inputPer1M: 1.3 })]),
      ],
    });
    expect(readPriceHistory({ dir }).filter((r) => r.status === 'held')).toHaveLength(1);
  });

  it('accepts a disagreement inside the tolerance', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [
        source('a', [srow('claude-haiku-4-5', { inputPer1M: 1.1 })]),
        source('b', [srow('claude-haiku-4-5', { inputPer1M: 1.12 })]),
      ],
    });
    expect(res.held).toEqual([]);
    expect(res.appended).toBe(1);
  });

  it('holds a price that moves beyond the change factor until confirmed', async () => {
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: [source('a', [srow('claude-haiku-4-5', { outputPer1M: 40 })])],
    });
    expect(res.held).toEqual([{ model: 'claude-haiku-4-5', reason: 'change-factor' }]);
    const tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1_000_000 };
    const call = { model: 'claude-haiku-4-5', ts: '2026-10-03T00:00:00Z', tokens };
    expect(priceCall(call, { dir })).toBe(5);

    const entry = listPrices({ dir, now: () => T2 }).find((e) => e.model === 'claude-haiku-4-5');
    expect(entry?.held?.outputPer1M).toBe(40);

    const confirmed = confirmHeldPrice('claude-haiku-4-5', { dir, now: () => T2 });
    expect(confirmed?.changes).toEqual([
      { model: 'claude-haiku-4-5', tokenClass: 'output', oldPrice: 5, newPrice: 40 },
    ]);
    expect(priceCall(call, { dir })).toBe(40);
    expect(
      listPrices({ dir, now: () => T2 }).find((e) => e.model === 'claude-haiku-4-5')?.held,
    ).toBeUndefined();
    expect(confirmHeldPrice('claude-haiku-4-5', { dir })).toBeUndefined();
  });

  it('keeps a manual row ahead of a fetched active row and emits no change for it', async () => {
    setManualPrice(
      'claude-haiku-4-5',
      { input: 9, output: 9, cacheRead: 9, cacheWrite5m: 9, cacheWrite1h: 9 },
      { dir, now: () => T1 },
    );
    const res = await refreshPrices({
      dir,
      now: () => T2,
      sources: [source('a', [srow('claude-haiku-4-5', { inputPer1M: 1.2 })])],
    });
    expect(res.appended).toBe(1);
    expect(res.changes).toEqual([]);
    const tokens = { input: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
    expect(
      priceCall({ model: 'claude-haiku-4-5', ts: '2026-10-03T00:00:00Z', tokens }, { dir }),
    ).toBe(9);
  });

  it('survives every source failing, keeps last prices, and reports degraded', async () => {
    const onCapability = vi.fn();
    const res = await refreshPrices({
      dir,
      now: () => T1,
      onCapability,
      sources: [source('a', new Error('boom\nline')), source('b', new Error('down'))],
    });
    expect(res.anySourceSucceeded).toBe(false);
    expect(res.sources.map((s) => s.ok)).toEqual([false, false]);
    expect(res.sources[0].error).toBe('boom line');
    expect(onCapability).toHaveBeenCalledWith('degraded', expect.stringContaining('failed'));
    expect(readPriceFeedState({ dir }).lastError).toContain('a: boom line');
    expect(readPriceHistory({ dir }).length).toBeGreaterThan(0);
  });

  it('reports live after a successful refresh and records the state', async () => {
    const onCapability = vi.fn();
    await refreshPrices({
      dir,
      now: () => T1,
      onCapability,
      sources: [source('a', [srow('claude-haiku-4-5')]), source('b', new Error('x'))],
    });
    expect(onCapability).toHaveBeenCalledWith('live');
    expect(readPriceFeedState({ dir })).toEqual({
      lastAttemptAt: T1.toISOString(),
      lastSuccessAt: T1.toISOString(),
    });
  });

  it('never lets a capability reporter failure escape', async () => {
    await expect(
      refreshPrices({
        dir,
        now: () => T1,
        onCapability: () => {
          throw new Error('registry down');
        },
        sources: [source('a', [srow('claude-haiku-4-5')])],
      }),
    ).resolves.toBeDefined();
  });

  it('works with the shipped adapters end to end over recorded fixtures', async () => {
    const { fn } = fakeFetch({
      [OPENROUTER_URL]: fixture('openrouter-models.json'),
      [LITELLM_URL]: fixture('litellm-prices.json'),
    });
    const res = await refreshPrices({
      dir,
      now: () => T1,
      sources: defaultPriceSources({ fetch: fn, now: () => T1 }),
    });
    expect(res.anySourceSucceeded).toBe(true);
    // opus-5 has a zero price at OpenRouter: rejected there
    expect(res.rejected.some((r) => r.model === 'claude-opus-5')).toBe(true);
    // sonnet-4-6 gets its 1h class from LiteLLM and so matches the seed
    expect(res.unchanged).toBeGreaterThanOrEqual(2);
    expect(res.incomplete).toContain('claude-sonnet-5');
  });
});

describe('setManualPrice', () => {
  it('rejects non-positive prices and bad dates', () => {
    const ok = { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 };
    expect(() => setManualPrice('m', { ...ok, input: 0 }, { dir })).toThrow(/input/);
    expect(() => setManualPrice('', ok, { dir })).toThrow(/model/);
    expect(() => setManualPrice('m', ok, { dir, effectiveFrom: 'nope' })).toThrow(/date/);
  });

  it('writes a manual row', () => {
    const row = setManualPrice(
      'm',
      { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5 },
      { dir, now: () => T1, effectiveFrom: '2026-10-01' },
    );
    expect(row.status).toBe('manual');
    expect(readPriceHistory({ dir }).find((r) => r.model === 'm')?.cacheWrite1hPer1M).toBe(5);
  });
});

describe('staleness and listing', () => {
  it('labels prices stale once the last successful refresh is past the limit', async () => {
    await refreshPrices({ dir, now: () => T1, sources: [source('a', [srow('claude-haiku-4-5')])] });
    const fresh = new Date('2026-10-10T00:00:00Z');
    const old = new Date('2026-10-20T00:00:00Z');
    const find = (now: Date) =>
      listPrices({ dir, now: () => now }).find((e) => e.model === 'claude-haiku-4-5');
    expect(find(fresh)?.stale).toBe(false);
    expect(find(old)?.stale).toBe(true);
    expect(find(old)?.ageDays).toBeGreaterThanOrEqual(19);
    expect(listPrices({ dir, now: () => old, staleAfterDays: 30 })[0].stale).toBe(false);
  });

  it('never marks a manual row stale and falls back to row age without state', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    const row = readPriceHistory({ dir })[0];
    expect(isPriceStale(row, now, {})).toBe(true);
    expect(isPriceStale({ ...row, status: 'manual' }, now, {})).toBe(false);
    expect(isPriceStale(row, now, { lastSuccessAt: '2026-12-31T00:00:00Z' })).toBe(false);
  });

  it('lists a model that only has a held row without an active price', () => {
    const held: PriceRow = {
      ...(readPriceHistory({ dir })[0] as PriceRow),
      model: 'only-held',
      status: 'held',
      effectiveFrom: '2026-10-01',
      fetchedAt: T1.toISOString(),
    };
    appendFetchedPriceRows([held], { dir });
    const e = listPrices({ dir, now: () => T2 }).find((x) => x.model === 'only-held');
    expect(e?.active).toBeUndefined();
    expect(e?.held).toBeDefined();
  });

  it('treats a corrupt state file as empty', () => {
    writeFileSync(join(dir, 'price-feed-state.json'), 'not json');
    expect(readPriceFeedState({ dir })).toEqual({});
    writeFileSync(join(dir, 'price-feed-state.json'), '3');
    expect(readPriceFeedState({ dir })).toEqual({});
  });
});
