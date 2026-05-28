/**
 * RFC-0017 Phase 4 — InternalAdopter three-product reference impl barrel.
 *
 * Re-exports the canonical product fixtures + helpers. ProductD is
 * intentionally absent — deferred to RFC-0018 per RFC-0017 §11 v0.4.
 *
 * @see ./products.ts
 */

export {
  INTERNAL_ADOPTER_SUBSTRATE,
  INTERNAL_ADOPTER_PRODUCTS,
  productA,
  productB,
  productC,
  buildVariantsBySoul,
  buildVariantScores,
  computeSoulAggregateBaseline,
} from './products.js';

export type { InternalAdopterSubstrate, InternalAdopterProduct } from './products.js';
