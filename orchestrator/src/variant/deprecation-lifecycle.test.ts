/**
 * RFC-0017 Phase 3 — Variant deprecation lifecycle tests.
 *
 * Full integration coverage of AC #1, #2, #3:
 *   - All three lifecycle states emit correct Decisions
 *   - 30d default window + per-Soul override
 *   - Pipeline never halts (all events have blocking: false)
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_APPROACHING_WINDOW_DAYS,
  DEFAULT_DEPRECATION_WINDOW_DAYS,
  evaluateDeprecationLifecycle,
  resolveDeprecationState,
  type DeprecatedVariantDeclaration,
  type VariantDeprecationEvent,
  type VariantLifecycleConfig,
} from './deprecation-lifecycle.js';

// ── Helper to build dates relative to "now" ──────────────────────────────────

function daysAgo(n: number, from: Date = new Date('2026-06-01T00:00:00Z')): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

function daysFromNow(n: number, from: Date = new Date('2026-06-01T00:00:00Z')): string {
  return daysAgo(-n, from);
}

const NOW = new Date('2026-06-01T00:00:00Z');

// ── resolveDeprecationState unit tests ───────────────────────────────────────

describe('resolveDeprecationState', () => {
  it('returns "declared" when removal date is far in the future', () => {
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: daysAgo(2, NOW),
      removalDate: daysFromNow(20, NOW),
    };
    expect(resolveDeprecationState(decl, {}, NOW)).toBe('declared');
  });

  it('returns "approaching" when within approachingWindowDays of removal', () => {
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: daysAgo(25, NOW),
      removalDate: daysFromNow(5, NOW), // 5d away, within 7d threshold
    };
    expect(resolveDeprecationState(decl, {}, NOW)).toBe('approaching');
  });

  it('returns "approaching" exactly at the approaching threshold boundary', () => {
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: daysAgo(23, NOW),
      removalDate: daysFromNow(DEFAULT_APPROACHING_WINDOW_DAYS, NOW),
    };
    // now === removalDate - approachingWindowDays → should be 'approaching'
    expect(resolveDeprecationState(decl, {}, NOW)).toBe('approaching');
  });

  it('returns "removal-pending" at removal date with active consumers', () => {
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'enterprise',
      deprecationDeclaredAt: daysAgo(35, NOW),
      removalDate: daysAgo(2, NOW), // past removal date
      activeConsumers: ['AISDLC-313', 'AISDLC-315'],
    };
    expect(resolveDeprecationState(decl, {}, NOW)).toBe('removal-pending');
  });

  it('returns "removed" at removal date with no active consumers', () => {
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'enterprise',
      deprecationDeclaredAt: daysAgo(35, NOW),
      removalDate: daysAgo(2, NOW),
      activeConsumers: [],
    };
    expect(resolveDeprecationState(decl, {}, NOW)).toBe('removed');
  });

  it('computes removalDate from deprecationWindowDays when not explicit', () => {
    // Declared 20 days ago; default window is 30d → removal in 10d → 'declared'
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: daysAgo(20, NOW),
    };
    expect(resolveDeprecationState(decl, {}, NOW)).toBe('declared');
  });

  it('uses per-Soul deprecationWindowDays override', () => {
    // Declared 10 days ago; per-Soul window = 7d → removal date is 3d AGO → removal-pending
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: daysAgo(10, NOW),
      activeConsumers: ['AISDLC-999'],
    };
    const config: VariantLifecycleConfig = { deprecationWindowDays: 7 };
    expect(resolveDeprecationState(decl, config, NOW)).toBe('removal-pending');
  });

  it('uses per-Soul approachingWindowDays override', () => {
    // Removal in 3d; default approaching = 7d (should be 'approaching'),
    // but per-Soul override = 2d → 3d away > 2d threshold → 'declared'
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: daysAgo(27, NOW),
      removalDate: daysFromNow(3, NOW),
    };
    const config: VariantLifecycleConfig = { approachingWindowDays: 2 };
    expect(resolveDeprecationState(decl, config, NOW)).toBe('declared');
  });
});

// ── evaluateDeprecationLifecycle integration tests ───────────────────────────

describe('evaluateDeprecationLifecycle — AC #1, #2, #3', () => {
  it('AC #1: emits variant-deprecation-declared for a freshly-deprecated variant', () => {
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'spry-engage',
        variantId: 'small-utility',
        deprecationDeclaredAt: NOW.toISOString(),
        removalDate: daysFromNow(30, NOW),
      },
    ];
    const result = evaluateDeprecationLifecycle(declarations, {}, NOW);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.kind).toBe('variant-deprecation-declared');
    expect(ev.state).toBe('declared');
    expect(ev.soulId).toBe('spry-engage');
    expect(ev.variantId).toBe('small-utility');
  });

  it('AC #1: emits variant-deprecation-approaching when within window', () => {
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'spry-engage',
        variantId: 'enterprise',
        deprecationDeclaredAt: daysAgo(25, NOW),
        removalDate: daysFromNow(4, NOW),
      },
    ];
    const result = evaluateDeprecationLifecycle(declarations, {}, NOW);
    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.kind).toBe('variant-deprecation-approaching');
    expect(ev.state).toBe('approaching');
    expect(ev.routing.batchReview).toBe(true);
    expect(ev.routing.blocking).toBe(false);
  });

  it('AC #1: emits variant-removal-consumers-pending + degraded mode + migration tasks', () => {
    const consumers = ['AISDLC-100', 'AISDLC-200'];
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'spry-engage',
        variantId: 'legacy',
        deprecationDeclaredAt: daysAgo(40, NOW),
        removalDate: daysAgo(5, NOW),
        activeConsumers: consumers,
      },
    ];
    const capturedEvents: VariantDeprecationEvent[] = [];
    const result = evaluateDeprecationLifecycle(declarations, {}, NOW, (ev) => {
      capturedEvents.push(ev);
    });

    expect(result.events).toHaveLength(1);
    const ev = result.events[0];
    expect(ev.kind).toBe('variant-removal-consumers-pending');
    expect(ev.state).toBe('removal-pending');
    expect(ev.routing.blocking).toBe(false);
    expect(ev.routing.degradedMode).toBe(true);
    expect(ev.routing.migrationTasksEmitted).toBe(true);

    // Migration tasks — one per consumer
    expect(result.migrationTasks).toHaveLength(2);
    expect(result.migrationTasks[0].consumerId).toBe('AISDLC-100');
    expect(result.migrationTasks[1].consumerId).toBe('AISDLC-200');

    // Degraded variants list
    expect(result.degradedVariants).toHaveLength(1);
    expect(result.degradedVariants[0].variantId).toBe('legacy');

    // emitDecision callback received the event
    expect(capturedEvents).toHaveLength(1);
    expect(capturedEvents[0].kind).toBe('variant-removal-consumers-pending');
  });

  it('AC #2: respects per-Soul deprecationWindowDays override', () => {
    // With 60d window, a declaration from 35d ago shouldn't even be approaching
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'spry-engage',
        variantId: 'beta',
        deprecationDeclaredAt: daysAgo(35, NOW),
      },
    ];
    const config: VariantLifecycleConfig = { deprecationWindowDays: 60 };
    const result = evaluateDeprecationLifecycle(declarations, config, NOW);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].state).toBe('declared');
  });

  it('AC #2: 30d default window — declared 31d ago → removal-pending with consumers', () => {
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'spry-engage',
        variantId: 'old',
        deprecationDeclaredAt: daysAgo(31, NOW),
        activeConsumers: ['AISDLC-50'],
      },
    ];
    // No explicit config — uses 30d default
    const result = evaluateDeprecationLifecycle(declarations, {}, NOW);
    expect(result.events[0].state).toBe('removal-pending');
  });

  it('AC #3: ALL events have blocking: false (pipeline never halts)', () => {
    const now = NOW;
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'soul-a',
        variantId: 'v1',
        deprecationDeclaredAt: now.toISOString(),
        removalDate: daysFromNow(30, now),
      },
      {
        soulId: 'soul-b',
        variantId: 'v2',
        deprecationDeclaredAt: daysAgo(25, now),
        removalDate: daysFromNow(3, now),
      },
      {
        soulId: 'soul-c',
        variantId: 'v3',
        deprecationDeclaredAt: daysAgo(40, now),
        removalDate: daysAgo(5, now),
        activeConsumers: ['AISDLC-1'],
      },
    ];
    const result = evaluateDeprecationLifecycle(declarations, {}, now);
    for (const ev of result.events) {
      expect(ev.routing.blocking).toBe(false);
    }
  });

  it('emits no event for "removed" state (clean terminal)', () => {
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'spry-engage',
        variantId: 'gone',
        deprecationDeclaredAt: daysAgo(60, NOW),
        removalDate: daysAgo(10, NOW),
        activeConsumers: [],
      },
    ];
    const result = evaluateDeprecationLifecycle(declarations, {}, NOW);
    expect(result.events).toHaveLength(0);
    expect(result.migrationTasks).toHaveLength(0);
    expect(result.degradedVariants).toHaveLength(0);
  });

  it('handles multiple declarations in a single call', () => {
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'soul-a',
        variantId: 'v-declared',
        deprecationDeclaredAt: NOW.toISOString(),
        removalDate: daysFromNow(30, NOW),
      },
      {
        soulId: 'soul-b',
        variantId: 'v-approaching',
        deprecationDeclaredAt: daysAgo(25, NOW),
        removalDate: daysFromNow(3, NOW),
      },
      {
        soulId: 'soul-c',
        variantId: 'v-pending',
        deprecationDeclaredAt: daysAgo(40, NOW),
        removalDate: daysAgo(5, NOW),
        activeConsumers: ['AISDLC-1', 'AISDLC-2'],
      },
    ];
    const result = evaluateDeprecationLifecycle(declarations, {}, NOW);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].state).toBe('declared');
    expect(result.events[1].state).toBe('approaching');
    expect(result.events[2].state).toBe('removal-pending');
    expect(result.migrationTasks).toHaveLength(2);
    expect(result.degradedVariants).toHaveLength(1);
  });

  it('emitDecision callback receives all emitted events in order', () => {
    const declarations: DeprecatedVariantDeclaration[] = [
      {
        soulId: 'soul-a',
        variantId: 'v1',
        deprecationDeclaredAt: NOW.toISOString(),
        removalDate: daysFromNow(20, NOW),
      },
      {
        soulId: 'soul-b',
        variantId: 'v2',
        deprecationDeclaredAt: daysAgo(25, NOW),
        removalDate: daysFromNow(3, NOW),
      },
    ];
    const captured: VariantDeprecationEvent[] = [];
    evaluateDeprecationLifecycle(declarations, {}, NOW, (ev) => captured.push(ev));
    expect(captured).toHaveLength(2);
    expect(captured[0].kind).toBe('variant-deprecation-declared');
    expect(captured[1].kind).toBe('variant-deprecation-approaching');
  });
});

// ── Integration test: full deprecation lifecycle loop ─────────────────────────

describe('full deprecation lifecycle integration', () => {
  it('simulates a variant progressing through all lifecycle states over time', () => {
    // Day 0: deprecation declared
    const declaredAt = new Date('2026-05-01T00:00:00Z');
    const decl: DeprecatedVariantDeclaration = {
      soulId: 'spry-engage',
      variantId: 'small-utility',
      deprecationDeclaredAt: declaredAt.toISOString(),
      activeConsumers: ['AISDLC-300'],
    };
    const config: VariantLifecycleConfig = {
      deprecationWindowDays: DEFAULT_DEPRECATION_WINDOW_DAYS,
      approachingWindowDays: DEFAULT_APPROACHING_WINDOW_DAYS,
    };

    // Day 2 → 'declared'
    const day2 = new Date('2026-05-03T00:00:00Z');
    let result = evaluateDeprecationLifecycle([decl], config, day2);
    expect(result.events[0].state).toBe('declared');
    expect(result.events[0].routing.blocking).toBe(false);

    // Day 25 → 'approaching' (within 7d of day-30 removal)
    const day25 = new Date('2026-05-26T00:00:00Z');
    result = evaluateDeprecationLifecycle([decl], config, day25);
    expect(result.events[0].state).toBe('approaching');
    expect(result.events[0].routing.batchReview).toBe(true);
    expect(result.events[0].routing.blocking).toBe(false);

    // Day 31 with consumers still active → 'removal-pending' + degraded
    const day31 = new Date('2026-06-01T00:00:00Z');
    result = evaluateDeprecationLifecycle([decl], config, day31);
    expect(result.events[0].state).toBe('removal-pending');
    expect(result.events[0].routing.degradedMode).toBe(true);
    expect(result.events[0].routing.blocking).toBe(false);
    expect(result.migrationTasks).toHaveLength(1);
    expect(result.migrationTasks[0].consumerId).toBe('AISDLC-300');

    // Day 31, consumers resolved → 'removed' (no event)
    const declNoConsumers = { ...decl, activeConsumers: [] };
    result = evaluateDeprecationLifecycle([declNoConsumers], config, day31);
    expect(result.events).toHaveLength(0);
    expect(result.degradedVariants).toHaveLength(0);
  });
});
