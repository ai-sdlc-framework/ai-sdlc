/**
 * Weighted units (RFC-0050 A4).
 *
 * The provider reports subscription consumption as a percentage and publishes
 * no conversion from tokens, so reports weigh each call in "units". A unit is
 * defined by ratios: one input token of the reference model is one unit, and
 * every other token class and model is weighed against it using the price
 * history in force. The weights follow the price feed. Explicit weights in the
 * usage config override the derived ones.
 *
 * The weights are a proxy for how the provider counts consumption, not a
 * statement of it, and every report that shows units says so.
 *
 * @module usage/units
 */

import {
  selectPriceRow,
  type ModelCallRecord,
  type ModelCallTokens,
  type PriceRow,
} from '@ai-sdlc/reference';
import type { ConfiguredWeights } from './usage-config.js';

export const TOKEN_CLASSES = [
  'input',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheRead',
  'output',
] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

/** Stated in every report that shows units. */
export const UNITS_PROXY_NOTE =
  'Units are weighted tokens. The weights are a proxy for how the provider counts consumption, not a published conversion.';

/** Used only when the price history has no usable row at all (Anthropic list ratios). */
const BUILT_IN_CLASS_RATIOS: Record<TokenClass, number> = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  output: 5,
};

export interface UnitWeights {
  /** Units per token for each class, weighed against the reference model's input token. */
  tokenClasses: Record<TokenClass, number>;
  /** Multiplier per exact model id derived from the price history. */
  modelMultipliers: Record<string, number>;
  /** Multiplier per model family substring from the usage config. */
  modelFamilies: Record<string, number>;
  /** Where the class weights came from. */
  basis: 'price-history' | 'built-in-ratios';
  /** Reference model whose input token is one unit, when derived. */
  referenceModel?: string;
  /** Names of the weights the usage config set explicitly. */
  overrides: string[];
}

const PRICE_FIELD: Record<TokenClass, keyof PriceRow> = {
  input: 'inputPer1M',
  cacheWrite5m: 'cacheWrite5mPer1M',
  cacheWrite1h: 'cacheWrite1hPer1M',
  cacheRead: 'cacheReadPer1M',
  output: 'outputPer1M',
};

function currentRows(rows: ReadonlyArray<PriceRow>, at: string): Map<string, PriceRow> {
  const out = new Map<string, PriceRow>();
  for (const model of new Set(rows.map((r) => r.model))) {
    const row = selectPriceRow(rows, model, at);
    if (row) out.set(model, row);
  }
  return out;
}

/**
 * Derive the weights from the price rows in effect at `at`, then apply the
 * explicit overrides from the usage config.
 */
export function deriveUnitWeights(
  rows: ReadonlyArray<PriceRow>,
  at: string,
  configured?: ConfiguredWeights,
): UnitWeights {
  const current = currentRows(rows, at);
  const models = [...current.keys()].sort();
  const refModel = models.find((m) => m.includes('sonnet')) ?? models[0];
  const ref = refModel ? current.get(refModel) : undefined;

  const tokenClasses = { ...BUILT_IN_CLASS_RATIOS };
  const modelMultipliers: Record<string, number> = {};
  if (ref) {
    for (const c of TOKEN_CLASSES) {
      tokenClasses[c] = (ref[PRICE_FIELD[c]] as number) / ref.inputPer1M;
    }
    for (const [model, row] of current) modelMultipliers[model] = row.inputPer1M / ref.inputPer1M;
  }

  const overrides: string[] = [];
  for (const c of TOKEN_CLASSES) {
    const v = configured?.tokenClasses[c];
    if (v !== undefined) {
      tokenClasses[c] = v;
      overrides.push(`tokenClasses.${c}`);
    }
  }
  const modelFamilies = { ...(configured?.modelFamilies ?? {}) };
  for (const f of Object.keys(modelFamilies)) overrides.push(`modelFamilies.${f}`);

  return {
    tokenClasses,
    modelMultipliers,
    modelFamilies,
    basis: ref ? 'price-history' : 'built-in-ratios',
    ...(refModel && ref ? { referenceModel: refModel } : {}),
    overrides,
  };
}

/** Multiplier for a model: config family, then the derived exact-model ratio, then 1. */
export function modelMultiplier(model: string, weights: UnitWeights): number {
  const id = model.toLowerCase();
  for (const [family, mult] of Object.entries(weights.modelFamilies)) {
    if (id.includes(family.toLowerCase())) return mult;
  }
  return weights.modelMultipliers[model] ?? 1;
}

/** True when the model has a family override or a derived ratio (not the neutral 1). */
export function hasModelWeight(model: string, weights: UnitWeights): boolean {
  const id = model.toLowerCase();
  if (Object.keys(weights.modelFamilies).some((f) => id.includes(f.toLowerCase()))) return true;
  return Object.hasOwn(weights.modelMultipliers, model);
}

export function unitsForTokens(
  model: string,
  tokens: ModelCallTokens,
  weights: UnitWeights,
): number {
  let sum = 0;
  for (const c of TOKEN_CLASSES) sum += (tokens[c] ?? 0) * weights.tokenClasses[c];
  return sum * modelMultiplier(model, weights);
}

/** Weighted units for one call. */
export function unitsForCall(
  record: Pick<ModelCallRecord, 'model' | 'tokens'>,
  weights: UnitWeights,
): number {
  return unitsForTokens(record.model, record.tokens, weights);
}

/** One line saying where the weights came from, for report footers. */
export function describeWeights(weights: UnitWeights): string {
  const basis =
    weights.basis === 'price-history'
      ? `derived from the price history (reference model ${weights.referenceModel})`
      : 'built-in price ratios (no price rows found)';
  const over = weights.overrides.length ? `; overridden: ${weights.overrides.join(', ')}` : '';
  return `${UNITS_PROXY_NOTE} Weights ${basis}${over}.`;
}
