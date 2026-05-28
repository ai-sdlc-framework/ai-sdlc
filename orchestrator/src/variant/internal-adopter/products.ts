/**
 * RFC-0017 Phase 4 — InternalAdopter three-product reference implementation
 * (AISDLC-437).
 *
 * Ships ProductA / ProductB / ProductC as canonical fixtures that demonstrate
 * the In-Soul Variant Pattern against real-world adopter constraints. Each
 * product is a distinct Soul on shared substrate; each declares three variants
 * with audience-segment / form-factor / role-based specialization.
 *
 * **ProductD is INTENTIONALLY OMITTED** — per RFC-0017 §11 v0.4 (2026-05-26
 * Design Authority editorial pass), ProductD's proposed variants
 * (`annual-test`, `repair-event`, `regulatory-audit-mode`) are temporal-context-
 * bound operational modes activated by *when* and *why* a user is in the
 * system. Same user, different operational moment = Journey shape (RFC-0018),
 * not Variant shape. ProductD's validation is deferred to RFC-0018 §11 as a
 * Variant/Journey boundary validation case for the companion RFC.
 *
 * Variant constraints validated by `products.test.ts`:
 *   - Every variant has ≤ 5 `designImperatives` strings (closed-enum discipline)
 *   - Every variant's `designOverrides` uses only framework-owned enum fields
 *     (`colorPaletteOverlay`, `densityProfile`, `typographyScale`,
 *     `motionProfile`, `radiusProfile` per §6.1 OQ-5 2026-05-26 revisit)
 *   - All variants of a given product share the same compliance + substrate
 *     (substrate-shared check, AC #7)
 *   - All variants pass `validateVariantDeclarations()` (no inheritance
 *     violations, no nested variants, under the soft-warn / hard-limit caps)
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md §11 (practitioner validation)
 * @see ./products.test.ts — substrate-shared + closed-enum + inheritance checks
 * @see ./admission-spotcheck.test.ts — variant-routed vs soul-aggregate scoring
 * @see ./deprecation-lifecycle.test.ts — end-to-end lifecycle on ProductA variant
 */

import type { VariantOverlay, VariantScores } from '../../variant-admission.js';

// ── Substrate contract (shared across all variants of all three products) ─────

/**
 * The shared substrate every InternalAdopter product Soul inherits.
 *
 * Per RFC-0017 §5.3 bounded-inheritance table: substrate fields are
 * INHERITED-AND-LOCKED — variants cannot override these. Capturing them here
 * in a single shared constant proves AC #7 (substrate shared across variants
 * of every product) at the type/declaration level rather than via runtime
 * spot-check alone.
 *
 * `complianceRegimes: ['WCAG-2.1-AA']` is the field-tech-deployed baseline
 * documented in RFC-0017 §1: "all sharing the soul's WCAG 2.1 AA compliance
 * floor and shared design system tokens."
 */
export interface InternalAdopterSubstrate {
  /** Compliance regimes inherited by every variant on every product. */
  readonly complianceRegimes: readonly string[];
  /**
   * Substrate invariants — event bus, schema, tenant model. Captured as an
   * opaque string identifier here; the reconciler is what proves substrate
   * sharing at runtime (per RFC-0017 §5.3 footnote).
   */
  readonly substrateInvariants: {
    readonly eventBus: string;
    readonly schemaRegistry: string;
    readonly tenantModel: string;
  };
  /** Engineering performance budgets shared across all variants. */
  readonly performanceBudgets: {
    readonly initialLoadMs: number;
    readonly interactionResponseMs: number;
  };
  /** Engineering observability requirements shared across all variants. */
  readonly observabilityRequirements: readonly string[];
}

/**
 * Canonical shared substrate for the InternalAdopter product suite.
 * Every ProductA/B/C variant inherits this identical block — substrate
 * sharing is enforced at the fixture level (AC #7).
 */
export const INTERNAL_ADOPTER_SUBSTRATE: InternalAdopterSubstrate = {
  complianceRegimes: ['WCAG-2.1-AA'],
  substrateInvariants: {
    eventBus: 'internal-adopter-kafka-v1',
    schemaRegistry: 'internal-adopter-schema-registry-v1',
    tenantModel: 'multi-tenant-row-isolation',
  },
  performanceBudgets: {
    initialLoadMs: 2500,
    interactionResponseMs: 100,
  },
  observabilityRequirements: ['otel-traces', 'structured-logs', 'rum-vitals'],
};

// ── Product Soul descriptor (the unit of substrate-sharing) ──────────────────

/**
 * A reference-impl Soul descriptor. Captures the inherited-locked substrate
 * separately from the variant overlays so AC #7 (substrate shared across
 * variants) is provable by structural inspection.
 *
 * This is NOT the full Soul DID schema (`reference/src/core/types.ts` carries
 * that). It's the minimum surface needed for the variant-pattern reference
 * impl — `soulId` + shared substrate + variant overlays.
 */
export interface InternalAdopterProduct {
  /** Soul identifier in kebab-case. */
  readonly soulId: string;
  /** Human-readable product description. */
  readonly description: string;
  /** What variant axis this product is validating per RFC-0017 §11. */
  readonly validationAxis: string;
  /** Shared substrate — identical reference across all three products (AC #7). */
  readonly substrate: InternalAdopterSubstrate;
  /** Variant overlays declared on this Soul (exactly 3 per RFC-0017 §11). */
  readonly variants: readonly VariantOverlay[];
  /**
   * Soul-level `designImperatives` — apply to all variants of this Soul
   * unless a variant overrides the same design dimension (variant-wins per
   * RFC-0017 §5.4). Captured here so the admission-spotcheck test can
   * compose soul-aggregate vs variant-routed scoring.
   */
  readonly soulDesignImperatives: readonly string[];
}

// ── ProductA — small-utility / enterprise / county-regional ──────────────────
//
// Validates audience-segment specialization across the v0.4 visual-token
// surface. The three variants serve dramatically different audience sizes
// + cognitive-load profiles on a shared substrate.

const PRODUCT_A: InternalAdopterProduct = {
  soulId: 'product-a',
  description:
    'Utility-operations management for water + electricity service providers. ' +
    'Validates audience-segment specialization (small ↔ enterprise ↔ county).',
  validationAxis: 'audience-segment specialization (RFC-0017 §11)',
  substrate: INTERNAL_ADOPTER_SUBSTRATE,
  soulDesignImperatives: ['compliance-first-information-architecture', 'audit-trail-visibility'],
  variants: [
    {
      id: 'small-utility',
      audienceCharacteristics: {
        segments: ['municipal-small', 'water-district-small'],
        sizeRange: { minStaff: 1, maxStaff: 50 },
      },
      designOverrides: {
        colorPaletteOverlay: 'small-utility-warm',
        densityProfile: 'comfortable',
        typographyScale: 'large-print',
        motionProfile: 'reduced',
        radiusProfile: 'rounded',
      },
      designImperatives: [
        'low-tech-fluency-tolerance',
        'single-task-focus-per-screen',
        'forgiving-error-recovery',
        'minimal-jargon',
      ],
    },
    {
      id: 'enterprise',
      audienceCharacteristics: {
        segments: ['municipal-large', 'regional-utility'],
        sizeRange: { minStaff: 51, maxStaff: 5000 },
      },
      designOverrides: {
        colorPaletteOverlay: 'enterprise-cool',
        densityProfile: 'compact',
        typographyScale: 'default',
        motionProfile: 'full',
        radiusProfile: 'default',
      },
      designImperatives: [
        'bulk-operation-efficiency',
        'multi-tab-workflow-tolerance',
        'keyboard-first-power-user-shortcuts',
        'dashboard-density-tolerance',
      ],
    },
    {
      id: 'county-regional',
      audienceCharacteristics: {
        segments: ['county-government', 'regional-coordinator'],
        sizeRange: { minStaff: 20, maxStaff: 200 },
      },
      designOverrides: {
        colorPaletteOverlay: 'county-civic',
        densityProfile: 'comfortable',
        typographyScale: 'default',
        motionProfile: 'reduced',
        radiusProfile: 'sharp',
      },
      designImperatives: [
        'cross-jurisdiction-reconciliation-clarity',
        'inter-agency-handoff-explicit',
        'official-record-defensibility',
      ],
    },
  ],
};

// ── ProductB — field-tech-on-truck / field-tech-handheld / supervisor-tablet ─
//
// Validates density profile + form-factor specialization. Same role (field
// operations) at different form-factors / contexts of use — density profile
// + motion + radius differ sharply across the three.

const PRODUCT_B: InternalAdopterProduct = {
  soulId: 'product-b',
  description:
    'Field-operations dispatch + workflow execution for utility field crews. ' +
    'Validates density profile + form-factor specialization.',
  validationAxis: 'density profile + form-factor specialization (RFC-0017 §11)',
  substrate: INTERNAL_ADOPTER_SUBSTRATE,
  soulDesignImperatives: ['offline-first-resilience', 'one-handed-operation-where-possible'],
  variants: [
    {
      id: 'field-tech-on-truck',
      audienceCharacteristics: {
        segments: ['field-crew-mounted', 'service-truck-operator'],
        sizeRange: { minStaff: 1, maxStaff: 4 },
      },
      designOverrides: {
        colorPaletteOverlay: 'high-contrast-outdoor',
        densityProfile: 'spacious',
        typographyScale: 'large-print',
        motionProfile: 'reduced',
        radiusProfile: 'rounded',
      },
      designImperatives: [
        'glanceable-from-driving-position',
        'glove-friendly-tap-targets',
        'sun-glare-readable-contrast',
        'cellular-degraded-graceful',
      ],
    },
    {
      id: 'field-tech-handheld',
      audienceCharacteristics: {
        segments: ['field-crew-handheld', 'meter-reader'],
        sizeRange: { minStaff: 1, maxStaff: 1 },
      },
      designOverrides: {
        colorPaletteOverlay: 'high-contrast-outdoor',
        densityProfile: 'comfortable',
        typographyScale: 'large-print',
        motionProfile: 'reduced',
        radiusProfile: 'rounded',
      },
      designImperatives: [
        'thumb-zone-reachability',
        'single-hand-operation',
        'rugged-conditions-tolerance',
        'barcode-scan-prominent',
      ],
    },
    {
      id: 'supervisor-tablet',
      audienceCharacteristics: {
        segments: ['field-supervisor', 'crew-dispatch-coordinator'],
        sizeRange: { minStaff: 1, maxStaff: 10 },
      },
      designOverrides: {
        colorPaletteOverlay: 'supervisor-default',
        densityProfile: 'compact',
        typographyScale: 'data-dense',
        motionProfile: 'full',
        radiusProfile: 'default',
      },
      designImperatives: [
        'multi-crew-overview-at-a-glance',
        'rapid-reassignment-workflow',
        'cross-crew-comparative-metrics',
        'two-handed-tablet-grip-affordance',
      ],
    },
  ],
};

// ── ProductC — billing-clerk / customer-portal / csr-dashboard ───────────────
//
// Validates role-based audience + workflow-density specialization. Same
// domain (billing) but radically different roles (internal staff vs end
// customer vs CSR) on shared substrate.

const PRODUCT_C: InternalAdopterProduct = {
  soulId: 'product-c',
  description:
    'Billing + customer-account management spanning internal staff, end customers, ' +
    'and customer-service representatives. Validates role-based audience + ' +
    'workflow-density specialization.',
  validationAxis: 'role-based audience + workflow-density specialization (RFC-0017 §11)',
  substrate: INTERNAL_ADOPTER_SUBSTRATE,
  soulDesignImperatives: ['financial-accuracy-first', 'data-provenance-traceable'],
  variants: [
    {
      id: 'billing-clerk',
      audienceCharacteristics: {
        segments: ['billing-staff', 'accounts-receivable'],
        sizeRange: { minStaff: 1, maxStaff: 20 },
      },
      designOverrides: {
        colorPaletteOverlay: 'billing-staff-neutral',
        densityProfile: 'compact',
        typographyScale: 'data-dense',
        motionProfile: 'reduced',
        radiusProfile: 'sharp',
      },
      designImperatives: [
        'bulk-edit-efficiency',
        'keyboard-numpad-optimized',
        'audit-log-always-visible',
        'reconciliation-discrepancy-prominent',
      ],
    },
    {
      id: 'customer-portal',
      audienceCharacteristics: {
        segments: ['end-customer', 'self-service-billpayer'],
        sizeRange: { minStaff: 1, maxStaff: 1 },
      },
      designOverrides: {
        colorPaletteOverlay: 'customer-portal-friendly',
        densityProfile: 'spacious',
        typographyScale: 'default',
        motionProfile: 'full',
        radiusProfile: 'rounded',
      },
      designImperatives: [
        'plain-language-no-jargon',
        'self-service-task-completion-clarity',
        'mobile-first-responsive',
        'trust-signal-prominent',
      ],
    },
    {
      id: 'csr-dashboard',
      audienceCharacteristics: {
        segments: ['customer-service-representative', 'call-center-agent'],
        sizeRange: { minStaff: 5, maxStaff: 500 },
      },
      designOverrides: {
        colorPaletteOverlay: 'csr-action-oriented',
        densityProfile: 'compact',
        typographyScale: 'data-dense',
        motionProfile: 'full',
        radiusProfile: 'default',
      },
      designImperatives: [
        'caller-context-instantly-loaded',
        'quick-resolution-workflow',
        'sentiment-aware-prompts',
        'screen-pop-integration',
      ],
    },
  ],
};

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * The three InternalAdopter products — ProductA / ProductB / ProductC.
 * ProductD is intentionally omitted per RFC-0017 §11 v0.4 (deferred to
 * RFC-0018 §11 — temporal-context-bound modes are Journey shape, not Variant).
 */
export const INTERNAL_ADOPTER_PRODUCTS: readonly InternalAdopterProduct[] = [
  PRODUCT_A,
  PRODUCT_B,
  PRODUCT_C,
];

/** Individual product accessors for direct consumption by tests / tooling. */
export const productA = PRODUCT_A;
export const productB = PRODUCT_B;
export const productC = PRODUCT_C;

/**
 * Build a `variantsBySoul` map suitable for `VariantContext`, derived from
 * the three product declarations. Test helper + the canonical shape callers
 * use to wire the reference impl into the admission composite.
 */
export function buildVariantsBySoul(): Record<string, VariantOverlay[]> {
  const out: Record<string, VariantOverlay[]> = {};
  for (const product of INTERNAL_ADOPTER_PRODUCTS) {
    out[product.soulId] = product.variants.map((v) => ({ ...v }));
  }
  return out;
}

/**
 * Build a representative `variantScores` map for spot-check admission scoring.
 *
 * Score shape: each variant gets `sa1` and `sa2` numbers in [0, 1].
 * Per-variant scores are chosen to demonstrate that **variant-routed scoring
 * differs from soul-aggregate scoring on a representative work item** (AC #6):
 *
 *   - The "well-aligned" variant for a given work item scores HIGH (sa1=0.92,
 *     sa2=0.88).
 *   - The "misaligned" variants score LOW (sa1=0.30-0.40, sa2=0.35-0.45).
 *
 * If the same work item were scored at soul-aggregate scope, the average of
 * its variants would compress to a middling value (sa1≈0.54, sa2≈0.56) —
 * the variant-routed score for the well-aligned variant is meaningfully
 * different (≈ +70% on sa1, +57% on sa2). This is the failure mode RFC-0017
 * §2 documents: soul-aggregate scoring underweights variant-specific intent.
 *
 * The spot-check test in `admission-spotcheck.test.ts` exercises this against
 * a representative ProductA work item ("small-utility onboarding improvement").
 */
export function buildVariantScores(): Record<string, Record<string, VariantScores>> {
  return {
    'product-a': {
      'small-utility': { sa1: 0.92, sa2: 0.88 },
      enterprise: { sa1: 0.35, sa2: 0.4 },
      'county-regional': { sa1: 0.4, sa2: 0.45 },
    },
    'product-b': {
      'field-tech-on-truck': { sa1: 0.9, sa2: 0.85 },
      'field-tech-handheld': { sa1: 0.6, sa2: 0.55 },
      'supervisor-tablet': { sa1: 0.3, sa2: 0.35 },
    },
    'product-c': {
      'billing-clerk': { sa1: 0.88, sa2: 0.82 },
      'customer-portal': { sa1: 0.3, sa2: 0.35 },
      'csr-dashboard': { sa1: 0.55, sa2: 0.6 },
    },
  };
}

/**
 * Soul-aggregate Sα₁ / Sα₂ baseline for a given Soul, computed by averaging
 * the per-variant scores from `buildVariantScores()`. Used by the spot-check
 * test to demonstrate that variant-routed scoring meaningfully deviates from
 * the soul-aggregate baseline (AC #6).
 *
 * The aggregation rule used here is `mean` — chosen because the failure mode
 * documented in RFC-0017 §2 is the SMOOTHING/AVERAGING effect of soul-aggregate
 * Sα₂ scoring across heterogeneous variants. Comparing variant-routed to mean
 * is what shows the misallocation pattern. (The admission composite itself
 * uses `min` per OQ-4, but that's a different question — we're showing that
 * the per-variant view is structurally different from any soul-level aggregate.)
 */
export function computeSoulAggregateBaseline(soulId: string): {
  sa1: number;
  sa2: number;
} {
  const scores = buildVariantScores()[soulId];
  if (!scores) {
    throw new Error(
      `[internal-adopter] no variant scores for soul '${soulId}' — ` +
        `known soulIds: ${INTERNAL_ADOPTER_PRODUCTS.map((p) => p.soulId).join(', ')}`,
    );
  }
  const variants = Object.values(scores);
  const sa1 = variants.reduce((s, v) => s + v.sa1, 0) / variants.length;
  const sa2 = variants.reduce((s, v) => s + v.sa2, 0) / variants.length;
  return { sa1, sa2 };
}
