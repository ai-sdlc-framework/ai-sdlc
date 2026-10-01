/**
 * Price feed: refresh the price history from public sources, hold suspicious
 * changes, and report what is in force.
 *
 * The history is append-only (see `prices.ts`). A refresh appends a row only
 * when a model's prices changed, with `effectiveFrom` set to the fetch date, so
 * a call made before the change keeps its old price.
 *
 * A source may leave a token class unpublished. The refresh merges classes per
 * model across sources (earlier sources first) and appends a row only when all
 * five classes resolved. A model that cannot be fully resolved is reported as
 * `incomplete` and stays unpriced or at its last row; it is never zero-filled
 * and never priced as another model.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIR_MODE, FILE_MODE } from './fs-lock.js';
import { resolveUsageDir } from './paths.js';
import { createLiteLlmSource } from './price-source-litellm.js';
import { createOpenRouterSource } from './price-source-openrouter.js';
import {
  PRICE_CLASSES,
  PRICE_CLASS_FIELD,
  isValidPrice,
  sourceRowProblem,
  type PriceClass,
  type PriceSource,
  type PriceSourceOptions,
  type SourcePriceRow,
} from './price-source.js';
import {
  appendFetchedPriceRows,
  appendManualPriceRows,
  readPriceHistory,
  selectPriceRow,
} from './prices.js';
import type { PriceRow, UsageStoreOptions } from './types.js';

export const DEFAULT_TOLERANCE = 0.05;
export const DEFAULT_CHANGE_FACTOR = 3;
export const DEFAULT_STALE_AFTER_DAYS = 14;

const STATE_FILE = 'price-feed-state.json';
const DAY_MS = 86_400_000;

/** Sources in precedence order: provider-native first (none yet), then aggregators. */
export function defaultPriceSources(opts: PriceSourceOptions = {}): PriceSource[] {
  return [createOpenRouterSource(opts), createLiteLlmSource(opts)];
}

export interface PriceFeedConfig {
  /** Relative disagreement between sources that holds a row. Default 0.05. */
  tolerance?: number;
  /** Multiplicative move against the last row that holds a row. Default 3. */
  changeFactor?: number;
  /** Days without a successful refresh before prices are stale. Default 14. */
  staleAfterDays?: number;
}

export interface PriceChange {
  model: string;
  tokenClass: PriceClass;
  oldPrice: number;
  newPrice: number;
}

export interface RefreshOptions extends UsageStoreOptions, PriceFeedConfig {
  sources: readonly PriceSource[];
  now?: () => Date;
  /** Told how the feed ran. Never throws into the refresh. */
  onCapability?: (outcome: 'live' | 'degraded', reason?: string) => void;
}

export interface SourceOutcome {
  name: string;
  ok: boolean;
  rows: number;
  error?: string;
}

export type HoldReason = 'sources-disagree' | 'change-factor';

export interface RefreshResult {
  fetchedAt: string;
  sources: SourceOutcome[];
  /** True when at least one source answered. */
  anySourceSucceeded: boolean;
  /** Active rows appended. */
  appended: number;
  held: Array<{ model: string; reason: HoldReason }>;
  unchanged: number;
  /** Models whose five classes could not all be resolved. */
  incomplete: string[];
  rejected: Array<{ source: string; model: string; reason: string }>;
  /** Active price changes, one per token class that moved. */
  changes: PriceChange[];
}

export interface PriceFeedState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

function num(row: PriceRow, c: PriceClass): number {
  return row[PRICE_CLASS_FIELD[c]];
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

function samePrices(a: PriceRow, b: PriceRow): boolean {
  return PRICE_CLASSES.every((c) => same(num(a, c), num(b, c)));
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function safeMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

export function readPriceFeedState(opts: UsageStoreOptions = {}): PriceFeedState {
  const file = join(resolveUsageDir(opts), STATE_FILE);
  if (!existsSync(file)) return {};
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!v || typeof v !== 'object') return {};
    const r = v as Record<string, unknown>;
    const out: PriceFeedState = {};
    for (const k of ['lastAttemptAt', 'lastSuccessAt', 'lastError'] as const) {
      if (typeof r[k] === 'string') out[k] = r[k];
    }
    return out;
  } catch {
    return {};
  }
}

function writePriceFeedState(state: PriceFeedState, opts: UsageStoreOptions): void {
  try {
    const dir = resolveUsageDir(opts);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const file = join(dir, STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf-8', mode: FILE_MODE });
    renameSync(tmp, file);
  } catch {
    // state is a convenience; a write failure must not fail the refresh
  }
}

interface Contribution {
  source: string;
  row: SourcePriceRow;
}

/** Latest pending held row: held, and newer than the last non-held fetched row. */
function pendingHeld(rows: readonly PriceRow[], model: string): PriceRow | undefined {
  let held: PriceRow | undefined;
  let settled = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    if (r.model !== model) continue;
    const t = Date.parse(r.fetchedAt);
    if (r.status === 'held') {
      if (!held || t >= Date.parse(held.fetchedAt)) held = r;
    } else if (r.status === 'active' && t > settled) {
      settled = t;
    }
  }
  return held && Date.parse(held.fetchedAt) > settled ? held : undefined;
}

/**
 * Fetch every source, validate, and append changed prices. Never throws: a
 * failing source is recorded in the result and the last prices stay in force.
 */
export async function refreshPrices(opts: RefreshOptions): Promise<RefreshResult> {
  const now = (opts.now ?? ((): Date => new Date()))();
  const fetchedAt = now.toISOString();
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const factor = opts.changeFactor ?? DEFAULT_CHANGE_FACTOR;
  const result: RefreshResult = {
    fetchedAt,
    sources: [],
    anySourceSucceeded: false,
    appended: 0,
    held: [],
    unchanged: 0,
    incomplete: [],
    rejected: [],
    changes: [],
  };

  const byModel = new Map<string, Contribution[]>();
  for (const src of opts.sources) {
    try {
      const rows = await src.fetchPrices();
      let usable = 0;
      for (const row of rows) {
        const problem = sourceRowProblem(row);
        if (problem) {
          result.rejected.push({ source: src.name, model: String(row.model), reason: problem });
          continue;
        }
        usable += 1;
        const list = byModel.get(row.model) ?? [];
        list.push({ source: src.name, row });
        byModel.set(row.model, list);
      }
      result.sources.push({ name: src.name, ok: true, rows: usable });
    } catch (err) {
      result.sources.push({ name: src.name, ok: false, rows: 0, error: safeMessage(err) });
    }
  }
  result.anySourceSucceeded = result.sources.some((s) => s.ok);

  try {
    if (result.anySourceSucceeded) applyRows(byModel, result, opts, now, tolerance, factor);
  } catch (err) {
    result.sources.push({ name: 'history', ok: false, rows: 0, error: safeMessage(err) });
  }

  const priorState = readPriceFeedState(opts);
  const state: PriceFeedState = { ...priorState, lastAttemptAt: fetchedAt };
  if (result.anySourceSucceeded) {
    state.lastSuccessAt = fetchedAt;
    delete state.lastError;
  } else {
    state.lastError = result.sources.map((s) => `${s.name}: ${s.error ?? 'failed'}`).join('; ');
  }
  writePriceFeedState(state, opts);

  try {
    if (result.anySourceSucceeded) opts.onCapability?.('live');
    else opts.onCapability?.('degraded', 'every price source failed; last known prices in force');
  } catch {
    // reporting must not affect the refresh
  }
  return result;
}

function applyRows(
  byModel: Map<string, Contribution[]>,
  result: RefreshResult,
  opts: RefreshOptions,
  now: Date,
  tolerance: number,
  factor: number,
): void {
  const history = readPriceHistory(opts);
  const nonManual = history.filter((r) => r.status !== 'manual');
  const fetchedAt = result.fetchedAt;
  const toAppend: PriceRow[] = [];

  for (const [model, contribs] of byModel) {
    // Merge classes: the first source (highest precedence) that published one wins.
    const merged: Partial<Record<PriceClass, number>> = {};
    const used = new Set<Contribution>();
    let disagree = false;
    for (const c of PRICE_CLASSES) {
      const values: number[] = [];
      for (const k of contribs) {
        const v = k.row[PRICE_CLASS_FIELD[c]];
        if (isValidPrice(v)) {
          values.push(v);
          if (merged[c] === undefined) {
            merged[c] = v;
            used.add(k);
          }
        }
      }
      if (values.length > 1 && Math.max(...values) / Math.min(...values) - 1 > tolerance) {
        disagree = true;
      }
    }
    if (PRICE_CLASSES.some((c) => merged[c] === undefined)) {
      result.incomplete.push(model);
      continue;
    }
    const first = [...used][0] as Contribution;
    const candidate: PriceRow = {
      model,
      inputPer1M: merged.input as number,
      outputPer1M: merged.output as number,
      cacheReadPer1M: merged.cacheRead as number,
      cacheWrite5mPer1M: merged.cacheWrite5m as number,
      cacheWrite1hPer1M: merged.cacheWrite1h as number,
      source: [...new Set([...used].map((k) => k.source))].join('+'),
      url: first.row.url,
      fetchedAt,
      effectiveFrom: dateOnly(now),
      status: 'active',
    };

    const baseline = selectPriceRow(nonManual, model, fetchedAt);
    if (baseline && samePrices(baseline, candidate)) {
      result.unchanged += 1;
      continue;
    }
    const pending = pendingHeld(history, model);
    if (pending && samePrices(pending, candidate)) {
      result.unchanged += 1;
      continue;
    }

    let reason: HoldReason | undefined;
    if (disagree) reason = 'sources-disagree';
    else if (
      baseline &&
      PRICE_CLASSES.some((c) => {
        const ratio = num(candidate, c) / num(baseline, c);
        return ratio > factor || ratio < 1 / factor;
      })
    ) {
      reason = 'change-factor';
    }
    if (reason) {
      toAppend.push({ ...candidate, status: 'held' });
      result.held.push({ model, reason });
      continue;
    }
    toAppend.push(candidate);
    result.appended += 1;
    // A manual row in force keeps the effective price, so nothing changed for callers.
    const manualInForce = history.some((r) => r.model === model && r.status === 'manual');
    if (baseline && !manualInForce) {
      for (const c of PRICE_CLASSES) {
        if (!same(num(baseline, c), num(candidate, c))) {
          result.changes.push({
            model,
            tokenClass: c,
            oldPrice: num(baseline, c),
            newPrice: num(candidate, c),
          });
        }
      }
    }
  }
  if (toAppend.length > 0) appendFetchedPriceRows(toAppend, opts);
}

export interface ConfirmResult {
  row: PriceRow;
  /** Price in force before the confirmation, when there was one. */
  previous?: PriceRow;
  changes: PriceChange[];
}

/** Promote a model's pending held row to active. Undefined when none is pending. */
export function confirmHeldPrice(
  model: string,
  opts: UsageStoreOptions & { now?: () => Date } = {},
): ConfirmResult | undefined {
  const now = (opts.now ?? ((): Date => new Date()))();
  const history = readPriceHistory(opts);
  const held = pendingHeld(history, model);
  if (!held) return undefined;
  const previous = selectPriceRow(history, model, now.toISOString());
  const row: PriceRow = { ...held, status: 'active', fetchedAt: now.toISOString() };
  if (appendFetchedPriceRows([row], opts) === 0) return undefined;
  const changes: PriceChange[] = [];
  if (previous && previous.status !== 'manual') {
    for (const c of PRICE_CLASSES) {
      if (!same(num(previous, c), num(row, c))) {
        changes.push({ model, tokenClass: c, oldPrice: num(previous, c), newPrice: num(row, c) });
      }
    }
  }
  return { row, previous, changes };
}

export type ManualPrices = Record<PriceClass, number>;

/** Write an operator-entered `manual` row. Throws on an invalid price. */
export function setManualPrice(
  model: string,
  prices: ManualPrices,
  opts: UsageStoreOptions & { now?: () => Date; effectiveFrom?: string } = {},
): PriceRow {
  if (!model) throw new Error('model is required');
  for (const c of PRICE_CLASSES) {
    if (!isValidPrice(prices[c])) throw new Error(`${c} price must be a positive number`);
  }
  const now = (opts.now ?? ((): Date => new Date()))();
  const effectiveFrom = opts.effectiveFrom ?? dateOnly(now);
  if (Number.isNaN(Date.parse(effectiveFrom))) throw new Error('effectiveFrom is not a date');
  const row: PriceRow = {
    model,
    inputPer1M: prices.input,
    outputPer1M: prices.output,
    cacheReadPer1M: prices.cacheRead,
    cacheWrite5mPer1M: prices.cacheWrite5m,
    cacheWrite1hPer1M: prices.cacheWrite1h,
    source: 'manual',
    url: 'manual',
    fetchedAt: now.toISOString(),
    effectiveFrom,
    status: 'manual',
  };
  appendManualPriceRows([row], opts);
  return row;
}

export interface PriceListEntry {
  model: string;
  /** Row in force now, or undefined when the model only has held rows. */
  active?: PriceRow;
  /** Whole days since the row was observed. */
  ageDays?: number;
  /** True when the feed has not refreshed successfully within the staleness limit. */
  stale: boolean;
  held?: PriceRow;
}

/**
 * Whether prices are stale: a `manual` row never is; any other row is stale when
 * the last successful refresh (or, with no refresh on record, the row's own
 * observation time) is more than `staleAfterDays` old.
 */
export function isPriceStale(
  row: PriceRow,
  now: Date,
  state: PriceFeedState,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS,
): boolean {
  if (row.status === 'manual') return false;
  const ref = Math.max(
    Date.parse(row.fetchedAt),
    state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : Number.NEGATIVE_INFINITY,
  );
  return now.getTime() - ref > staleAfterDays * DAY_MS;
}

/** One entry per model with the price in force, its age, staleness and any held row. */
export function listPrices(
  opts: UsageStoreOptions & PriceFeedConfig & { now?: () => Date } = {},
): PriceListEntry[] {
  const now = (opts.now ?? ((): Date => new Date()))();
  const history = readPriceHistory(opts);
  const state = readPriceFeedState(opts);
  const models = [...new Set(history.map((r) => r.model))].sort();
  return models.map((model) => {
    const active = selectPriceRow(history, model, now.toISOString());
    return {
      model,
      active,
      ageDays: active
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(active.fetchedAt)) / DAY_MS))
        : undefined,
      stale: active ? isPriceStale(active, now, state, opts.staleAfterDays) : false,
      held: pendingHeld(history, model),
    };
  });
}
