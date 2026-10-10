import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceCall, selectPriceRow } from './prices.js';
import { SEED_FETCHED_AT, SEED_PRICES, SEED_URL } from './prices-seed.js';
import { UNPRICED } from './types.js';

interface SnapshotModel {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  releaseDate: string;
  rule: string;
}
interface Snapshot {
  readOn: string;
  priceUrl: string;
  models: Record<string, SnapshotModel>;
}

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  readFileSync(join(here, '__fixtures__', 'published-prices.json'), 'utf-8'),
) as Snapshot;

describe('seed prices against the checked-in published list', () => {
  it('lists exactly the models in the snapshot', () => {
    expect(SEED_PRICES.map((r) => r.model).sort()).toEqual(Object.keys(snapshot.models).sort());
  });

  it.each(SEED_PRICES.map((r) => [r.model, r] as const))(
    '%s matches the snapshot',
    (model, row) => {
      const pub = snapshot.models[model];
      expect(pub).toBeDefined();
      expect({
        input: row.inputPer1M,
        cacheWrite5m: row.cacheWrite5mPer1M,
        cacheWrite1h: row.cacheWrite1hPer1M,
        cacheRead: row.cacheReadPer1M,
        output: row.outputPer1M,
      }).toEqual({
        input: pub.input,
        cacheWrite5m: pub.cacheWrite5m,
        cacheWrite1h: pub.cacheWrite1h,
        cacheRead: pub.cacheRead,
        output: pub.output,
      });
      expect(row.effectiveFrom).toBe(pub.releaseDate);
      expect(row.source).toContain(snapshot.readOn);
      expect(row.source).toContain(pub.rule);
      expect(row.url).toBe(snapshot.priceUrl);
    },
  );

  it('records the read date and list URL', () => {
    expect(SEED_FETCHED_AT.slice(0, 10)).toBe(snapshot.readOn);
    expect(SEED_URL).toBe(snapshot.priceUrl);
  });

  it('has no row effective from the epoch', () => {
    for (const r of SEED_PRICES) expect(r.effectiveFrom).not.toMatch(/^1970-/);
  });

  it('leaves a call dated before the model release unpriced', () => {
    const tokens = { input: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1000 };
    const before = { model: 'claude-opus-5-5', ts: '2026-09-21T23:59:59.000Z', tokens };
    const after = { model: 'claude-opus-5-5', ts: '2026-09-22T00:00:00.000Z', tokens };
    expect(selectPriceRow(SEED_PRICES, before.model, before.ts)).toBeUndefined();
    expect(priceCall(before, { rows: SEED_PRICES })).toBe(UNPRICED);
    // 1000 * $4 + 1000 * $20 per million tokens
    expect(priceCall(after, { rows: SEED_PRICES })).toBeCloseTo(0.024, 10);
  });
});
