/**
 * RFC-0017 Phase 4 — InternalAdopter admission scoring spot-check
 * (AISDLC-437 AC #6).
 *
 * Demonstrates the failure mode RFC-0017 §2 documents: when a soul has
 * multiple audience-specific variants, soul-aggregate Sα₂ scoring produces a
 * misallocation pattern — work that's variant-bounded gets scored against the
 * soul-aggregate design intent, which underweights the variant's specific
 * design imperatives.
 *
 * The spot-check exercises a representative work item ("small-utility
 * onboarding improvement") on ProductA. The variant-routed score is
 * compared against the soul-aggregate baseline; the variant-routed score MUST
 * differ from the baseline by ≥ 20% on both Sα₁ and Sα₂.
 *
 * **20% deviation threshold rationale (X parameter from the task body):**
 * RFC-0017 §11 leaves "X%" unresolved at the spec level. The 20% floor is
 * chosen as a deviation that's:
 *
 *   - Large enough to be clearly meaningful, not measurement noise
 *   - Conservative — the reference impl is specifically constructed to show
 *     a much larger gap (≈70% on Sα₁ for the well-aligned variant), so 20%
 *     leaves headroom for fixture-tuning without destabilising the test
 *   - Consistent with the Sα₂ Vibe Coherence calibration ranges documented
 *     in RFC-0008's PPA addendum (a 0.2 absolute delta on a [0,1] scale is
 *     a meaningful tier shift)
 *
 * If the variant-routed score for a well-aligned variant is NOT meaningfully
 * higher than soul-aggregate, the variant pattern provides no admission-scoring
 * benefit — the test should fail and either the fixture or the routing is
 * miscalibrated.
 */

import { describe, it, expect } from 'vitest';

import {
  buildVariantScores,
  buildVariantsBySoul,
  computeSoulAggregateBaseline,
} from './products.js';
import { computeVariantScopedScores, type VariantContext } from '../../variant-admission.js';

// ── Threshold: variant-routed must differ from soul-aggregate by ≥ this ──────

/**
 * Minimum fractional deviation between variant-routed and soul-aggregate
 * scores for the spot-check to pass. See module header for rationale.
 */
const MIN_DEVIATION = 0.2;

/**
 * Representative work item ID for the spot-check. The task body cites
 * "small-utility onboarding improvement" — we use a stable AISDLC-shaped ID
 * so the fixture round-trips through the admission router's case-insensitive
 * lookup faithfully.
 */
const SPOTCHECK_WORK_ITEM_ID = 'AISDLC-SPOTCHECK-A1';

describe('InternalAdopter admission spot-check (AC #6)', () => {
  const variantsBySoul = buildVariantsBySoul();
  const variantScores = buildVariantScores();

  it('AC #6: variant-routed score for a well-aligned variant differs from soul-aggregate by ≥ 20%', () => {
    // Representative work item: a "small-utility onboarding improvement"
    // targets `product-a/small-utility` — the well-aligned variant.
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        { id: SPOTCHECK_WORK_ITEM_ID, targetedVariants: ['product-a/small-utility'] },
      ],
    };

    const baseline = computeSoulAggregateBaseline('product-a');
    const variantRouted = computeVariantScopedScores(
      SPOTCHECK_WORK_ITEM_ID,
      baseline.sa1, // fallback if no variant routing
      baseline.sa2,
      ctx,
    );

    // Sanity: the router took the single-variant path.
    expect(variantRouted.routingPath).toBe('single-variant');

    // The well-aligned variant scores HIGH; the baseline is the mean across
    // (high, low, low) — so the deviation should be positive AND meaningful.
    const sa1Deviation = Math.abs(variantRouted.sa1 - baseline.sa1) / baseline.sa1;
    const sa2Deviation = Math.abs(variantRouted.sa2 - baseline.sa2) / baseline.sa2;

    expect(
      sa1Deviation,
      `Sα₁ deviation ${(sa1Deviation * 100).toFixed(1)}% below ${MIN_DEVIATION * 100}% floor ` +
        `(variant=${variantRouted.sa1.toFixed(3)}, baseline=${baseline.sa1.toFixed(3)})`,
    ).toBeGreaterThanOrEqual(MIN_DEVIATION);

    expect(
      sa2Deviation,
      `Sα₂ deviation ${(sa2Deviation * 100).toFixed(1)}% below ${MIN_DEVIATION * 100}% floor ` +
        `(variant=${variantRouted.sa2.toFixed(3)}, baseline=${baseline.sa2.toFixed(3)})`,
    ).toBeGreaterThanOrEqual(MIN_DEVIATION);

    // Direction check — well-aligned variant MUST score HIGHER than aggregate.
    expect(variantRouted.sa1).toBeGreaterThan(baseline.sa1);
    expect(variantRouted.sa2).toBeGreaterThan(baseline.sa2);
  });

  it('AC #6: variant-routed score for a misaligned variant deviates DOWN from soul-aggregate', () => {
    // The complementary case: a work item that targets the MISALIGNED
    // variant (enterprise) on a small-utility-shaped concern should score
    // LOWER than the soul-aggregate baseline — soul-aggregate would
    // OVER-weight the work because it blends in the small-utility intent.
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        { id: 'AISDLC-SPOTCHECK-A2', targetedVariants: ['product-a/enterprise'] },
      ],
    };

    const baseline = computeSoulAggregateBaseline('product-a');
    const variantRouted = computeVariantScopedScores(
      'AISDLC-SPOTCHECK-A2',
      baseline.sa1,
      baseline.sa2,
      ctx,
    );

    expect(variantRouted.routingPath).toBe('single-variant');
    expect(variantRouted.sa1).toBeLessThan(baseline.sa1);
    expect(variantRouted.sa2).toBeLessThan(baseline.sa2);
  });

  it('AC #6: when no targetedVariants declared, the router falls back to soul-aggregate (backward-compat)', () => {
    // Defense-in-depth: confirm the spot-check fixture preserves backward-
    // compat for work items that don't declare targetedVariants — the
    // router MUST return the fallback values unchanged.
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [{ id: 'AISDLC-SPOTCHECK-A3', targetedVariants: [] }],
    };

    const baseline = computeSoulAggregateBaseline('product-a');
    const variantRouted = computeVariantScopedScores(
      'AISDLC-SPOTCHECK-A3',
      baseline.sa1,
      baseline.sa2,
      ctx,
    );

    expect(variantRouted.routingPath).toBe('no-variant-routing');
    expect(variantRouted.sa1).toBe(baseline.sa1);
    expect(variantRouted.sa2).toBe(baseline.sa2);
  });

  // ── Multi-variant cross-product spot-check (composes with §6.2 layering) ─

  it('AC #6: multi-variant targeting on ProductB applies min aggregation (OQ-4 default)', () => {
    // A ProductB work item that spans field-tech-on-truck + supervisor-tablet
    // should aggregate via `min` (the per-org default per OQ-4 + RFC-0009 §7.2).
    // Per the buildVariantScores fixture: field-tech-on-truck=0.9/0.85,
    // supervisor-tablet=0.3/0.35 → min=0.3/0.35.
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        {
          id: 'AISDLC-SPOTCHECK-B1',
          targetedVariants: ['product-b/field-tech-on-truck', 'product-b/supervisor-tablet'],
        },
      ],
    };

    const baseline = computeSoulAggregateBaseline('product-b');
    const variantRouted = computeVariantScopedScores(
      'AISDLC-SPOTCHECK-B1',
      baseline.sa1,
      baseline.sa2,
      ctx,
    );

    expect(variantRouted.routingPath).toBe('multi-variant');
    expect(variantRouted.aggregationRule).toBe('min');
    expect(variantRouted.sa1).toBeCloseTo(0.3, 6);
    expect(variantRouted.sa2).toBeCloseTo(0.35, 6);
  });
});
