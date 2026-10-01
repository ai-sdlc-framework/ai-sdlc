/**
 * OpenRouter models endpoint adapter. Each entry of `data` carries a `pricing`
 * object of per-token string values: `prompt`, `completion`, `input_cache_read`,
 * `input_cache_write` (5 minute) and `input_cache_write_1h`. Long-context
 * `overrides` tiers are ignored; the base price is used.
 */

import { MODEL_ALIASES } from './price-aliases.js';
import {
  fetchPublicJson,
  isRecord,
  perTokenToPer1M,
  type PriceSource,
  type PriceSourceOptions,
  type SourcePriceRow,
} from './price-source.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

export function createOpenRouterSource(opts: PriceSourceOptions = {}): PriceSource {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? ((): Date => new Date());
  const aliases = opts.aliases ?? MODEL_ALIASES;
  return {
    name: 'openrouter',
    async fetchPrices(): Promise<SourcePriceRow[]> {
      const body = await fetchPublicJson(OPENROUTER_URL, fetchFn);
      const data = isRecord(body) ? body.data : undefined;
      if (!Array.isArray(data)) throw new Error('unexpected response shape');
      const byId = new Map<string, Record<string, unknown>>();
      for (const e of data) {
        if (isRecord(e) && typeof e.id === 'string' && isRecord(e.pricing)) {
          byId.set(e.id, e.pricing);
        }
      }
      const fetchedAt = now().toISOString();
      const rows: SourcePriceRow[] = [];
      for (const [model, a] of Object.entries(aliases)) {
        for (const id of a.openrouter ?? []) {
          const p = byId.get(id);
          if (!p) continue;
          rows.push({
            model,
            inputPer1M: perTokenToPer1M(p.prompt),
            outputPer1M: perTokenToPer1M(p.completion),
            cacheReadPer1M: perTokenToPer1M(p.input_cache_read),
            cacheWrite5mPer1M: perTokenToPer1M(p.input_cache_write),
            cacheWrite1hPer1M: perTokenToPer1M(p.input_cache_write_1h),
            url: OPENROUTER_URL,
            fetchedAt,
          });
          break;
        }
      }
      return rows;
    },
  };
}
