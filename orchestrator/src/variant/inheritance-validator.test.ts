/**
 * RFC-0017 Phase 1 — Inheritance validator unit tests.
 *
 * Covers AISDLC-435 acceptance criteria:
 *   AC #3: Inheritance validator emits VariantInheritanceViolation when substrate
 *          or compliance floor escape attempted.
 *   AC #4: Variant count soft warning at 5+ emits Decision: variant-count-soft-warning (non-blocking).
 *   AC #5: Variant count hard limit at 20+ rejects + emits Decision: variant-count-hard-limit-exceeded.
 *   AC #6: Nested variants[] rejected at schema validation (OQ-2 schema-enforced flat).
 *   AC #8: Unit tests for all validation paths + per-org override.
 */

import { describe, it, expect } from 'vitest';

import {
  validateVariantDeclarations,
  hasBlockingViolations,
  DEFAULT_SOFT_WARN_AT,
  DEFAULT_HARD_LIMIT,
  INHERITED_LOCKED_FIELDS,
  type VariantDeclarationInput,
} from './inheritance-validator.js';

// ── Helper factories ────────────────────────────────────────────────────────

const FIXED_TS = '2026-05-26T00:00:00.000Z';

/** Minimal valid variant declaration. */
function makeVariant(id: string, overrides: Record<string, unknown> = {}): VariantDeclarationInput {
  return {
    id,
    targetAudience: { segments: ['test-segment'] },
    complianceFloor: 'inherit',
    ...overrides,
  };
}

/** Build an array of N valid variants. */
function makeVariants(n: number): VariantDeclarationInput[] {
  return Array.from({ length: n }, (_, i) => makeVariant(`variant-${i + 1}`));
}

// ── AC #3: Inheritance violation detection ──────────────────────────────────

describe('validateVariantDeclarations — inheritance violations (AC #3)', () => {
  it('emits no events for clean variant declarations', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('small-utility', {
          designOverrides: { densityProfile: 'comfortable' },
          designImperatives: ['low-tech-fluency-tolerance'],
        }),
      ],
      now: FIXED_TS,
    });

    expect(events).toHaveLength(0);
    expect(hasBlockingViolations(events)).toBe(false);
  });

  it('emits VariantInheritanceViolation when variant overrides complianceRegimes', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('bad-variant', {
          complianceRegimes: ['HIPAA'], // locked field — must inherit
        }),
      ],
      now: FIXED_TS,
    });

    const violation = events.find((e) => e.kind === 'VariantInheritanceViolation');
    expect(violation).toBeDefined();
    expect(violation?.blocking).toBe(true);
    if (violation?.kind === 'VariantInheritanceViolation') {
      expect(violation.variantId).toBe('bad-variant');
      expect(violation.field).toBe('complianceRegimes');
      expect(violation.message).toContain('complianceRegimes');
      expect(violation.message).toContain('inherited-and-locked');
    }
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('emits VariantInheritanceViolation when variant overrides substrateInvariants', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('bad-variant', {
          substrateInvariants: ['kafka-v2-required'],
        }),
      ],
      now: FIXED_TS,
    });

    const violation = events.find((e) => e.kind === 'VariantInheritanceViolation');
    expect(violation).toBeDefined();
    if (violation?.kind === 'VariantInheritanceViolation') {
      expect(violation.field).toBe('substrateInvariants');
      expect(violation.soulId).toBe('spry-engage');
    }
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('emits VariantInheritanceViolation when variant overrides performanceBudgets', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('bad-variant', {
          performanceBudgets: { p95: 200 },
        }),
      ],
      now: FIXED_TS,
    });

    const violations = events.filter((e) => e.kind === 'VariantInheritanceViolation');
    expect(violations).toHaveLength(1);
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('emits separate violation events for each locked field attempted', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('multi-violation', {
          complianceRegimes: ['GDPR'],
          substrateInvariants: ['some-invariant'],
          tenantQuotaShare: 0.5,
        }),
      ],
      now: FIXED_TS,
    });

    const violations = events.filter((e) => e.kind === 'VariantInheritanceViolation');
    expect(violations).toHaveLength(3);
    const fields = violations.map((v) =>
      v.kind === 'VariantInheritanceViolation' ? v.field : null,
    );
    expect(fields).toContain('complianceRegimes');
    expect(fields).toContain('substrateInvariants');
    expect(fields).toContain('tenantQuotaShare');
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('detects violations across ALL locked field names', () => {
    // Verify every locked field triggers a violation
    for (const field of INHERITED_LOCKED_FIELDS) {
      const events = validateVariantDeclarations({
        soulId: 'spry-engage',
        variants: [makeVariant('test-variant', { [field]: 'any-value' })],
        now: FIXED_TS,
      });
      const violations = events.filter((e) => e.kind === 'VariantInheritanceViolation');
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const matchingField = violations.find(
        (v) => v.kind === 'VariantInheritanceViolation' && v.field === field,
      );
      expect(matchingField).toBeDefined();
    }
  });

  it('includes soulId and timestamp in violation events', () => {
    const events = validateVariantDeclarations({
      soulId: 'my-soul',
      variants: [makeVariant('v1', { complianceRegimes: ['SOC2'] })],
      now: FIXED_TS,
    });
    const violation = events.find((e) => e.kind === 'VariantInheritanceViolation');
    expect(violation?.timestamp).toBe(FIXED_TS);
    if (violation?.kind === 'VariantInheritanceViolation') {
      expect(violation.soulId).toBe('my-soul');
    }
  });
});

// ── AC #4: Soft warn at 5+ variants ─────────────────────────────────────────

describe('validateVariantDeclarations — soft warning (AC #4)', () => {
  it('emits no warning below soft-warn threshold (4 variants)', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(4),
      now: FIXED_TS,
    });
    const warnings = events.filter((e) => e.kind === 'VariantCountSoftWarning');
    expect(warnings).toHaveLength(0);
  });

  it('emits non-blocking VariantCountSoftWarning at exactly softWarnAt (5 variants)', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(DEFAULT_SOFT_WARN_AT),
      now: FIXED_TS,
    });
    const warning = events.find((e) => e.kind === 'VariantCountSoftWarning');
    expect(warning).toBeDefined();
    expect(warning?.blocking).toBe(false);
    if (warning?.kind === 'VariantCountSoftWarning') {
      expect(warning.variantCount).toBe(DEFAULT_SOFT_WARN_AT);
      expect(warning.threshold).toBe(DEFAULT_SOFT_WARN_AT);
      expect(warning.message).toContain('variant-count-soft-warning');
      expect(warning.soulId).toBe('spry-engage');
    }
  });

  it('emits non-blocking soft warning at 7 variants', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(7),
      now: FIXED_TS,
    });
    const warning = events.find((e) => e.kind === 'VariantCountSoftWarning');
    expect(warning).toBeDefined();
    expect(warning?.blocking).toBe(false);
    // No hard limit exceeded
    expect(events.find((e) => e.kind === 'VariantCountHardLimitExceeded')).toBeUndefined();
  });

  it('does NOT block on soft warning — hasBlockingViolations returns false', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(DEFAULT_SOFT_WARN_AT),
      now: FIXED_TS,
    });
    expect(hasBlockingViolations(events)).toBe(false);
  });

  it('respects per-org softWarnAt override', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(3),
      limits: { softWarnAt: 3, hardLimit: 30 },
      now: FIXED_TS,
    });
    const warning = events.find((e) => e.kind === 'VariantCountSoftWarning');
    expect(warning).toBeDefined();
    if (warning?.kind === 'VariantCountSoftWarning') {
      expect(warning.threshold).toBe(3);
    }
  });
});

// ── AC #5: Hard limit at 20+ variants ───────────────────────────────────────

describe('validateVariantDeclarations — hard limit (AC #5)', () => {
  it('emits no hard-limit event at 19 variants (just below)', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(19),
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'VariantCountHardLimitExceeded')).toBeUndefined();
  });

  it('emits blocking VariantCountHardLimitExceeded at exactly hardLimit (20 variants)', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(DEFAULT_HARD_LIMIT),
      now: FIXED_TS,
    });
    const exceeded = events.find((e) => e.kind === 'VariantCountHardLimitExceeded');
    expect(exceeded).toBeDefined();
    expect(exceeded?.blocking).toBe(true);
    if (exceeded?.kind === 'VariantCountHardLimitExceeded') {
      expect(exceeded.variantCount).toBe(DEFAULT_HARD_LIMIT);
      expect(exceeded.limit).toBe(DEFAULT_HARD_LIMIT);
      expect(exceeded.message).toContain('variant-count-hard-limit-exceeded');
      expect(exceeded.message).toContain('re-architecting');
      expect(exceeded.soulId).toBe('spry-engage');
    }
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('emits hard-limit event at 25 variants (above limit)', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(25),
      now: FIXED_TS,
    });
    const exceeded = events.find((e) => e.kind === 'VariantCountHardLimitExceeded');
    expect(exceeded).toBeDefined();
    // No soft-warn — hard limit takes precedence
    expect(events.find((e) => e.kind === 'VariantCountSoftWarning')).toBeUndefined();
  });

  it('respects per-org hardLimit override', () => {
    const events = validateVariantDeclarations({
      soulId: 'marketplace-soul',
      variants: makeVariants(25),
      limits: { softWarnAt: 5, hardLimit: 30 },
      now: FIXED_TS,
    });
    // Below custom hardLimit=30, so no hard-limit event
    expect(events.find((e) => e.kind === 'VariantCountHardLimitExceeded')).toBeUndefined();
    // But soft warn fires
    expect(events.find((e) => e.kind === 'VariantCountSoftWarning')).toBeDefined();
  });

  it('per-org hardLimit=30 blocks at 30', () => {
    const events = validateVariantDeclarations({
      soulId: 'marketplace-soul',
      variants: makeVariants(30),
      limits: { softWarnAt: 5, hardLimit: 30 },
      now: FIXED_TS,
    });
    const exceeded = events.find((e) => e.kind === 'VariantCountHardLimitExceeded');
    expect(exceeded).toBeDefined();
    if (exceeded?.kind === 'VariantCountHardLimitExceeded') {
      expect(exceeded.limit).toBe(30);
    }
    expect(hasBlockingViolations(events)).toBe(true);
  });
});

// ── AC #6: Nested variants rejected (OQ-2) ──────────────────────────────────

describe('validateVariantDeclarations — nested variants rejection (AC #6)', () => {
  it('emits NestedVariantRejected when a variant contains a nested variants[] field', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('small-utility', {
          variants: [{ id: 'sub-variant', complianceFloor: 'inherit' }], // FORBIDDEN
        }),
      ],
      now: FIXED_TS,
    });

    const rejected = events.find((e) => e.kind === 'NestedVariantRejected');
    expect(rejected).toBeDefined();
    expect(rejected?.blocking).toBe(true);
    if (rejected?.kind === 'NestedVariantRejected') {
      expect(rejected.variantId).toBe('small-utility');
      expect(rejected.soulId).toBe('spry-engage');
      expect(rejected.message).toContain('nested');
      expect(rejected.message).toContain('sub-variants');
    }
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('does NOT emit NestedVariantRejected for variants with no nested variants field', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [makeVariant('clean-variant', { designImperatives: ['some-imperative'] })],
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'NestedVariantRejected')).toBeUndefined();
  });

  it('emits NestedVariantRejected for each variant that has nested variants', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [
        makeVariant('v1', { variants: [{ id: 'sub-1' }] }),
        makeVariant('v2', {}), // clean
        makeVariant('v3', { variants: [] }), // empty nested array also rejected
      ],
      now: FIXED_TS,
    });
    const rejected = events.filter((e) => e.kind === 'NestedVariantRejected');
    expect(rejected).toHaveLength(2); // v1 and v3 both have the key
  });
});

// ── AC #8: Per-org override + combined scenarios ─────────────────────────────

describe('validateVariantDeclarations — per-org override + combined (AC #8)', () => {
  it('applies defaults when limits not provided', () => {
    // 5 clean variants — should trigger soft warn with default threshold
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(5),
      now: FIXED_TS,
    });
    const warning = events.find((e) => e.kind === 'VariantCountSoftWarning');
    expect(warning).toBeDefined();
    if (warning?.kind === 'VariantCountSoftWarning') {
      expect(warning.threshold).toBe(DEFAULT_SOFT_WARN_AT);
    }
  });

  it('combines inheritance violations AND soft-warn independently', () => {
    // 6 variants (soft-warn territory) where 1 has an inheritance violation
    const variantList = makeVariants(5);
    variantList.push(makeVariant('bad', { substrateInvariants: ['kafka-v2'] }));

    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: variantList,
      now: FIXED_TS,
    });

    // Soft warn fires (6 >= 5)
    expect(events.find((e) => e.kind === 'VariantCountSoftWarning')).toBeDefined();
    // Inheritance violation fires
    expect(events.find((e) => e.kind === 'VariantInheritanceViolation')).toBeDefined();
    // Overall: blocking because of the inheritance violation
    expect(hasBlockingViolations(events)).toBe(true);
  });

  it('returns empty events for empty variants array', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [],
      now: FIXED_TS,
    });
    expect(events).toHaveLength(0);
    expect(hasBlockingViolations(events)).toBe(false);
  });

  it('stamps events with the provided timestamp', () => {
    const ts = '2026-01-15T12:00:00.000Z';
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(DEFAULT_SOFT_WARN_AT),
      now: ts,
    });
    expect(events.every((e) => e.timestamp === ts)).toBe(true);
  });

  it('defaults timestamp to a non-empty ISO string when now not provided', () => {
    const before = Date.now();
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(5),
    });
    const after = Date.now();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const t = new Date(e.timestamp).getTime();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
  });

  it('handles variant with undefined id gracefully', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [{ id: undefined as unknown as string, complianceRegimes: ['GDPR'] }],
      now: FIXED_TS,
    });
    const violation = events.find((e) => e.kind === 'VariantInheritanceViolation');
    expect(violation).toBeDefined();
    if (violation?.kind === 'VariantInheritanceViolation') {
      expect(violation.variantId).toBe('<unknown>');
    }
  });
});

// ── hasBlockingViolations helper ─────────────────────────────────────────────

describe('hasBlockingViolations', () => {
  it('returns false for empty events array', () => {
    expect(hasBlockingViolations([])).toBe(false);
  });

  it('returns false when all events are non-blocking', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: makeVariants(DEFAULT_SOFT_WARN_AT),
      now: FIXED_TS,
    });
    // Only soft warn — non-blocking
    expect(hasBlockingViolations(events)).toBe(false);
  });

  it('returns true when any event is blocking', () => {
    const events = validateVariantDeclarations({
      soulId: 'spry-engage',
      variants: [makeVariant('v1', { complianceRegimes: ['GDPR'] })],
      now: FIXED_TS,
    });
    expect(hasBlockingViolations(events)).toBe(true);
  });
});
