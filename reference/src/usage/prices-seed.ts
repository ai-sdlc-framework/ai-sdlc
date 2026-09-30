/**
 * Seed price rows shipped in code. Values are Anthropic's published list prices
 * (per million tokens) read on {@link SEED_FETCHED_AT}. A model that is not
 * listed here has no seed row and is reported as unpriced, never priced as
 * another model. Newer observed prices are appended to `prices.jsonl` and
 * supersede these from their own `effectiveFrom` date.
 *
 * Seed rows apply from the epoch: the published list is the only baseline the
 * ledger has, so earlier calls are priced at it until a later row says otherwise.
 */

import type { PriceRow } from './types.js';

export const SEED_FETCHED_AT = '2026-09-30T00:00:00.000Z';
export const SEED_SOURCE = 'anthropic-published-price-list';
export const SEED_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

/** [model, input, cache write 5m, cache write 1h, cache read, output] per million tokens. */
const SEED: ReadonlyArray<readonly [string, number, number, number, number, number]> = [
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-7', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-6', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-5-20251101', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-1-20250805', 15, 18.75, 30, 1.5, 75],
  ['claude-opus-4-20250514', 15, 18.75, 30, 1.5, 75],
  ['claude-sonnet-5-5', 2, 2.5, 4, 0.2, 10],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15],
  ['claude-sonnet-4-5-20250929', 3, 3.75, 6, 0.3, 15],
  ['claude-sonnet-4-20250514', 3, 3.75, 6, 0.3, 15],
  ['claude-haiku-4-5-20251001', 1, 1.25, 2, 0.1, 5],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
  ['claude-3-5-haiku-20241022', 0.8, 1, 1.6, 0.08, 4],
];

export const SEED_PRICES: ReadonlyArray<PriceRow> = SEED.map(
  ([model, input, write5m, write1h, read, output]) => ({
    model,
    inputPer1M: input,
    outputPer1M: output,
    cacheReadPer1M: read,
    cacheWrite5mPer1M: write5m,
    cacheWrite1hPer1M: write1h,
    source: SEED_SOURCE,
    url: SEED_URL,
    fetchedAt: SEED_FETCHED_AT,
    effectiveFrom: '1970-01-01',
    status: 'active' as const,
  }),
);
