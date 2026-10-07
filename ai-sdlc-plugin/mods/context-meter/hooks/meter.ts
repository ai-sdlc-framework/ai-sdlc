/**
 * Pure logic for the context-meter mod (AISDLC-743): thresholds, colour
 * mapping, token totals and cost weight. No host imports, so it runs under
 * plain `node --test`.
 */

export type Thresholds = {
  /** Percent of the window where the bar turns amber. */
  amber: number;
  /** Percent where the band says to hand off soon. */
  hot: number;
  /** Percent where the bar turns red (the clearing level). */
  red: number;
};

/** The one place the defaults live: 10 / 13 / 15 percent of the window. */
export const DEFAULT_THRESHOLDS: Thresholds = { amber: 10, hot: 13, red: 15 };

export type Level = 'ok' | 'amber' | 'hot' | 'red';

export const LEVEL_COLOR: Record<Level, string> = {
  ok: 'green',
  amber: 'yellow',
  hot: 'yellow',
  red: 'red',
};

export type Totals = { input: number; cacheWrite: number; cacheRead: number; output: number };

export type UsageLike = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

export const EMPTY_TOTALS: Totals = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

/** Read the three thresholds from userConfig options; fall back to defaults when invalid or unordered. */
export function resolveThresholds(options: Record<string, unknown> | undefined): Thresholds {
  const num = (v: unknown, d: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  const t: Thresholds = {
    amber: num(options?.amberAtPercent, DEFAULT_THRESHOLDS.amber),
    hot: num(options?.hotAtPercent, DEFAULT_THRESHOLDS.hot),
    red: num(options?.redAtPercent, DEFAULT_THRESHOLDS.red),
  };
  return t.amber <= t.hot && t.hot <= t.red ? t : { ...DEFAULT_THRESHOLDS };
}

/** Share of the window in use, as a percentage; null when it cannot be computed. */
export function percentOfWindow(tokens: number | undefined, window: number | undefined) {
  if (tokens === undefined || !window || window <= 0) return null;
  return (tokens / window) * 100;
}

export function levelFor(percent: number, t: Thresholds = DEFAULT_THRESHOLDS): Level {
  if (percent >= t.red) return 'red';
  if (percent >= t.hot) return 'hot';
  if (percent >= t.amber) return 'amber';
  return 'ok';
}

/** Add one response's usage into running totals (missing counts read as zero). */
export function addUsage(totals: Totals, usage: UsageLike): Totals {
  return {
    input: totals.input + (usage.input_tokens ?? 0),
    cacheWrite: totals.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
    cacheRead: totals.cacheRead + (usage.cache_read_input_tokens ?? 0),
    output: totals.output + (usage.output_tokens ?? 0),
  };
}

/**
 * Approximate cost weight in "input-token equivalents", using list-price
 * ratios against uncached input: cache write 1.25x, cache read 0.1x, output 5x.
 * A relative weight, not dollars.
 */
export function costWeight(totals: Totals): number {
  return totals.input + totals.cacheWrite * 1.25 + totals.cacheRead * 0.1 + totals.output * 5;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Text progress bar, `width` cells, filled up to the share of the red threshold. */
export function bar(percent: number, t: Thresholds = DEFAULT_THRESHOLDS, width = 20): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent / t.red) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
