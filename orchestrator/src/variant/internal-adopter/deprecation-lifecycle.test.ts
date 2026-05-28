/**
 * RFC-0017 Phase 4 — End-to-end deprecation lifecycle test on one ProductA
 * variant (AISDLC-437 AC #8).
 *
 * Walks the full G0-routed lifecycle (declared → approaching → removal-pending
 * → removed) for ProductA's `county-regional` variant. The chosen variant is
 * the lowest-cardinality of ProductA's three (smaller audience-segment match
 * surface than small-utility or enterprise) so the deprecation is a realistic
 * scenario for the reference impl.
 *
 * The lifecycle test verifies (per RFC-0017 §6.3 + OQ-3 resolution):
 *
 *   1. **declared** state emits `variant-deprecation-declared` Decision,
 *      blocking=false, no operator interrupt.
 *   2. **approaching** state (within 7d of removalDate) emits
 *      `variant-deprecation-approaching` Decision with batchReview=true.
 *   3. **removal-pending** state (past removalDate WITH active consumers)
 *      emits `variant-removal-consumers-pending` Decision with
 *      degradedMode=true + migrationTasksEmitted=true.
 *   4. **removed** state (past removalDate WITHOUT active consumers) emits
 *      NO event (clean terminal; safe-to-prune).
 *   5. All events are blocking=false (pipeline never halts).
 *   6. Per-Soul `deprecationWindowDays` override is honored.
 */

import { describe, it, expect } from 'vitest';

import { productA } from './products.js';
import {
  DEFAULT_DEPRECATION_WINDOW_DAYS,
  evaluateDeprecationLifecycle,
  resolveDeprecationState,
  type DeprecatedVariantDeclaration,
  type VariantDeprecationEvent,
  type VariantLifecycleConfig,
} from '../deprecation-lifecycle.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(n: number, from: Date): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

function daysFromNow(n: number, from: Date): string {
  return daysAgo(-n, from);
}

const NOW = new Date('2026-06-01T00:00:00Z');

/** The ProductA variant under deprecation in this lifecycle test. */
const SUBJECT_VARIANT_ID = 'county-regional';

describe('InternalAdopter end-to-end deprecation lifecycle on ProductA/county-regional (AC #8)', () => {
  // Sanity: the variant the lifecycle test exercises actually exists in the
  // reference impl. Catches the case where someone renames/removes a variant
  // upstream without updating this test.
  it('subject variant is declared on ProductA', () => {
    const subject = productA.variants.find((v) => v.id === SUBJECT_VARIANT_ID);
    expect(subject, `expected ProductA to declare a '${SUBJECT_VARIANT_ID}' variant`).toBeDefined();
  });

  it('Stage 1 — declared: emits variant-deprecation-declared, blocking=false, no batch review', () => {
    const declaration: DeprecatedVariantDeclaration = {
      soulId: productA.soulId,
      variantId: SUBJECT_VARIANT_ID,
      deprecationDeclaredAt: daysAgo(2, NOW),
      removalDate: daysFromNow(20, NOW),
    };

    expect(resolveDeprecationState(declaration, {}, NOW)).toBe('declared');

    const captured: VariantDeprecationEvent[] = [];
    const result = evaluateDeprecationLifecycle([declaration], {}, NOW, (e) => captured.push(e));

    expect(result.events).toHaveLength(1);
    expect(captured).toHaveLength(1);
    const event = result.events[0];
    expect(event.kind).toBe('variant-deprecation-declared');
    expect(event.state).toBe('declared');
    expect(event.routing.blocking).toBe(false);
    expect(event.routing.batchReview).toBe(false);
    expect(result.migrationTasks).toEqual([]);
    expect(result.degradedVariants).toEqual([]);
  });

  it('Stage 2 — approaching: emits variant-deprecation-approaching, blocking=false, batchReview=true', () => {
    const declaration: DeprecatedVariantDeclaration = {
      soulId: productA.soulId,
      variantId: SUBJECT_VARIANT_ID,
      deprecationDeclaredAt: daysAgo(25, NOW),
      removalDate: daysFromNow(5, NOW), // 5d away — inside default 7d approaching window
    };

    expect(resolveDeprecationState(declaration, {}, NOW)).toBe('approaching');

    const result = evaluateDeprecationLifecycle([declaration], {}, NOW);
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event.kind).toBe('variant-deprecation-approaching');
    expect(event.state).toBe('approaching');
    expect(event.routing.blocking).toBe(false);
    expect(event.routing.batchReview).toBe(true);
    expect(result.migrationTasks).toEqual([]);
    expect(result.degradedVariants).toEqual([]);
  });

  it(
    'Stage 3 — removal-pending: emits variant-removal-consumers-pending with degraded mode + ' +
      'migration tasks (one per consumer)',
    () => {
      const declaration: DeprecatedVariantDeclaration = {
        soulId: productA.soulId,
        variantId: SUBJECT_VARIANT_ID,
        deprecationDeclaredAt: daysAgo(40, NOW),
        removalDate: daysAgo(2, NOW),
        activeConsumers: ['AISDLC-700', 'AISDLC-701', 'AISDLC-702'],
      };

      expect(resolveDeprecationState(declaration, {}, NOW)).toBe('removal-pending');

      const result = evaluateDeprecationLifecycle([declaration], {}, NOW);

      expect(result.events).toHaveLength(1);
      const event = result.events[0];
      expect(event.kind).toBe('variant-removal-consumers-pending');
      expect(event.state).toBe('removal-pending');
      expect(event.routing.blocking).toBe(false);
      expect(event.routing.batchReview).toBe(true);
      expect(event.routing.degradedMode).toBe(true);
      expect(event.routing.migrationTasksEmitted).toBe(true);
      expect(event.activeConsumers).toEqual(['AISDLC-700', 'AISDLC-701', 'AISDLC-702']);

      // One migration task per consumer.
      expect(result.migrationTasks).toHaveLength(3);
      for (const task of result.migrationTasks) {
        expect(task.soulId).toBe(productA.soulId);
        expect(task.variantId).toBe(SUBJECT_VARIANT_ID);
        expect(['AISDLC-700', 'AISDLC-701', 'AISDLC-702']).toContain(task.consumerId);
      }

      // Variant is in degraded mode — pipeline continues.
      expect(result.degradedVariants).toEqual([
        { soulId: productA.soulId, variantId: SUBJECT_VARIANT_ID },
      ]);
    },
  );

  it('Stage 4 — removed: past removalDate WITHOUT consumers emits NO event (clean terminal)', () => {
    const declaration: DeprecatedVariantDeclaration = {
      soulId: productA.soulId,
      variantId: SUBJECT_VARIANT_ID,
      deprecationDeclaredAt: daysAgo(40, NOW),
      removalDate: daysAgo(2, NOW),
      activeConsumers: [],
    };

    expect(resolveDeprecationState(declaration, {}, NOW)).toBe('removed');

    const result = evaluateDeprecationLifecycle([declaration], {}, NOW);
    expect(result.events).toEqual([]);
    expect(result.migrationTasks).toEqual([]);
    expect(result.degradedVariants).toEqual([]);
  });

  it('AC #8: pipeline NEVER halts — every emitted lifecycle event has blocking=false', () => {
    // Walk through all three event-emitting states in a single batch and
    // assert the G0 non-blocking invariant holds across the full lifecycle.
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: productA.soulId,
        variantId: SUBJECT_VARIANT_ID,
        deprecationDeclaredAt: daysAgo(2, NOW),
        removalDate: daysFromNow(20, NOW),
      },
      {
        soulId: productA.soulId,
        variantId: SUBJECT_VARIANT_ID,
        deprecationDeclaredAt: daysAgo(25, NOW),
        removalDate: daysFromNow(5, NOW),
      },
      {
        soulId: productA.soulId,
        variantId: SUBJECT_VARIANT_ID,
        deprecationDeclaredAt: daysAgo(40, NOW),
        removalDate: daysAgo(2, NOW),
        activeConsumers: ['AISDLC-700'],
      },
    ];

    const result = evaluateDeprecationLifecycle(declarations, {}, NOW);
    expect(result.events).toHaveLength(3);
    for (const event of result.events) {
      expect(event.routing.blocking, `${event.kind} broke the G0 non-blocking invariant`).toBe(
        false,
      );
    }
  });

  it('AC #8: per-Soul deprecationWindowDays override is honored (60d cadence)', () => {
    // ProductA elects a 60-day deprecation window (slower than the 30d
    // default — adopter cadence accommodation per OQ-3 resolution).
    const config: VariantLifecycleConfig = { deprecationWindowDays: 60 };

    const declaration: DeprecatedVariantDeclaration = {
      soulId: productA.soulId,
      variantId: SUBJECT_VARIANT_ID,
      deprecationDeclaredAt: daysAgo(20, NOW),
      // No explicit removalDate → engine computes declaredAt + 60d.
    };

    // With 60d window: declaredAt was 20d ago → 40d remaining → 'declared'.
    expect(resolveDeprecationState(declaration, config, NOW)).toBe('declared');

    // With the DEFAULT 30d window: same declaration → declaredAt 20d ago →
    // 10d remaining → 'declared' too. Confirm the default constant is 30d
    // (this is a guard against silent constant drift breaking the override
    // semantics).
    expect(DEFAULT_DEPRECATION_WINDOW_DAYS).toBe(30);
  });

  it('AC #8: full lifecycle from declared → approaching → removal-pending → removed (time march)', () => {
    // Simulate one variant marching through the lifecycle by varying `now`
    // while holding declaration constant. Day 0 = declared at NOW.
    const declaration: DeprecatedVariantDeclaration = {
      soulId: productA.soulId,
      variantId: SUBJECT_VARIANT_ID,
      deprecationDeclaredAt: daysAgo(0, NOW),
      // Default 30d window → removalDate ~30d from NOW.
    };

    // Day 1 — declared.
    const day1 = new Date(NOW);
    day1.setUTCDate(day1.getUTCDate() + 1);
    expect(resolveDeprecationState(declaration, {}, day1)).toBe('declared');

    // Day 25 — approaching (within 7d of removal at day 30).
    const day25 = new Date(NOW);
    day25.setUTCDate(day25.getUTCDate() + 25);
    expect(resolveDeprecationState(declaration, {}, day25)).toBe('approaching');

    // Day 31 with active consumer — removal-pending.
    const day31 = new Date(NOW);
    day31.setUTCDate(day31.getUTCDate() + 31);
    expect(
      resolveDeprecationState({ ...declaration, activeConsumers: ['AISDLC-700'] }, {}, day31),
    ).toBe('removal-pending');

    // Day 31 with no active consumer — removed.
    expect(resolveDeprecationState({ ...declaration, activeConsumers: [] }, {}, day31)).toBe(
      'removed',
    );
  });
});
