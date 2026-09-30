/**
 * Price history and per-call API-equivalent costing.
 *
 * `prices.jsonl` in the usage directory is append-only. A call is priced with
 * the row in effect at the call's timestamp, so a past report does not change
 * when a price does. A model with no row is `unpriced`; it is never priced as
 * another model.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUsageLock } from './fs-lock.js';
import { resolveUsageDir } from './paths.js';
import { SEED_PRICES } from './prices-seed.js';
import {
  UNPRICED,
  type CallCostBreakdown,
  type ModelCallRecord,
  type PriceRow,
  type Unpriced,
  type UsageStoreOptions,
} from './types.js';

const PRICES_FILE = 'prices.jsonl';
const STATUSES = new Set(['active', 'held', 'manual']);

const PRICE_FIELDS = [
  'inputPer1M',
  'outputPer1M',
  'cacheReadPer1M',
  'cacheWrite5mPer1M',
  'cacheWrite1hPer1M',
] as const;

function isPriceRow(v: unknown): v is PriceRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.model !== 'string' || !r.model) return false;
  if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return false;
  for (const k of ['source', 'url', 'fetchedAt', 'effectiveFrom']) {
    if (typeof r[k] !== 'string') return false;
  }
  if (Number.isNaN(Date.parse(r.effectiveFrom as string))) return false;
  return PRICE_FIELDS.every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= 0);
}

/** Append observed price rows to `prices.jsonl`. Invalid rows are skipped; returns the count written. */
export function appendPriceRows(
  rows: ReadonlyArray<PriceRow>,
  opts: UsageStoreOptions = {},
): number {
  const valid = rows.filter(isPriceRow);
  if (valid.length === 0) return 0;
  const dir = resolveUsageDir(opts);
  return withUsageLock(dir, () => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, PRICES_FILE),
      valid.map((r) => `${JSON.stringify(r)}\n`).join(''),
      'utf-8',
    );
    return valid.length;
  });
}

/** Seed rows followed by every valid row in `prices.jsonl`, in file order. */
export function readPriceHistory(opts: UsageStoreOptions = {}): PriceRow[] {
  const rows: PriceRow[] = [...SEED_PRICES];
  const file = join(resolveUsageDir(opts), PRICES_FILE);
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isPriceRow(parsed)) rows.push(parsed);
    } catch {
      // skip a corrupt line
    }
  }
  return rows;
}

function newer(a: PriceRow, b: PriceRow): boolean {
  const ea = Date.parse(a.effectiveFrom);
  const eb = Date.parse(b.effectiveFrom);
  if (ea !== eb) return ea > eb;
  return Date.parse(a.fetchedAt) >= Date.parse(b.fetchedAt);
}

/**
 * The row in effect for `model` at `ts`: `manual` rows win over `active` ones,
 * `held` rows are ignored, and the latest effective date wins within a status.
 */
export function selectPriceRow(
  rows: ReadonlyArray<PriceRow>,
  model: string,
  ts: string,
): PriceRow | undefined {
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return undefined;
  let manual: PriceRow | undefined;
  let active: PriceRow | undefined;
  for (const r of rows) {
    if (r.model !== model || r.status === 'held') continue;
    if (Date.parse(r.effectiveFrom) > at) continue;
    if (r.status === 'manual') {
      if (!manual || newer(r, manual)) manual = r;
    } else if (!active || newer(r, active)) {
      active = r;
    }
  }
  return manual ?? active;
}

/**
 * API-equivalent cost of one call with each of the five token classes priced
 * separately, or `'unpriced'` when the model has no row in effect.
 */
export function priceCallBreakdown(
  record: Pick<ModelCallRecord, 'model' | 'ts' | 'tokens'>,
  opts: UsageStoreOptions & { rows?: ReadonlyArray<PriceRow> } = {},
): CallCostBreakdown | Unpriced {
  const rows = opts.rows ?? readPriceHistory(opts);
  const p = selectPriceRow(rows, record.model, record.ts);
  if (!p) return UNPRICED;
  const t = record.tokens;
  const input = (t.input * p.inputPer1M) / 1_000_000;
  const cacheWrite5m = (t.cacheWrite5m * p.cacheWrite5mPer1M) / 1_000_000;
  const cacheWrite1h = (t.cacheWrite1h * p.cacheWrite1hPer1M) / 1_000_000;
  const cacheRead = (t.cacheRead * p.cacheReadPer1M) / 1_000_000;
  const output = (t.output * p.outputPer1M) / 1_000_000;
  return {
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    total: input + cacheWrite5m + cacheWrite1h + cacheRead + output,
  };
}

/** API-equivalent cost in USD, or the literal `'unpriced'`. */
export function priceCall(
  record: Pick<ModelCallRecord, 'model' | 'ts' | 'tokens'>,
  opts: UsageStoreOptions & { rows?: ReadonlyArray<PriceRow> } = {},
): number | Unpriced {
  const b = priceCallBreakdown(record, opts);
  return b === UNPRICED ? UNPRICED : b.total;
}
