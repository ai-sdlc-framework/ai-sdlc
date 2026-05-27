/**
 * RFC-0017 Phase 3 — OQ-7 Engineering review routing.
 *
 * Per OQ-7 resolution (2026-05-18):
 *
 *   "Design owns + Engineering review routed through Decision Catalog.
 *    Engineering's review becomes a tracked `Decision: variant-substrate-cost-review`
 *    in the catalog. Substrate-cost block → `Decision: variant-substrate-cost-block`
 *    → Design/Engineering routing per RFC-0029 actor model."
 *
 * This module implements:
 *
 *   1. **Variant declaration trigger** — when a new variant is declared, emit
 *      `Decision: variant-substrate-cost-review` (catalog-routed, Engineering
 *      Authority reviewer, non-blocking per G0).
 *
 *   2. **Substrate-cost block** — when Engineering flags a substrate cost concern,
 *      emit `Decision: variant-substrate-cost-block` → routes to Design+Engineering
 *      via RFC-0029 actor model (operator resolves multi-pillar decision).
 *
 *   3. **Reviewer-subagent gate (AISDLC-298)** — given a set of PR-staged variant
 *      declarations and the Decision Catalog state, flag as `critical` any variant
 *      declaration that lacks a corresponding Engineering review Decision record.
 *      Composes with the AISDLC-298 code-reviewer / test-reviewer gate.
 *
 * All Decisions route through RFC-0035 G0 (non-blocking pipeline contract).
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md OQ-7
 * @see spec/rfcs/RFC-0035-decision-catalog-operator-routing.md G0 + §6.2
 * @see spec/rfcs/RFC-0029-product-pillar-architectural-vision.md actor model
 */

// ── Decision kinds ────────────────────────────────────────────────────────────

/**
 * Decision summary keys for Engineering review routing (OQ-7 resolution).
 */
export type EngineeringReviewDecisionKind =
  | 'variant-substrate-cost-review'
  | 'variant-substrate-cost-block';

// ── Input shapes ──────────────────────────────────────────────────────────────

/**
 * Minimal representation of a variant declaration triggering Engineering review.
 * Callers populate from the Soul DID's `spec.variants[]` entries being added
 * or modified in a PR diff.
 */
export interface VariantDeclarationForReview {
  /** Soul identifier (kebab-case). */
  soulId: string;
  /** Variant identifier (kebab-case). */
  variantId: string;
  /**
   * Design overrides declared on this variant. Used by Engineering to assess
   * substrate cost (e.g., new layout engine needed for a novel `densityProfile`).
   */
  designOverrides?: {
    colorPaletteOverlay?: string;
    densityProfile?: string;
    typographyScale?: string;
    motionProfile?: string;
    radiusProfile?: string;
    [vendorPrefixedKey: string]: string | undefined;
  };
  /** Optional substrate cost assessment from Engineering (when provided). */
  substrateCostAssessment?: {
    /** True when Engineering flags a substrate cost concern. */
    blocked: boolean;
    /** Engineering's rationale for the block (required when blocked: true). */
    rationale?: string;
    /** Estimated additional substrate cost (free-form — e.g., "2 new layout engine variants"). */
    estimatedCost?: string;
  };
}

// ── Output shapes ─────────────────────────────────────────────────────────────

/**
 * RFC-0035 Decision Catalog routing metadata for Engineering review events.
 * Always non-blocking per G0.
 */
export interface EngineeringReviewRouting {
  /** Always false — G0 non-blocking contract. */
  blocking: false;
  /** RFC-0029 pillar assignment for this Decision. */
  assignedPillar: 'engineering' | 'design-engineering-operator';
  /** RFC-0035 actor routing rubric outcome. */
  actorRationale: string;
}

/**
 * Engineering review Decision event for a single variant declaration.
 */
export interface VariantSubstrateCostReviewEvent {
  kind: 'variant-substrate-cost-review';
  soulId: string;
  variantId: string;
  /** RFC-3339 UTC timestamp. */
  timestamp: string;
  routing: EngineeringReviewRouting;
  message: string;
  designOverrides?: VariantDeclarationForReview['designOverrides'];
}

/**
 * Substrate-cost block Decision event — routes to Design+Engineering operator.
 */
export interface VariantSubstrateCostBlockEvent {
  kind: 'variant-substrate-cost-block';
  soulId: string;
  variantId: string;
  timestamp: string;
  routing: EngineeringReviewRouting;
  /** Engineering's blocking rationale. */
  rationale: string;
  estimatedCost?: string;
  message: string;
}

export type EngineeringReviewEvent =
  | VariantSubstrateCostReviewEvent
  | VariantSubstrateCostBlockEvent;

// ── Reviewer-gate flag ────────────────────────────────────────────────────────

/**
 * Reviewer-subagent gate flag per AISDLC-298.
 *
 * When a PR contains variant declarations that lack a corresponding
 * `variant-substrate-cost-review` Decision record in the catalog,
 * the reviewer-subagent gate flags them as `critical`.
 */
export interface MissingEngineeringReviewFlag {
  severity: 'critical';
  soulId: string;
  variantId: string;
  message: string;
}

/**
 * Input for the reviewer-subagent gate check (AC #7).
 */
export interface ReviewerGateCheckInput {
  /** Variant declarations staged in the PR being reviewed. */
  stagedVariants: Array<{ soulId: string; variantId: string }>;
  /**
   * Decision Catalog summaries present for this workspace.
   * Each entry is a (soulId, variantId) pair for which a
   * `variant-substrate-cost-review` Decision exists.
   *
   * Callers populate this from the Decision Catalog event log
   * projected state — specifically the set of `variant-substrate-cost-review`
   * events whose lifecycle is `open` or `answered`.
   */
  existingReviewDecisions: Array<{ soulId: string; variantId: string }>;
}

/**
 * Result of the reviewer-subagent gate check.
 */
export interface ReviewerGateCheckResult {
  /** Flags for variant declarations missing Engineering review Decisions. */
  flags: MissingEngineeringReviewFlag[];
  /** True when at least one critical flag was emitted (reviewer blocks). */
  hasCriticalFlags: boolean;
}

// ── Event factories ───────────────────────────────────────────────────────────

function makeCostReviewEvent(
  declaration: VariantDeclarationForReview,
  now: string,
): VariantSubstrateCostReviewEvent {
  return {
    kind: 'variant-substrate-cost-review',
    soulId: declaration.soulId,
    variantId: declaration.variantId,
    timestamp: now,
    routing: {
      blocking: false,
      assignedPillar: 'engineering',
      actorRationale:
        'OQ-7 resolution: Design owns variant declaration; Engineering reviews substrate cost ' +
        'via Decision Catalog (single-pillar Engineering decision — RFC-0029 Principle 1 + ' +
        'RFC-0035 §6.2 single-pillar → pillar owner routing).',
    },
    message:
      `Variant '${declaration.variantId}' on soul '${declaration.soulId}' declared. ` +
      `Decision: variant-substrate-cost-review → Engineering Authority review via catalog ` +
      `(RFC-0017 OQ-7; RFC-0035 G0 non-blocking).`,
    designOverrides: declaration.designOverrides,
  };
}

function makeCostBlockEvent(
  declaration: VariantDeclarationForReview,
  assessment: NonNullable<VariantDeclarationForReview['substrateCostAssessment']>,
  now: string,
): VariantSubstrateCostBlockEvent {
  return {
    kind: 'variant-substrate-cost-block',
    soulId: declaration.soulId,
    variantId: declaration.variantId,
    timestamp: now,
    routing: {
      blocking: false,
      assignedPillar: 'design-engineering-operator',
      actorRationale:
        'OQ-7 resolution: Substrate-cost block → multi-pillar decision (Design + Engineering). ' +
        'RFC-0029 actor model: cross-pillar decisions route to operator. ' +
        'RFC-0035 §6.2: multi-pillar → operator with escalation note.',
    },
    rationale: assessment.rationale ?? 'Engineering flagged substrate cost concern.',
    estimatedCost: assessment.estimatedCost,
    message:
      `Engineering substrate-cost block on variant '${declaration.variantId}' (soul '${declaration.soulId}'). ` +
      `Decision: variant-substrate-cost-block → Design+Engineering routing per RFC-0029 actor model ` +
      `(RFC-0035 G0 — pipeline continues; operator resolves multi-pillar decision).`,
  };
}

// ── Main trigger function ─────────────────────────────────────────────────────

/**
 * Emit Engineering review Decisions for a set of new/modified variant declarations.
 *
 * For each declaration:
 *   - Always emits `variant-substrate-cost-review` (non-blocking catalog log).
 *   - If `substrateCostAssessment.blocked === true`, additionally emits
 *     `variant-substrate-cost-block` (multi-pillar Design+Engineering routing).
 *
 * Per RFC-0035 G0: all emitted events have `blocking: false`. The pipeline
 * continues regardless of Engineering's assessment — operator resolves via catalog.
 *
 * @param declarations - Variant declarations to trigger review for.
 * @param now          - Injectable wall-clock for tests.
 * @param emitDecision - Optional callback for each emitted event. Errors propagate.
 */
export function triggerEngineeringReview(
  declarations: VariantDeclarationForReview[],
  now: Date = new Date(),
  emitDecision?: (event: EngineeringReviewEvent) => void,
): EngineeringReviewEvent[] {
  const nowStr = now.toISOString();
  const events: EngineeringReviewEvent[] = [];

  for (const declaration of declarations) {
    // Always emit cost-review Decision (OQ-7 primary routing)
    const reviewEvent = makeCostReviewEvent(declaration, nowStr);
    events.push(reviewEvent);
    if (emitDecision) emitDecision(reviewEvent);

    // Conditionally emit substrate-cost-block (OQ-7 block path)
    const assessment = declaration.substrateCostAssessment;
    if (assessment?.blocked === true) {
      const blockEvent = makeCostBlockEvent(declaration, assessment, nowStr);
      events.push(blockEvent);
      if (emitDecision) emitDecision(blockEvent);
    }
  }

  return events;
}

// ── Reviewer-subagent gate (AISDLC-298 composition) ─────────────────────────

/**
 * Check whether PR-staged variant declarations have corresponding Engineering
 * review Decisions in the catalog (AISDLC-298 reviewer-subagent gate, AC #7).
 *
 * Returns a `critical` flag for every staged variant that lacks a
 * `variant-substrate-cost-review` Decision record.
 *
 * **Composition with AISDLC-298:**
 * The `code-reviewer` and `test-reviewer` subagents invoke this check for every
 * PR diff containing variant declarations. A `hasCriticalFlags: true` result
 * BLOCKS the reviewer from approving — variant declarations without Engineering
 * review are treated as equivalent to "scope-creep candidate" per AISDLC-308.
 *
 * @param input - Staged variants + existing review Decisions from the catalog.
 */
export function checkReviewerGate(input: ReviewerGateCheckInput): ReviewerGateCheckResult {
  const flags: MissingEngineeringReviewFlag[] = [];

  for (const staged of input.stagedVariants) {
    const hasReview = input.existingReviewDecisions.some(
      (d) => d.soulId === staged.soulId && d.variantId === staged.variantId,
    );
    if (!hasReview) {
      flags.push({
        severity: 'critical',
        soulId: staged.soulId,
        variantId: staged.variantId,
        message:
          `Variant '${staged.variantId}' on soul '${staged.soulId}' was declared in this PR ` +
          `without a corresponding 'variant-substrate-cost-review' Decision in the catalog. ` +
          `Per RFC-0017 OQ-7 + AISDLC-298: Engineering review via Decision Catalog is required ` +
          `for all variant declarations. File the Decision before merging.`,
      });
    }
  }

  return { flags, hasCriticalFlags: flags.length > 0 };
}
