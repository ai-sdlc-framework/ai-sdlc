/**
 * RFC-0017 In-Soul Variant Pattern — module barrel.
 *
 * Re-exports the public surfaces for all three phases:
 *
 *   Phase 1 (AISDLC-435):
 *   - Variant inheritance validator + event types
 *
 *   Phase 3 (AISDLC-436):
 *   - Deprecation lifecycle engine (OQ-3)
 *   - Eτ_tessellation_drift variant-scoped extension (AC #4)
 *   - Engineering review routing (OQ-7, AC #5, #6, #7)
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
