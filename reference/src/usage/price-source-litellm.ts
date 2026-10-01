/**
 * LiteLLM price file adapter. The file is a JSON object keyed by model id whose
 * entries carry `input_cost_per_token`, `output_cost_per_token`,
 * `cache_read_input_token_cost`, `cache_creation_input_token_cost` (5 minute)
 * and `cache_creation_input_token_cost_above_1hr`.
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

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export function createLiteLlmSource(opts: PriceSourceOptions = {}): PriceSource {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? ((): Date => new Date());
  const aliases = opts.aliases ?? MODEL_ALIASES;
  return {
    name: 'litellm',
    async fetchPrices(): Promise<SourcePriceRow[]> {
      const body = await fetchPublicJson(LITELLM_URL, fetchFn);
      if (!isRecord(body)) throw new Error('unexpected response shape');
      const fetchedAt = now().toISOString();
      const rows: SourcePriceRow[] = [];
      for (const [model, a] of Object.entries(aliases)) {
        for (const id of a.litellm ?? []) {
          const e = Object.hasOwn(body, id) ? body[id] : undefined;
          if (!isRecord(e)) continue;
          rows.push({
            model,
            inputPer1M: perTokenToPer1M(e.input_cost_per_token),
            outputPer1M: perTokenToPer1M(e.output_cost_per_token),
            cacheReadPer1M: perTokenToPer1M(e.cache_read_input_token_cost),
            cacheWrite5mPer1M: perTokenToPer1M(e.cache_creation_input_token_cost),
            cacheWrite1hPer1M: perTokenToPer1M(e.cache_creation_input_token_cost_above_1hr),
            url: LITELLM_URL,
            fetchedAt,
          });
          break;
        }
      }
      return rows;
    },
  };
}
