/**
 * Price source contract and shared helpers for the model price feed.
 *
 * Provider-native price endpoints, checked 2026-09-30 for every provider whose
 * models appear in the usage ledger (Anthropic, plus OpenAI and Google for the
 * other harnesses). Each result comes from an unauthenticated request to the
 * provider's public API host and from the provider's pricing page:
 *
 * - Anthropic: none found. `GET api.anthropic.com/v1/models` requires an API
 *   key and describes models, not prices. Prices are published only as a table
 *   on the pricing page of the Anthropic documentation site.
 * - OpenAI: none found. `GET api.openai.com/v1/models` requires an API key and
 *   lists model ids without prices. Prices are published on the pricing page.
 * - Google (Gemini API): none found. `GET generativelanguage.googleapis.com
 *   /v1beta/models` requires an API key and carries limits, not prices.
 *
 * No provider-native adapter ships. The two aggregator adapters (OpenRouter and
 * the LiteLLM price file) are the only sources. When a provider adds a public
 * machine-readable price endpoint, add an adapter and list it before the
 * aggregators in {@link defaultPriceSources}; the refresh gives earlier sources
 * precedence.
 *
 * Source data is untrusted. Adapters only parse it into numbers; the refresh
 * validates every value before anything reaches the price history, and nothing
 * fetched is ever evaluated or placed in a command.
 */

/** The five token classes a price row carries. */
export const PRICE_CLASSES = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
] as const;

export type PriceClass = (typeof PRICE_CLASSES)[number];

/** The `PriceRow` field that holds each class. */
export const PRICE_CLASS_FIELD = {
  input: 'inputPer1M',
  output: 'outputPer1M',
  cacheRead: 'cacheReadPer1M',
  cacheWrite5m: 'cacheWrite5mPer1M',
  cacheWrite1h: 'cacheWrite1hPer1M',
} as const satisfies Record<PriceClass, string>;

/**
 * One model's prices as published by one source, in USD per million tokens.
 * A class the source does not publish is `undefined`, never zero. A value the
 * source did publish is carried as parsed (including zero, negative or NaN) so
 * the refresh can reject it and count the rejection.
 */
export interface SourcePriceRow {
  /** Exact model id as it appears in the usage ledger. */
  model: string;
  inputPer1M?: number;
  outputPer1M?: number;
  cacheReadPer1M?: number;
  cacheWrite5mPer1M?: number;
  cacheWrite1hPer1M?: number;
  /** URL the prices were fetched from. */
  url: string;
  /** ISO time of the fetch. */
  fetchedAt: string;
}

export interface PriceSource {
  /** Stable short name, used by `--source` and stored on price rows. */
  name: string;
  /** Fetch the source's prices. Rejects on a network or format failure. */
  fetchPrices(): Promise<SourcePriceRow[]>;
}

/** HTTP is injected so tests never touch the network. */
export type FetchFn = typeof fetch;

export interface PriceSourceOptions {
  fetch?: FetchFn;
  now?: () => Date;
  /** Ledger model id to source ids. Defaults to {@link MODEL_ALIASES}. */
  aliases?: Readonly<Record<string, SourceAliases>>;
}

/** Source-side ids that price one ledger model, per source. */
export interface SourceAliases {
  openrouter?: readonly string[];
  litellm?: readonly string[];
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 25_000_000;

/**
 * GET a public URL and parse the JSON body. The request carries no body, no
 * query string and no identifying headers: nothing about the repository, the
 * task or the usage ledger leaves the machine.
 */
export async function fetchPublicJson(
  url: string,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new Error('response too large');
  return JSON.parse(text) as unknown;
}

/**
 * Parse a per-token price (a string or a number) into USD per million tokens.
 * Absent (`undefined`/`null`) stays `undefined`; anything unparsable becomes
 * `NaN` so validation rejects it rather than treating it as unpublished.
 */
export function perTokenToPer1M(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return Number.NaN;
  if (!Number.isFinite(n)) return Number.NaN;
  // Trim binary noise from the scale-up (0.000002 * 1e6 is not exactly 2).
  return Number((n * 1_000_000).toPrecision(12));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A published class value that is a real price. */
export function isValidPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Why a source row cannot be used, or `undefined` when every published class
 * is a positive finite number. Unpublished classes are fine here.
 */
export function sourceRowProblem(row: SourcePriceRow): string | undefined {
  if (typeof row.model !== 'string' || row.model === '') return 'missing model id';
  if (Number.isNaN(Date.parse(row.fetchedAt))) return 'invalid fetch time';
  for (const c of PRICE_CLASSES) {
    const v = row[PRICE_CLASS_FIELD[c]];
    if (v !== undefined && !isValidPrice(v)) return `invalid ${c} price`;
  }
  return undefined;
}
