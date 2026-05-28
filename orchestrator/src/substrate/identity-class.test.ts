/**
 * Hermetic tests for the canonical `identityClass` taxonomy module.
 *
 * Coverage:
 *   - Taxonomy enumeration matches RFC-0028 §7.1 v0.2 resolution exactly.
 *   - Bucket assignments resolve to the expected `core` / `evolving` class.
 *   - Novel-field default behavior — defaults to `core`, fires warning hook.
 *   - Tightening-only enforcement — `LockedBoolean` rejects `false` at the
 *     type level (compile-time assertion via `@ts-expect-error`); numeric cap
 *     tightening throws when loosened; categorical tightening narrows union.
 *   - Audit emits a discrepancy for the `did-compiler.ts` default-evolving vs
 *     canonical default-core mismatch.
 */

import { describe, it, expect } from 'vitest';
import {
  IDENTITY_CLASSES,
  CORE_BUCKET,
  EVOLVING_BUCKET,
  CANONICAL_FIELD_CLASSIFICATIONS,
  defaultIdentityClassForNovelField,
  assertTightenedCap,
  auditLayer1DeterministicClassifications,
  IdentityClassError,
  type IdentityClass,
  type LockedBoolean,
  type BoundedNumericCap,
  type TightenedCategorical,
} from './identity-class.js';

describe('identityClass taxonomy enumeration', () => {
  it('exposes exactly two buckets: core and evolving', () => {
    expect(IDENTITY_CLASSES).toEqual(['core', 'evolving']);
  });

  it('every CORE_BUCKET field resolves to "core" in the lookup table', () => {
    for (const fields of Object.values(CORE_BUCKET)) {
      for (const field of fields) {
        expect(CANONICAL_FIELD_CLASSIFICATIONS[field]).toBe('core');
      }
    }
  });

  it('every EVOLVING_BUCKET field resolves to "evolving" in the lookup table', () => {
    for (const fields of Object.values(EVOLVING_BUCKET)) {
      for (const field of fields) {
        expect(CANONICAL_FIELD_CLASSIFICATIONS[field]).toBe('evolving');
      }
    }
  });

  it('canonically classifies the four core buckets from RFC-0028 §7.1', () => {
    // Categorical compliance locks
    expect(CANONICAL_FIELD_CLASSIFICATIONS['requiresTenantPhysicalIsolation']).toBe('core');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['requiresVulnerableAudienceLockout']).toBe('core');
    // Compliance regime declarations
    expect(CANONICAL_FIELD_CLASSIFICATIONS['HIPAA']).toBe('core');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['PCI-DSS']).toBe('core');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['SOC2']).toBe('core');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['FedRAMP']).toBe('core');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['GDPR']).toBe('core');
    // Director identifier
    expect(CANONICAL_FIELD_CLASSIFICATIONS['director']).toBe('core');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['orchestratorAgentId']).toBe('core');
    // complianceFloor lock
    expect(CANONICAL_FIELD_CLASSIFICATIONS['complianceFloor']).toBe('core');
  });

  it('canonically classifies the four evolving buckets from RFC-0028 §7.1', () => {
    expect(CANONICAL_FIELD_CLASSIFICATIONS['observerCooldownMs']).toBe('evolving');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['cadenceMinIntervalDays']).toBe('evolving');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['bidDiversityWeight']).toBe('evolving');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['recencyHalfLife']).toBe('evolving');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['clustering.similarityThreshold']).toBe('evolving');
    expect(CANONICAL_FIELD_CLASSIFICATIONS['tenantQuotaShare']).toBe('evolving');
  });

  it('CORE_BUCKET and EVOLVING_BUCKET field name sets are disjoint', () => {
    const coreFields = new Set<string>(Object.values(CORE_BUCKET).flat());
    const evolvingFields = new Set<string>(Object.values(EVOLVING_BUCKET).flat());
    for (const f of coreFields) {
      expect(evolvingFields.has(f)).toBe(false);
    }
  });

  it('IdentityClass type accepts exactly the two enum values', () => {
    const core: IdentityClass = 'core';
    const evolving: IdentityClass = 'evolving';
    expect([core, evolving]).toEqual(['core', 'evolving']);
  });
});

describe('novel-field default behavior', () => {
  it('returns "core" for unrecognized novel fields (RFC-0028 §7.1 conservative default)', () => {
    expect(defaultIdentityClassForNovelField('someBrandNewField')).toBe('core');
  });

  it('returns the canonical bucket when the field is recognized', () => {
    expect(defaultIdentityClassForNovelField('requiresTenantPhysicalIsolation')).toBe('core');
    expect(defaultIdentityClassForNovelField('observerCooldownMs')).toBe('evolving');
  });

  it('fires the warning hook ONLY for novel fields (not for canonical fields)', () => {
    const calls: Array<{ fieldName: string; defaultedTo: IdentityClass }> = [];
    const warn = (fieldName: string, defaultedTo: IdentityClass) =>
      calls.push({ fieldName, defaultedTo });

    defaultIdentityClassForNovelField('observerCooldownMs', { warn });
    expect(calls).toHaveLength(0);

    defaultIdentityClassForNovelField('someBrandNewField', { warn });
    expect(calls).toEqual([{ fieldName: 'someBrandNewField', defaultedTo: 'core' }]);
  });

  it('omitting the warn hook does not throw for novel fields', () => {
    expect(() => defaultIdentityClassForNovelField('novelFieldWithoutHook')).not.toThrow();
  });
});

describe('tightening-only enforcement (type system)', () => {
  it('LockedBoolean accepts the `true` literal (compile-time check)', () => {
    const lock: LockedBoolean = true;
    expect(lock).toBe(true);
  });

  it('LockedBoolean rejects `false` at the type level', () => {
    // @ts-expect-error — false is a loosening attempt and must fail compile.
    const _attempt: LockedBoolean = false;
    // The expect below is unreachable in a sense — what we are asserting is
    // the @ts-expect-error directive above is satisfied (the assignment IS a
    // type error). Surface a no-op runtime assertion so the test runner sees
    // this case as exercised.
    expect(_attempt).toBe(false);
  });

  it('BoundedNumericCap inherited variant carries a max without a previous-max', () => {
    const cap: BoundedNumericCap = { kind: 'inherited', max: 100 };
    expect(cap.max).toBe(100);
    expect(() => assertTightenedCap(cap)).not.toThrow();
  });

  it('BoundedNumericCap tightened variant accepts strictly-smaller max', () => {
    const cap: BoundedNumericCap = { kind: 'tightened', max: 50, previousMax: 100 };
    expect(() => assertTightenedCap(cap)).not.toThrow();
  });

  it('BoundedNumericCap tightened variant accepts equal max (no-op tightening)', () => {
    const cap: BoundedNumericCap = { kind: 'tightened', max: 100, previousMax: 100 };
    expect(() => assertTightenedCap(cap)).not.toThrow();
  });

  it('BoundedNumericCap tightened variant THROWS when child loosens (max > previousMax)', () => {
    const cap: BoundedNumericCap = { kind: 'tightened', max: 200, previousMax: 100 };
    expect(() => assertTightenedCap(cap)).toThrowError(IdentityClassError);
    expect(() => assertTightenedCap(cap)).toThrowError(/Tightening-only violation/);
  });

  it('TightenedCategorical narrows to a subset of the parent union (compile-time check)', () => {
    type ParentRegime = 'HIPAA' | 'PCI-DSS' | 'SOC2' | 'FedRAMP' | 'GDPR';
    type ChildRegime = TightenedCategorical<ParentRegime, 'HIPAA' | 'SOC2'>;

    const child: ChildRegime = 'HIPAA';
    const child2: ChildRegime = 'SOC2';
    expect([child, child2]).toEqual(['HIPAA', 'SOC2']);

    // @ts-expect-error — 'PCI-DSS' is in parent but not in declared child subset.
    const _outOfSubset: ChildRegime = 'PCI-DSS';
    expect(_outOfSubset).toBe('PCI-DSS');
  });

  it('TightenedCategorical compile-error if child declares value NOT in parent', () => {
    type ParentRegime = 'HIPAA' | 'PCI-DSS';
    // @ts-expect-error — 'NOT-A-REGIME' is not assignable to ParentRegime.
    type _BadChild = TightenedCategorical<ParentRegime, 'NOT-A-REGIME'>;
    // Surface a no-op runtime assertion so the case is recorded as exercised.
    expect(true).toBe(true);
  });
});

describe('audit discrepancy emission', () => {
  it('emits exactly one canonical discrepancy for the did-compiler.ts default fallback', () => {
    const discrepancies = auditLayer1DeterministicClassifications();
    expect(discrepancies).toHaveLength(1);
  });

  it('discrepancy targets did-compiler.ts ic() helper with observed=evolving vs canonical=core', () => {
    const [d] = auditLayer1DeterministicClassifications();
    expect(d.file).toBe('orchestrator/src/sa-scoring/did-compiler.ts');
    expect(d.symbol).toContain('ic()');
    expect(d.observed).toBe('evolving');
    expect(d.canonical).toBe('core');
  });

  it('discrepancy rationale references RFC-0028 §7.1 + three operator-routing options', () => {
    const [d] = auditLayer1DeterministicClassifications();
    expect(d.rationale).toMatch(/RFC-0028 §7\.1/);
    expect(d.rationale).toMatch(/\(a\).+\(b\).+\(c\)/s);
  });

  it('every discrepancy is shaped correctly for downstream cli-decisions consumption', () => {
    const discrepancies = auditLayer1DeterministicClassifications();
    for (const d of discrepancies) {
      expect(d.file).toMatch(/\.ts$/);
      expect(d.symbol.length).toBeGreaterThan(0);
      expect(d.field.length).toBeGreaterThan(0);
      expect(IDENTITY_CLASSES).toContain(d.observed);
      expect(IDENTITY_CLASSES).toContain(d.canonical);
      expect(d.observed).not.toBe(d.canonical);
      expect(d.rationale.length).toBeGreaterThan(50);
    }
  });
});
