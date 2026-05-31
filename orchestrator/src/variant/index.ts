/**
 * RFC-0017 In-Soul Variant Pattern — module barrel.
 *
 * Re-exports the public surfaces for all five phases:
 *
 *   Phase 1 (AISDLC-435):
 *   - Variant inheritance validator + event types
 *
 *   Phase 3 (AISDLC-436):
 *   - Deprecation lifecycle engine (OQ-3)
 *   - Eτ_tessellation_drift variant-scoped extension (AC #4)
 *   - Engineering review routing (OQ-7, AC #5, #6, #7)
 *
 *   Phase 4 (AISDLC-437):
 *   - InternalAdopter three-product reference impl
 *
 *   Phase 5 (AISDLC-438):
 *   - OQ-8 cardinality activation Decision wiring
 */

// Phase 1 — Inheritance validator
export {
  INHERITED_LOCKED_FIELDS,
  DEFAULT_SOFT_WARN_AT,
  DEFAULT_HARD_LIMIT,
  validateVariantDeclarations,
  hasBlockingViolations,
} from './inheritance-validator.js';

export type {
  InheritedLockedField,
  VariantEventKind,
  VariantInheritanceViolation,
  VariantCountSoftWarning,
  VariantCountHardLimitExceeded,
  NestedVariantRejected,
  VariantEvent,
  VariantDeclarationInput,
  VariantLimitsConfig,
  ValidateVariantDeclarationsOptions,
} from './inheritance-validator.js';

// Phase 3 — Deprecation lifecycle (OQ-3)
export {
  DEFAULT_DEPRECATION_WINDOW_DAYS,
  DEFAULT_APPROACHING_WINDOW_DAYS,
  resolveDeprecationState,
  evaluateDeprecationLifecycle,
} from './deprecation-lifecycle.js';

export type {
  VariantDeprecationState,
  VariantDeprecationDecisionKind,
  VariantLifecycleConfig,
  DeprecatedVariantDeclaration,
  VariantDeprecationEvent,
  VariantMigrationTask,
  VariantDeprecationResult,
} from './deprecation-lifecycle.js';

// Phase 3 — Eτ_tessellation_drift variant-scoped extension (AC #4)
export { detectVariantDrift } from './drift-extension.js';

export type {
  VariantDriftFinding,
  VariantDesignIntentDriftEvent,
  VariantDriftExtensionConfig,
  VariantDriftExtensionInput,
  VariantDriftExtensionResult,
} from './drift-extension.js';

// Phase 3 — Engineering review routing (OQ-7, AC #5-#7)
export { triggerEngineeringReview, checkReviewerGate } from './engineering-review.js';

export type {
  EngineeringReviewDecisionKind,
  VariantDeclarationForReview,
  EngineeringReviewRouting,
  VariantSubstrateCostReviewEvent,
  VariantSubstrateCostBlockEvent,
  EngineeringReviewEvent,
  MissingEngineeringReviewFlag,
  ReviewerGateCheckInput,
  ReviewerGateCheckResult,
} from './engineering-review.js';

// Phase 5 — OQ-8 cardinality activation Decision wiring (AISDLC-438)
export {
  trackCardinalityActivationRequest,
  shouldPromoteToOperatorReview,
  DEFAULT_CARDINALITY_ACTIVATION_THRESHOLD,
} from './cardinality-activation.js';

export type {
  CardinalityActivationRequest,
  CardinalityActivationResult,
} from './cardinality-activation.js';

// Phase 4 — InternalAdopter three-product reference impl (AISDLC-437)
export {
  INTERNAL_ADOPTER_SUBSTRATE,
  INTERNAL_ADOPTER_PRODUCTS,
  productA,
  productB,
  productC,
  buildVariantsBySoul,
  buildVariantScores,
  computeSoulAggregateBaseline,
} from './internal-adopter/index.js';

export type { InternalAdopterSubstrate, InternalAdopterProduct } from './internal-adopter/index.js';
