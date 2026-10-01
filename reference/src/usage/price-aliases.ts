/**
 * Explicit alias map from the model ids that appear in the usage ledger to the
 * ids each price source uses. Only ids listed here are priced from a source: a
 * source id that is not listed is ignored, so a similarly named model (a batch
 * variant, a long-context tier, another vendor's copy) is never priced as a
 * ledger model.
 *
 * Source ids were read from the live OpenRouter models endpoint and the
 * LiteLLM price file on 2026-09-30. A ledger model absent from a source is
 * simply omitted for that source.
 */

import type { SourceAliases } from './price-source.js';

function anthropic(
  model: string,
  openrouter: string[],
  litellm: string[],
): [string, SourceAliases] {
  return [model, { openrouter, litellm }];
}

export const MODEL_ALIASES: Readonly<Record<string, SourceAliases>> = Object.fromEntries([
  anthropic('claude-fable-5-1', ['anthropic/claude-fable-5.1'], ['claude-fable-5-1']),
  anthropic('claude-fable-5', ['anthropic/claude-fable-5'], ['claude-fable-5']),
  anthropic('claude-opus-5-5', ['anthropic/claude-opus-5.5'], ['claude-opus-5-5']),
  anthropic('claude-opus-5', ['anthropic/claude-opus-5'], ['claude-opus-5']),
  anthropic('claude-opus-4-8', ['anthropic/claude-opus-4.8'], ['claude-opus-4-8']),
  anthropic('claude-opus-4-7', ['anthropic/claude-opus-4.7'], ['claude-opus-4-7']),
  anthropic('claude-opus-4-6', ['anthropic/claude-opus-4.6'], ['claude-opus-4-6']),
  anthropic(
    'claude-opus-4-5-20251101',
    ['anthropic/claude-opus-4.5'],
    ['claude-opus-4-5-20251101'],
  ),
  anthropic('claude-opus-4-1-20250805', ['anthropic/claude-opus-4.1'], []),
  anthropic('claude-opus-4-20250514', [], []),
  anthropic('claude-sonnet-5-5', ['anthropic/claude-sonnet-5.5'], ['claude-sonnet-5-5']),
  anthropic('claude-sonnet-5', ['anthropic/claude-sonnet-5'], ['claude-sonnet-5']),
  anthropic('claude-sonnet-4-6', ['anthropic/claude-sonnet-4.6'], ['claude-sonnet-4-6']),
  anthropic(
    'claude-sonnet-4-5-20250929',
    ['anthropic/claude-sonnet-4.5'],
    ['claude-sonnet-4-5-20250929'],
  ),
  anthropic('claude-sonnet-4-20250514', ['anthropic/claude-sonnet-4'], []),
  anthropic(
    'claude-haiku-4-5-20251001',
    ['anthropic/claude-haiku-4.5'],
    ['claude-haiku-4-5-20251001'],
  ),
  anthropic('claude-haiku-4-5', ['anthropic/claude-haiku-4.5'], ['claude-haiku-4-5']),
  anthropic('claude-3-5-haiku-20241022', [], []),
]);
