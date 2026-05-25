/**
 * RFC-0017 Phase 2 — variant-scope admission router unit tests.
 *
 * Covers acceptance criteria from AISDLC-353:
 *   AC #1: Sα₁ scoring routes through variant `audienceCharacteristics` when
 *          `targetedVariants` declared
 *   AC #2: Sα₂ scoring routes through variant `designOverrides` (including
 *          vendor-prefixed adopter extensions per OQ-5)
 *   AC #3: Cross-variant aggregation: default `min`; per-Soul
 *          `crossVariantAggregation` override respected
 *   AC #4: Work items without `targetedVariants` score against soul-aggregate
 *          (backward-compat)
 *   AC #5: Unit tests: single-variant / multi-variant `min` / multi-variant
 *          `max` override / backward-compat
 *
 * AC #6 (integration test on a work item targeting an InternalAdopter variant)
 * is exercised in `admission-composite.test.ts` against the full composite.
 */

import { describe, it, expect } from 'vitest';

import {
  parseTargetedVariantRef,
  resolveTargetedVariants,
  applyCrossVariantRule,
  computeVariantScopedScores,
  defaultCrossSoulVariantRule,
  type VariantContext,
  type VariantOverlay,
} from './variant-admission.js';

// ── Fixture factories ───────────────────────────────────────────────────

function makeVariants(): Record<string, VariantOverlay[]> {
  return {
    'spry-engage': [
      {
        id: 'small-utility',
        audienceCharacteristics: {
          segments: ['municipal-small', 'water-district-small'],
          sizeRange: { minStaff: 1, maxStaff: 50 },
        },
        designOverrides: {
          voiceRegister: 'approachable-municipal',
          colorPaletteOverlay: 'small-utility-warm',
          densityProfile: 'comfortable',
        },
        designOverridesExt: {
          // Vendor-prefix per OQ-5
          'acme.com/accessibilityProfile': 'low-tech-fluency',
        },
        designImperatives: ['low-tech-fluency-tolerance', 'single-task-focus-per-screen'],
      },
      {
        id: 'enterprise',
        audienceCharacteristics: {
          segments: ['municipal-large', 'regional-utility'],
          sizeRange: { minStaff: 51, maxStaff: 5000 },
        },
        designOverrides: {
          voiceRegister: 'professional-administrative',
          colorPaletteOverlay: 'enterprise-cool',
          densityProfile: 'compact',
        },
        designImperatives: ['bulk-operation-efficiency', 'multi-tab-workflow-tolerance'],
      },
      {
        id: 'county-regional',
        audienceCharacteristics: {
          segments: ['county-government', 'regional-coordinator'],
          sizeRange: { minStaff: 20, maxStaff: 200 },
        },
        designOverrides: { voiceRegister: 'inter-agency-formal' },
      },
    ],
    'spry-billing': [
      {
        id: 'billing-clerk',
        audienceCharacteristics: { segments: ['billing-staff'] },
        designOverrides: { densityProfile: 'compact' },
      },
      {
        id: 'customer-portal',
        audienceCharacteristics: { segments: ['end-customer'] },
        designOverrides: { densityProfile: 'spacious' },
      },
    ],
  };
}

function makeVariantScores(): VariantContext['variantScores'] {
  return {
    'spry-engage': {
      'small-utility': { sa1: 0.9, sa2: 0.85 }, // high — well-aligned variant
      enterprise: { sa1: 0.4, sa2: 0.5 }, // medium-low — mismatch
      'county-regional': { sa1: 0.7, sa2: 0.65 },
    },
    'spry-billing': {
      'billing-clerk': { sa1: 0.8, sa2: 0.6 },
      'customer-portal': { sa1: 0.3, sa2: 0.4 },
    },
  };
}

// ── parseTargetedVariantRef ─────────────────────────────────────────────

describe('parseTargetedVariantRef', () => {
  it('parses slug-pair form (RFC-0017 §6.1 schema pattern)', () => {
    const result = parseTargetedVariantRef('spry-engage/small-utility');
    expect(result).toEqual({
      soulId: 'spry-engage',
      variantId: 'small-utility',
      raw: 'spry-engage/small-utility',
    });
  });

  it('parses full DID form (RFC-0017 OQ-6 URI)', () => {
    const result = parseTargetedVariantRef('did:platform-x:soul:spry-engage/variant:small-utility');
    expect(result).toEqual({
      soulId: 'spry-engage',
      variantId: 'small-utility',
      raw: 'did:platform-x:soul:spry-engage/variant:small-utility',
    });
  });

  it('returns undefined for malformed input (no slash)', () => {
    expect(parseTargetedVariantRef('spry-engage-small-utility')).toBeUndefined();
  });

  it('returns undefined for malformed input (slug violates pattern)', () => {
    expect(parseTargetedVariantRef('Spry-Engage/small-utility')).toBeUndefined(); // capital S
    expect(parseTargetedVariantRef('spry-engage/Small-Utility')).toBeUndefined();
    expect(parseTargetedVariantRef('1bad/start')).toBeUndefined(); // starts with digit
  });

  it('returns undefined for full-DID with malformed segments', () => {
    expect(
      parseTargetedVariantRef('did:platform-x:soul:Spry-Engage/variant:small-utility'),
    ).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseTargetedVariantRef('')).toBeUndefined();
  });
});

// ── resolveTargetedVariants ─────────────────────────────────────────────

describe('resolveTargetedVariants', () => {
  const variantsBySoul = makeVariants();

  it('AC #1: resolves a single declared variant', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['spry-engage/small-utility'] }],
    };
    const result = resolveTargetedVariants('AISDLC-313', ctx);
    expect(result).toEqual([
      { soulId: 'spry-engage', variantId: 'small-utility', raw: 'spry-engage/small-utility' },
    ]);
  });

  it('AC #1: is case-insensitive on work item ID lookup', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['spry-engage/small-utility'] }],
    };
    expect(resolveTargetedVariants('aisdlc-313', ctx)).toHaveLength(1);
  });

  it('AC #4: returns empty when work item has no targeting entry', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [{ id: 'AISDLC-100', targetedVariants: ['spry-engage/enterprise'] }],
    };
    expect(resolveTargetedVariants('AISDLC-999', ctx)).toEqual([]);
  });

  it('AC #4: returns empty when targetedVariants is empty', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: [] }],
    };
    expect(resolveTargetedVariants('AISDLC-313', ctx)).toEqual([]);
  });

  it('AC #4: returns empty when workItemTargeting is undefined', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
    };
    expect(resolveTargetedVariants('AISDLC-313', ctx)).toEqual([]);
  });

  it('AC #4: returns empty when variantCtx is undefined', () => {
    expect(resolveTargetedVariants('AISDLC-313', undefined)).toEqual([]);
  });

  it('filters out targeting entries whose Soul is unknown', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['unknown-soul/small-utility'] }],
    };
    expect(resolveTargetedVariants('AISDLC-313', ctx)).toEqual([]);
  });

  it('filters out targeting entries whose variantId is undeclared on the Soul', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [
        { id: 'AISDLC-313', targetedVariants: ['spry-engage/nonexistent-variant'] },
      ],
    };
    expect(resolveTargetedVariants('AISDLC-313', ctx)).toEqual([]);
  });

  it('AC #3: resolves multiple variants when work item targets several', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [
        {
          id: 'AISDLC-313',
          targetedVariants: ['spry-engage/small-utility', 'spry-engage/enterprise'],
        },
      ],
    };
    const result = resolveTargetedVariants('AISDLC-313', ctx);
    expect(result.map((r) => r.variantId)).toEqual(['small-utility', 'enterprise']);
  });

  it('AC #3: resolves cross-Soul variants when work item targets variants in multiple Souls', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [
        {
          id: 'AISDLC-cross',
          targetedVariants: ['spry-engage/small-utility', 'spry-billing/billing-clerk'],
        },
      ],
    };
    const result = resolveTargetedVariants('AISDLC-cross', ctx);
    expect(result.map((r) => `${r.soulId}/${r.variantId}`)).toEqual([
      'spry-engage/small-utility',
      'spry-billing/billing-clerk',
    ]);
  });

  it('accepts full-DID form alongside slug-pair form in targetedVariants', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: makeVariantScores(),
      workItemTargeting: [
        {
          id: 'AISDLC-mix',
          targetedVariants: [
            'did:platform-x:soul:spry-engage/variant:small-utility',
            'spry-billing/billing-clerk',
          ],
        },
      ],
    };
    const result = resolveTargetedVariants('AISDLC-mix', ctx);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.variantId).sort()).toEqual(['billing-clerk', 'small-utility']);
  });
});

// ── applyCrossVariantRule ───────────────────────────────────────────────

describe('applyCrossVariantRule', () => {
  it('AC #3: defaults to min when rule undefined', () => {
    expect(applyCrossVariantRule([0.9, 0.4, 0.7], undefined)).toBeCloseTo(0.4, 8);
  });

  it('AC #3: min returns lowest', () => {
    expect(applyCrossVariantRule([0.9, 0.4, 0.7], 'min')).toBeCloseTo(0.4, 8);
  });

  it('AC #3: max returns highest', () => {
    expect(applyCrossVariantRule([0.9, 0.4, 0.7], 'max')).toBeCloseTo(0.9, 8);
  });

  it('AC #3: mean returns arithmetic average', () => {
    expect(applyCrossVariantRule([0.9, 0.6, 0.3], 'mean')).toBeCloseTo(0.6, 8);
  });

  it('returns fallback when values empty', () => {
    expect(applyCrossVariantRule([], 'min', 0.42)).toBeCloseTo(0.42, 8);
  });

  it('returns the single value when only one supplied', () => {
    expect(applyCrossVariantRule([0.73], 'min')).toBeCloseTo(0.73, 8);
    expect(applyCrossVariantRule([0.73], 'max')).toBeCloseTo(0.73, 8);
    expect(applyCrossVariantRule([0.73], 'mean')).toBeCloseTo(0.73, 8);
  });
});

// ── computeVariantScopedScores ──────────────────────────────────────────

describe('computeVariantScopedScores', () => {
  const variantsBySoul = makeVariants();
  const variantScores = makeVariantScores();

  it('AC #4 [backward-compat]: returns fallback Sα₁/Sα₂ when variantCtx undefined', () => {
    const result = computeVariantScopedScores('AISDLC-313', 0.5, 0.6, undefined);
    expect(result.routingPath).toBe('no-variant-routing');
    expect(result.targetedVariants).toEqual([]);
    expect(result.sa1).toBeCloseTo(0.5, 8);
    expect(result.sa2).toBeCloseTo(0.6, 8);
  });

  it('AC #4 [backward-compat]: returns fallback when work item has no targeting', () => {
    const ctx: VariantContext = { variantsBySoul, variantScores };
    const result = computeVariantScopedScores('AISDLC-313', 0.5, 0.6, ctx);
    expect(result.routingPath).toBe('no-variant-routing');
    expect(result.sa1).toBeCloseTo(0.5, 8);
    expect(result.sa2).toBeCloseTo(0.6, 8);
  });

  it('AC #4 [backward-compat]: returns fallback when targetedVariants empty', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: [] }],
    };
    const result = computeVariantScopedScores('AISDLC-313', 0.5, 0.6, ctx);
    expect(result.routingPath).toBe('no-variant-routing');
  });

  it('AC #1 + AC #2 [single-variant]: per-variant Sα₁/Sα₂ replaces soul-aggregate', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['spry-engage/small-utility'] }],
    };
    // small-utility: sa1=0.9, sa2=0.85 — both higher than soul-aggregate 0.5
    const result = computeVariantScopedScores('AISDLC-313', 0.5, 0.5, ctx);
    expect(result.routingPath).toBe('single-variant');
    expect(result.targetedVariants).toHaveLength(1);
    expect(result.sa1).toBeCloseTo(0.9, 8);
    expect(result.sa2).toBeCloseTo(0.85, 8);
  });

  it('AC #1 [single-variant]: variant-scope reflects mismatched variant — lower scores', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['spry-engage/enterprise'] }],
    };
    // enterprise: sa1=0.4, sa2=0.5 — work item mismatched against this variant
    const result = computeVariantScopedScores('AISDLC-313', 0.7, 0.7, ctx);
    expect(result.routingPath).toBe('single-variant');
    expect(result.sa1).toBeCloseTo(0.4, 8);
    expect(result.sa2).toBeCloseTo(0.5, 8);
  });

  it('single-variant: falls back to soul-aggregate when variant has no precomputed scores', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: {}, // no precomputed scores for any variant
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['spry-engage/small-utility'] }],
    };
    const result = computeVariantScopedScores('AISDLC-313', 0.55, 0.65, ctx);
    expect(result.routingPath).toBe('single-variant');
    expect(result.sa1).toBeCloseTo(0.55, 8);
    expect(result.sa2).toBeCloseTo(0.65, 8);
  });

  it('AC #3 [multi-variant `min` default]: aggregates via min when no override', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        {
          id: 'AISDLC-313',
          targetedVariants: ['spry-engage/small-utility', 'spry-engage/enterprise'],
        },
      ],
    };
    // small-utility sa1=0.9, enterprise sa1=0.4 → min = 0.4
    // small-utility sa2=0.85, enterprise sa2=0.5 → min = 0.5
    const result = computeVariantScopedScores('AISDLC-313', 0.55, 0.6, ctx);
    expect(result.routingPath).toBe('multi-variant');
    expect(result.targetedVariants).toHaveLength(2);
    expect(result.aggregationRule).toBe('min');
    expect(result.sa1).toBeCloseTo(0.4, 8);
    expect(result.sa2).toBeCloseTo(0.5, 8);
  });

  it('AC #3 [multi-variant per-Soul `max` override]: uses max for that Soul', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        {
          id: 'AISDLC-313',
          targetedVariants: ['spry-engage/small-utility', 'spry-engage/enterprise'],
        },
      ],
      configBySoul: {
        'spry-engage': { crossVariantAggregation: 'max' },
      },
    };
    // small-utility sa1=0.9, enterprise sa1=0.4 → max = 0.9
    // small-utility sa2=0.85, enterprise sa2=0.5 → max = 0.85
    const result = computeVariantScopedScores('AISDLC-313', 0.55, 0.6, ctx);
    expect(result.routingPath).toBe('multi-variant');
    expect(result.aggregationRule).toBe('max');
    expect(result.sa1).toBeCloseTo(0.9, 8);
    expect(result.sa2).toBeCloseTo(0.85, 8);
  });

  it('AC #3 [multi-variant per-Soul `mean` override]: uses mean for that Soul', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        {
          id: 'AISDLC-313',
          targetedVariants: [
            'spry-engage/small-utility',
            'spry-engage/enterprise',
            'spry-engage/county-regional',
          ],
        },
      ],
      configBySoul: { 'spry-engage': { crossVariantAggregation: 'mean' } },
    };
    // sa1: (0.9 + 0.4 + 0.7) / 3 = 0.6667
    // sa2: (0.85 + 0.5 + 0.65) / 3 = 0.6667
    const result = computeVariantScopedScores('AISDLC-313', 0.5, 0.5, ctx);
    expect(result.routingPath).toBe('multi-variant');
    expect(result.aggregationRule).toBe('mean');
    expect(result.sa1).toBeCloseTo((0.9 + 0.4 + 0.7) / 3, 5);
    expect(result.sa2).toBeCloseTo((0.85 + 0.5 + 0.65) / 3, 5);
  });

  it('cross-Soul multi-variant: aggregates per-Soul, then `min` between Souls (§6.2)', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        {
          id: 'AISDLC-cross',
          targetedVariants: [
            // Soul spry-engage: small-utility (sa1=0.9) + enterprise (sa1=0.4) → min = 0.4
            'spry-engage/small-utility',
            'spry-engage/enterprise',
            // Soul spry-billing: billing-clerk only (sa1=0.8)
            'spry-billing/billing-clerk',
          ],
        },
      ],
      configBySoul: {
        'spry-engage': { crossVariantAggregation: 'min' },
        'spry-billing': { crossVariantAggregation: 'min' },
      },
    };
    const result = computeVariantScopedScores('AISDLC-cross', 0.55, 0.6, ctx);
    // Per-soul sa1: [0.4 (engage min), 0.8 (billing-clerk)] → cross-soul min = 0.4
    expect(result.routingPath).toBe('multi-variant');
    expect(result.sa1).toBeCloseTo(0.4, 8);
    // Per-soul sa2: [0.5 (engage min), 0.6 (billing-clerk)] → cross-soul min = 0.5
    expect(result.sa2).toBeCloseTo(0.5, 8);
  });

  it('cross-Soul multi-variant: per-Soul rule override respected (engage=max, billing=min)', () => {
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores,
      workItemTargeting: [
        {
          id: 'AISDLC-cross',
          targetedVariants: [
            'spry-engage/small-utility',
            'spry-engage/enterprise',
            'spry-billing/billing-clerk',
            'spry-billing/customer-portal',
          ],
        },
      ],
      configBySoul: {
        'spry-engage': { crossVariantAggregation: 'max' }, // engage: max → 0.9 / 0.85
        'spry-billing': { crossVariantAggregation: 'min' }, // billing: min → 0.3 / 0.4
      },
    };
    const result = computeVariantScopedScores('AISDLC-cross', 0.5, 0.5, ctx);
    expect(result.routingPath).toBe('multi-variant');
    // Per-soul sa1: [0.9 (engage max), 0.3 (billing min)] → cross-soul min = 0.3
    expect(result.sa1).toBeCloseTo(0.3, 8);
    // Per-soul sa2: [0.85 (engage max), 0.4 (billing min)] → cross-soul min = 0.4
    expect(result.sa2).toBeCloseTo(0.4, 8);
  });

  it('multi-variant: falls back per-variant when one variant has no precomputed score', () => {
    const partialScores = {
      'spry-engage': {
        'small-utility': { sa1: 0.9, sa2: 0.85 },
        // enterprise missing → falls back to fallbackSa1 (0.55) / fallbackSa2 (0.6)
      },
    };
    const ctx: VariantContext = {
      variantsBySoul,
      variantScores: partialScores,
      workItemTargeting: [
        {
          id: 'AISDLC-313',
          targetedVariants: ['spry-engage/small-utility', 'spry-engage/enterprise'],
        },
      ],
    };
    const result = computeVariantScopedScores('AISDLC-313', 0.55, 0.6, ctx);
    // sa1: min(0.9, 0.55) = 0.55
    expect(result.sa1).toBeCloseTo(0.55, 8);
    // sa2: min(0.85, 0.6) = 0.6
    expect(result.sa2).toBeCloseTo(0.6, 8);
  });

  it('AC #2 [vendor-prefix OQ-5]: vendor-prefix designOverridesExt does NOT throw', () => {
    // Validates that adopter-supplied vendor-prefix extension fields don't break
    // the router — they're carried on the VariantOverlay but only the per-variant
    // score (computed upstream by the Sα₂ scorer) is consumed here. This test
    // ensures the type carries the field shape and the router copes.
    const variantsWithExt = {
      'spry-engage': [
        {
          id: 'small-utility',
          audienceCharacteristics: { segments: ['municipal-small'] },
          designOverrides: { voiceRegister: 'approachable-municipal' },
          designOverridesExt: {
            'acme.com/accessibilityProfile': 'low-tech-fluency',
            'beta.org/legalDisclosureLevel': 2,
            'gamma.io/animationBudget': true,
          },
        },
      ],
    };
    const ctx: VariantContext = {
      variantsBySoul: variantsWithExt,
      variantScores: {
        'spry-engage': { 'small-utility': { sa1: 0.88, sa2: 0.77 } },
      },
      workItemTargeting: [{ id: 'AISDLC-313', targetedVariants: ['spry-engage/small-utility'] }],
    };
    const result = computeVariantScopedScores('AISDLC-313', 0.5, 0.5, ctx);
    expect(result.routingPath).toBe('single-variant');
    expect(result.sa1).toBeCloseTo(0.88, 8);
    expect(result.sa2).toBeCloseTo(0.77, 8);
  });
});

// ── defaultCrossSoulVariantRule ─────────────────────────────────────────

describe('defaultCrossSoulVariantRule', () => {
  it('returns min unconditionally (Phase 2 default)', () => {
    expect(defaultCrossSoulVariantRule()).toBe('min');
    expect(defaultCrossSoulVariantRule(undefined)).toBe('min');
    expect(
      defaultCrossSoulVariantRule({
        souls: [{ soulId: 'a', didUri: 'did:x:soul:a' }],
        crossSoulScoringRule: 'max',
      }),
    ).toBe('min');
  });
});
