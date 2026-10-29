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

export {
  INTERNAL_ADOPTER_JOURNEY_SOULS,
  journeysProductA,
  journeysProductB,
  journeysProductC,
  journeysProductD,
  journeyUri,
  validateJourneyStateMachine,
  buildAuditReports,
  trackCrossSoulCoordinationRequests,
  CROSS_SOUL_COORDINATION_DECISION_KIND,
  DEFAULT_CROSS_SOUL_COORDINATION_THRESHOLD,
} from './journeys.js';

export type {
  InternalAdopterJourney,
  InternalAdopterJourneySoul,
  JourneyAuditReport,
  StateMachineIssue,
  CrossSoulCoordinationRequest,
  CrossSoulCoordinationCounterResult,
} from './journeys.js';
