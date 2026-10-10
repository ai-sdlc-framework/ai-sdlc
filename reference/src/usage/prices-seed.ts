/**
 * Seed price rows shipped in code. Values are Anthropic's published list prices
 * (per million tokens) read on {@link SEED_FETCHED_AT}; the checked-in snapshot
 * `__fixtures__/published-prices.json` records the same list and a test fails
 * when a row here disagrees with it. A model that is not listed here has no seed
 * row and is reported as unpriced, never priced as another model. Newer observed
 * prices are appended to `prices.jsonl` and supersede these from their own
 * `effectiveFrom` date.
 *
 * Each row applies from its model's release date, so a call dated before the
 * model existed is unpriced. The date comes from the provider's model page
 * ("model-page-release-date"); a model whose listing carries no release date
 * uses the snapshot date in its id ("id-snapshot-date"). The rule used is
 * recorded in the row's `source`.
 */

import type { PriceRow } from './types.js';

export const SEED_FETCHED_AT = '2026-10-10T00:00:00.000Z';
export const SEED_SOURCE = 'anthropic-published-price-list';
export const SEED_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';

type DateRule = 'model-page-release-date' | 'id-snapshot-date';

/** [model, input, cache write 5m, cache write 1h, cache read, output, effectiveFrom, date rule] per million tokens. */
const SEED: ReadonlyArray<
  readonly [string, number, number, number, number, number, string, DateRule]
> = [
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50, '2026-09-01', 'model-page-release-date'],
  ['claude-fable-5', 10, 12.5, 20, 1, 50, '2026-06-09', 'model-page-release-date'],
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20, '2026-09-22', 'model-page-release-date'],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25, '2026-07-24', 'model-page-release-date'],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25, '2026-05-28', 'model-page-release-date'],
  ['claude-opus-4-7', 5, 6.25, 10, 0.5, 25, '2026-04-16', 'model-page-release-date'],
  ['claude-opus-4-6', 5, 6.25, 10, 0.5, 25, '2026-02-05', 'model-page-release-date'],
  ['claude-opus-4-5-20251101', 5, 6.25, 10, 0.5, 25, '2025-11-01', 'id-snapshot-date'],
  ['claude-opus-4-1-20250805', 15, 18.75, 30, 1.5, 75, '2025-08-05', 'id-snapshot-date'],
  ['claude-opus-4-20250514', 15, 18.75, 30, 1.5, 75, '2025-05-14', 'id-snapshot-date'],
  ['claude-sonnet-5-5', 2, 2.5, 4, 0.1, 10, '2026-09-28', 'model-page-release-date'],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10, '2026-06-30', 'model-page-release-date'],
  ['claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15, '2026-02-17', 'model-page-release-date'],
  ['claude-sonnet-4-5-20250929', 3, 3.75, 6, 0.3, 15, '2025-09-29', 'id-snapshot-date'],
  ['claude-sonnet-4-20250514', 3, 3.75, 6, 0.3, 15, '2025-05-14', 'id-snapshot-date'],
  ['claude-haiku-4-5-20251001', 1, 1.25, 2, 0.1, 5, '2025-10-01', 'id-snapshot-date'],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5, '2025-10-01', 'id-snapshot-date'],
  ['claude-3-5-haiku-20241022', 0.8, 1, 1.6, 0.08, 4, '2024-10-22', 'id-snapshot-date'],
];

export const SEED_PRICES: ReadonlyArray<PriceRow> = SEED.map(
  ([model, input, write5m, write1h, read, output, effectiveFrom, rule]) => ({
    model,
    inputPer1M: input,
    outputPer1M: output,
    cacheReadPer1M: read,
    cacheWrite5mPer1M: write5m,
    cacheWrite1hPer1M: write1h,
    source: `${SEED_SOURCE} ${SEED_FETCHED_AT.slice(0, 10)}; effectiveFrom rule: ${rule}`,
    url: SEED_URL,
    fetchedAt: SEED_FETCHED_AT,
    effectiveFrom,
    status: 'active' as const,
  }),
);
