/**
 * RFC-0017 Phase 4 — InternalAdopter reference impl validation tests
 * (AISDLC-437).
 *
 * Coverage map:
 *   - AC #1 ProductA ships small-utility / enterprise / county-regional
 *   - AC #2 ProductB ships field-tech-on-truck / field-tech-handheld /
 *           supervisor-tablet
 *   - AC #3 ProductC ships billing-clerk / customer-portal / csr-dashboard
 *   - AC #4 ProductD scope removed (no ProductD entry in the catalog;
 *           documented in `products.ts` header)
 *   - AC #5 Each variant has ≤ 5 designImperatives (closed-enum discipline)
 *   - AC #7 Substrate shared across all variants of each Soul (substrate
 *           reference equality across all product entries)
 *
 * AC #6 (admission scoring spot-check) lives in
 * `./admission-spotcheck.test.ts`.
 *
 * AC #8 (end-to-end deprecation lifecycle) lives in
 * `./deprecation-lifecycle.test.ts`.
 */

import { describe, it, expect } from 'vitest';

import {
  INTERNAL_ADOPTER_PRODUCTS,
  INTERNAL_ADOPTER_SUBSTRATE,
  buildVariantsBySoul,
  productA,
  productB,
  productC,
} from './products.js';
import { validateVariantDeclarations, hasBlockingViolations } from '../inheritance-validator.js';

// ── AC #1, #2, #3: variant declarations per product ──────────────────────────

describe('InternalAdopter reference impl — product/variant declarations', () => {
  it('exports exactly three products (ProductD deferred to RFC-0018 per §11 v0.4)', () => {
    // AC #4 — ProductD removal is enforced structurally by the catalog length.
    expect(INTERNAL_ADOPTER_PRODUCTS).toHaveLength(3);
    expect(INTERNAL_ADOPTER_PRODUCTS.map((p) => p.soulId)).toEqual([
      'product-a',
      'product-b',
      'product-c',
    ]);
  });

  it('AC #1: ProductA declares small-utility / enterprise / county-regional', () => {
    expect(productA.soulId).toBe('product-a');
    expect(productA.variants.map((v) => v.id)).toEqual([
      'small-utility',
      'enterprise',
      'county-regional',
    ]);
  });

  it('AC #2: ProductB declares field-tech-on-truck / field-tech-handheld / supervisor-tablet', () => {
    expect(productB.soulId).toBe('product-b');
    expect(productB.variants.map((v) => v.id)).toEqual([
      'field-tech-on-truck',
      'field-tech-handheld',
      'supervisor-tablet',
    ]);
  });

  it('AC #3: ProductC declares billing-clerk / customer-portal / csr-dashboard', () => {
    expect(productC.soulId).toBe('product-c');
    expect(productC.variants.map((v) => v.id)).toEqual([
      'billing-clerk',
      'customer-portal',
      'csr-dashboard',
    ]);
  });

  it('every variant id is kebab-case (matches RFC-0017 §6.1 schema pattern)', () => {
    const kebab = /^[a-z][a-z0-9-]*$/;
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      for (const variant of product.variants) {
        expect(variant.id, `${product.soulId}/${variant.id}`).toMatch(kebab);
      }
    }
  });

  it('every variant id is unique within its parent soul (RFC-0017 §6.1)', () => {
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      const ids = product.variants.map((v) => v.id);
      expect(new Set(ids).size, `${product.soulId} duplicate ids`).toBe(ids.length);
    }
  });
});

// ── AC #5: closed-enum discipline (≤ 5 designImperatives) ────────────────────

describe('InternalAdopter reference impl — designImperatives discipline (AC #5)', () => {
  for (const product of INTERNAL_ADOPTER_PRODUCTS) {
    for (const variant of product.variants) {
      it(`${product.soulId}/${variant.id} declares ≤ 5 designImperatives`, () => {
        const count = variant.designImperatives?.length ?? 0;
        expect(
          count,
          `imperatives: ${JSON.stringify(variant.designImperatives)}`,
        ).toBeLessThanOrEqual(5);
      });

      it(`${product.soulId}/${variant.id} declares ≥ 1 designImperative (intent is articulable)`, () => {
        const count = variant.designImperatives?.length ?? 0;
        expect(count).toBeGreaterThanOrEqual(1);
      });
    }
  }

  it('no variant uses designOverridesExt (framework enum sufficient for the reference impl)', () => {
    // The reference impl deliberately exercises the framework enum only —
    // the vendor-prefix extension path (OQ-5) is validated elsewhere
    // (variant-admission.test.ts). Keeping the reference impl free of
    // vendor-prefixed fields documents that the framework enum is
    // sufficient for real practitioner needs (AC #5 closed-enum discipline).
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      for (const variant of product.variants) {
        expect(
          variant.designOverridesExt,
          `${product.soulId}/${variant.id} unexpectedly uses designOverridesExt`,
        ).toBeUndefined();
      }
    }
  });

  it('every designOverrides field is a framework-owned enum (RFC-0017 §6.1 OQ-5 revisit)', () => {
    const allowed = new Set([
      'colorPaletteOverlay',
      'densityProfile',
      'typographyScale',
      'motionProfile',
      'radiusProfile',
    ]);
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      for (const variant of product.variants) {
        for (const key of Object.keys(variant.designOverrides ?? {})) {
          expect(
            allowed.has(key),
            `${product.soulId}/${variant.id} uses non-framework field '${key}'`,
          ).toBe(true);
        }
      }
    }
  });
});

// ── AC #7: substrate shared across variants of each product ──────────────────

describe('InternalAdopter reference impl — substrate sharing (AC #7)', () => {
  it('all three products reference the SAME substrate object (identity check)', () => {
    // The strongest possible form of "substrate shared" — every product
    // points at the same in-memory reference. Engineering review can
    // statically confirm AC #7 by reading this single assertion.
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      expect(product.substrate, `${product.soulId}`).toBe(INTERNAL_ADOPTER_SUBSTRATE);
    }
  });

  it('every variant of every product inherits WCAG-2.1-AA (compliance floor locked)', () => {
    // RFC-0017 §5.3 inheritance table: complianceRegimes is INHERITED-LOCKED.
    // Variants cannot override; the reference impl proves the inheritance
    // by NOT declaring complianceRegimes on any variant.
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      expect(product.substrate.complianceRegimes).toEqual(['WCAG-2.1-AA']);
      for (const variant of product.variants) {
        expect(
          (variant as unknown as Record<string, unknown>).complianceRegimes,
          `${product.soulId}/${variant.id} attempts to override complianceRegimes`,
        ).toBeUndefined();
      }
    }
  });

  it('no variant declares an inherited-locked field (RFC-0017 §5.3)', () => {
    // Defense-in-depth: run validateVariantDeclarations across all three
    // products. Any inheritance violation would surface here.
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      const events = validateVariantDeclarations({
        soulId: product.soulId,
        variants: product.variants.map((v) => ({ ...v })),
      });
      expect(
        hasBlockingViolations(events),
        `${product.soulId} has blocking violations: ${JSON.stringify(events)}`,
      ).toBe(false);
    }
  });

  it('all three products land under the OQ-1 soft-warn threshold (≤ 5 variants)', () => {
    for (const product of INTERNAL_ADOPTER_PRODUCTS) {
      // Three variants per product — comfortably under the soft-warn at 5
      // and hard-limit at 20 (RFC-0017 §10.1).
      expect(product.variants.length).toBeLessThanOrEqual(5);
    }
  });
});

// ── buildVariantsBySoul helper integration ───────────────────────────────────

describe('buildVariantsBySoul', () => {
  it('returns the three-product map keyed by soulId', () => {
    const map = buildVariantsBySoul();
    expect(Object.keys(map).sort()).toEqual(['product-a', 'product-b', 'product-c']);
    expect(map['product-a']).toHaveLength(3);
    expect(map['product-b']).toHaveLength(3);
    expect(map['product-c']).toHaveLength(3);
  });

  it('returns a shallow copy — callers cannot mutate the reference impl', () => {
    const map = buildVariantsBySoul();
    map['product-a'].push({ id: 'rogue-mutation' });
    // Re-read; original is untouched.
    expect(buildVariantsBySoul()['product-a']).toHaveLength(3);
  });
});
