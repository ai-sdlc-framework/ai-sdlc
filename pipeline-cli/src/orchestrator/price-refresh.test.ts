import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PriceSource, SourcePriceRow } from '@ai-sdlc/reference';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitPriceChanges, runDailyPriceRefresh } from './price-refresh.js';

const DAY1 = new Date('2026-10-01T03:00:00.000Z');
const DAY1_LATER = new Date('2026-10-01T23:30:00.000Z');
const DAY2 = new Date('2026-10-02T00:30:00.000Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'price-refresh-tick-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(inputPer1M: number): SourcePriceRow {
  return {
    model: 'claude-haiku-4-5',
    inputPer1M,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheWrite5mPer1M: 1.25,
    cacheWrite1hPer1M: 2,
    url: 'https://example.test/p',
    fetchedAt: DAY1.toISOString(),
  };
}

function src(rows: SourcePriceRow[]): PriceSource {
  return { name: 'fake', fetchPrices: vi.fn(async () => rows) };
}

describe('runDailyPriceRefresh', () => {
  it('runs once per calendar day and emits ModelPriceChanged for a change', async () => {
    const emit = vi.fn();
    const source = src([row(1.2)]);
    const base = { usageDir: dir, dir, sources: [source], emit, onCapability: vi.fn() };

    const first = await runDailyPriceRefresh({ ...base, now: () => DAY1 });
    expect(first).not.toBe('skipped');
    expect(emit).toHaveBeenCalledWith({
      type: 'ModelPriceChanged',
      model: 'claude-haiku-4-5',
      tokenClass: 'input',
      oldPrice: 1,
      newPrice: 1.2,
    });

    expect(await runDailyPriceRefresh({ ...base, now: () => DAY1_LATER })).toBe('skipped');
    expect(source.fetchPrices).toHaveBeenCalledTimes(1);

    expect(await runDailyPriceRefresh({ ...base, now: () => DAY2 })).not.toBe('skipped');
    expect(source.fetchPrices).toHaveBeenCalledTimes(2);
  });

  it('counts a failed attempt so a down source is not retried every tick', async () => {
    const failing: PriceSource = {
      name: 'down',
      fetchPrices: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    const base = { dir, sources: [failing], emit: vi.fn(), onCapability: vi.fn() };
    const first = await runDailyPriceRefresh({ ...base, now: () => DAY1 });
    expect(first).toMatchObject({ anySourceSucceeded: false });
    expect(await runDailyPriceRefresh({ ...base, now: () => DAY1_LATER })).toBe('skipped');
  });

  it('never throws into the tick', async () => {
    const result = await runDailyPriceRefresh({
      dir,
      sources: [],
      emit: vi.fn(),
      now: () => {
        throw new Error('clock broke');
      },
    });
    expect(result).toBe('error');
  });

  it('uses the shipped sources over the injected fetch and reports the capability', async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const prev = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = dir;
    try {
      const result = await runDailyPriceRefresh({
        dir,
        fetch: fetchFn,
        emit: vi.fn(),
        now: () => DAY1,
      });
      expect(result).toMatchObject({ anySourceSucceeded: false });
    } finally {
      if (prev === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = prev;
    }
    expect(calls).toHaveLength(2);
    const state = JSON.parse(readFileSync(join(dir, '_capabilities', 'state.json'), 'utf-8'));
    expect(state.capabilities['pricing.feed'].lastOutcome).toBe('degraded');
  });
});

describe('emitPriceChanges', () => {
  it('emits one event per changed class', () => {
    const emit = vi.fn();
    emitPriceChanges(
      [
        { model: 'm', tokenClass: 'input', oldPrice: 1, newPrice: 2 },
        { model: 'm', tokenClass: 'output', oldPrice: 5, newPrice: 6 },
      ],
      emit,
    );
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
