/**
 * RFC-0018 Phase 2 — journey-scope admission router unit tests.
 *
 * Covers acceptance criteria from AISDLC-466:
 *   AC #1: Sα₂ scoring routes through journey `designImperatives` (UNION with
 *          variant + soul; most-specific wins) when `targetedJourneys` declared
 *   AC #2: Cκ scoring boosted when journey `successMetrics.completion-rate <
 *          alertBelow` threshold
 *   AC #3: Eρ₅ elevated when journey `accessibility.wcagLevel` > soul-default
 *   AC #4: Cross-journey aggregation: default `min`; per-Soul
 *          `crossJourneyAggregation` override respected
 *   AC #5: Closed completion-criteria enum: `terminal-success-state` +
 *          `all-states-reached` only; `custom-predicate` rejected at schema
 *          validation
 *   AC #6: `Decision: journey-custom-predicate-activation-request` Stage A
 *          counter wired
 *   AC #7: Work items without `targetedJourneys` score against soul/variant
 *          (backward-compat preserved)
 *   AC #8: Hermetic tests cover all scoring paths + conflict resolution +
 *          cross-journey aggregation + closed enum rejection + counter increments
 */

import { describe, it, expect } from 'vitest';

import {
  // Completion-criteria closed enum
  validateCompletionCriteriaKind,
  COMPLETION_CRITERIA_V1_KINDS,
  JOURNEY_CUSTOM_PREDICATE_DECISION_KIND,
  // Decision counter
  createCustomPredicateDecisionCounter,
  incrementDecisionCounter,
  // WCAG level ordering
  isWcagElevated,
  // URI parsing
  parseTargetedJourneyRef,
  // Resolution
  resolveTargetedJourneys,
  // Cross-journey aggregation
  applyCrossJourneyRule,
  // Main router
  computeJourneyScopedScores,
  type JourneyContext,
  type JourneyDeclaration,
} from './journey-sa2-router.js';

// ── Fixture factories ────────────────────────────────────────────────────

function makeJourneys(): Record<string, JourneyDeclaration[]> {
  return {
    'spry-engage': [
      {
        id: 'onboarding',
        scope: 'soul',
        completionCriteria: { kind: 'terminal-success-state', target: 'first-task-done' },
        accessibility: { wcagLevel: 'AA', wcagVersion: '2.1', conformanceTarget: 100 },
        successMetrics: [
          { id: 'completion-rate', target: 0.65, alertBelow: 0.5 },
          { id: 'median-time-to-first-task-done', targetSeconds: 1800, alertAbove: 3600 },
        ],
        designImperatives: [
          'first-task-done within 30 min of account creation',
          'profile-form is single-screen (no pagination)',
        ],
      },
      {
        id: 'daily-task-management',
        scope: 'soul',
        completionCriteria: { kind: 'all-states-reached' },
        accessibility: { wcagLevel: 'AAA', wcagVersion: '2.1', conformanceTarget: 95 },
        successMetrics: [{ id: 'completion-rate', target: 0.8, alertBelow: 0.7 }],
        designImperatives: ['task-list-visible-on-login', 'bulk-actions-available'],
      },
      {
        id: 'regulatory-submission',
        scope: 'variant:annual-test',
        completionCriteria: { kind: 'terminal-success-state', target: 'submitted' },
        accessibility: { wcagLevel: 'AAA', wcagVersion: '2.2', conformanceTarget: 100 },
        successMetrics: [],
        designImperatives: ['single-click submission', 'confirmation email required'],
      },
    ],
    'spry-billing': [
      {
        id: 'billing-inquiry-resolution',
        scope: 'soul',
        completionCriteria: { kind: 'terminal-success-state', target: 'resolved' },
        accessibility: { wcagLevel: 'AA', wcagVersion: '2.1', conformanceTarget: 90 },
        successMetrics: [{ id: 'completion-rate', target: 0.9, alertBelow: 0.75 }],
        designImperatives: [],
      },
    ],
  };
}

function makeJourneyScores(): JourneyContext['journeyScores'] {
  return {
    'spry-engage': {
      onboarding: { sa2: 0.85, ck: 0.9, er5Elevated: false }, // high — well-aligned journey
      'daily-task-management': { sa2: 0.7, ck: 0.6, er5Elevated: true }, // AAA > soul AA floor
      'regulatory-submission': { sa2: 0.6, ck: 0.5, er5Elevated: true }, // AAA variant-scoped
    },
    'spry-billing': {
      'billing-inquiry-resolution': { sa2: 0.75, ck: 0.8, er5Elevated: false },
    },
  };
}

function makeJourneyContext(overrides?: Partial<JourneyContext>): JourneyContext {
  return {
    journeysBySoul: makeJourneys(),
    journeyScores: makeJourneyScores(),
    workItemTargeting: [],
    ...overrides,
  };
}

// ── validateCompletionCriteriaKind ───────────────────────────────────────

describe('validateCompletionCriteriaKind — closed enum (AC #5)', () => {
  it('accepts terminal-success-state (valid v1 kind)', () => {
    const result = validateCompletionCriteriaKind('terminal-success-state');
    expect(result.valid).toBe(true);
    expect(result.rejectedKind).toBeUndefined();
    expect(result.decisionKind).toBeUndefined();
  });

  it('accepts all-states-reached (valid v1 kind)', () => {
    const result = validateCompletionCriteriaKind('all-states-reached');
    expect(result.valid).toBe(true);
  });

  it('rejects custom-predicate with decisionKind wired (AC #5 + AC #6)', () => {
    const result = validateCompletionCriteriaKind('custom-predicate');
    expect(result.valid).toBe(false);
    expect(result.rejectedKind).toBe('custom-predicate');
    expect(result.decisionKind).toBe(JOURNEY_CUSTOM_PREDICATE_DECISION_KIND);
    expect(result.decisionKind).toBe('journey-custom-predicate-activation-request');
  });

  it('rejects arbitrary unknown kind without decisionKind', () => {
    const result = validateCompletionCriteriaKind('cel-expression');
    expect(result.valid).toBe(false);
    expect(result.rejectedKind).toBe('cel-expression');
    expect(result.decisionKind).toBeUndefined();
  });

  it('rejects empty string', () => {
    const result = validateCompletionCriteriaKind('');
    expect(result.valid).toBe(false);
  });

  it('COMPLETION_CRITERIA_V1_KINDS set contains exactly the two valid kinds', () => {
    expect(COMPLETION_CRITERIA_V1_KINDS.has('terminal-success-state')).toBe(true);
    expect(COMPLETION_CRITERIA_V1_KINDS.has('all-states-reached')).toBe(true);
    expect(COMPLETION_CRITERIA_V1_KINDS.size).toBe(2);
  });
});

// ── Decision counter (AC #6) ─────────────────────────────────────────────

describe('DecisionCounter — Stage A journey-custom-predicate-activation-request (AC #6)', () => {
  it('creates fresh counter at zero', () => {
    const counter = createCustomPredicateDecisionCounter();
    expect(counter.decisionKind).toBe('journey-custom-predicate-activation-request');
    expect(counter.totalRequests).toBe(0);
    expect(counter.distinctAdopterIds.size).toBe(0);
    expect(counter.shouldAutoPromote).toBe(false);
  });

  it('increments total count on each call', () => {
    const counter = createCustomPredicateDecisionCounter();
    incrementDecisionCounter(counter, 'adopter-alpha');
    expect(counter.totalRequests).toBe(1);
    incrementDecisionCounter(counter, 'adopter-alpha');
    expect(counter.totalRequests).toBe(2);
  });

  it('deduplicates same adopter — shouldAutoPromote stays false', () => {
    const counter = createCustomPredicateDecisionCounter();
    incrementDecisionCounter(counter, 'adopter-alpha');
    incrementDecisionCounter(counter, 'adopter-alpha');
    incrementDecisionCounter(counter, 'adopter-alpha');
    expect(counter.distinctAdopterIds.size).toBe(1);
    expect(counter.shouldAutoPromote).toBe(false);
  });

  it('auto-promotes at 2 distinct adopter IDs (OQ-4 threshold)', () => {
    const counter = createCustomPredicateDecisionCounter();
    incrementDecisionCounter(counter, 'adopter-alpha');
    expect(counter.shouldAutoPromote).toBe(false);
    incrementDecisionCounter(counter, 'adopter-beta');
    expect(counter.shouldAutoPromote).toBe(true);
    expect(counter.distinctAdopterIds.size).toBe(2);
  });

  it('continues tracking after auto-promote threshold crossed', () => {
    const counter = createCustomPredicateDecisionCounter();
    incrementDecisionCounter(counter, 'adopter-alpha');
    incrementDecisionCounter(counter, 'adopter-beta');
    incrementDecisionCounter(counter, 'adopter-gamma');
    expect(counter.shouldAutoPromote).toBe(true);
    expect(counter.distinctAdopterIds.size).toBe(3);
    expect(counter.totalRequests).toBe(3);
  });

  it('counter increments on custom-predicate rejection (integration path)', () => {
    const counter = createCustomPredicateDecisionCounter();
    const result = validateCompletionCriteriaKind('custom-predicate');
    expect(result.valid).toBe(false);
    expect(result.decisionKind).toBe(counter.decisionKind);
    // Caller would invoke incrementDecisionCounter here
    incrementDecisionCounter(counter, 'internal-adopter');
    expect(counter.totalRequests).toBe(1);
  });
});

// ── isWcagElevated ───────────────────────────────────────────────────────

describe('isWcagElevated — Eρ₅ journey WCAG vs soul floor (AC #3)', () => {
  it('AAA > AA → elevated', () => {
    expect(isWcagElevated('AAA', 'AA')).toBe(true);
  });

  it('AAA > A → elevated', () => {
    expect(isWcagElevated('AAA', 'A')).toBe(true);
  });

  it('AA > A → elevated', () => {
    expect(isWcagElevated('AA', 'A')).toBe(true);
  });

  it('AA == AA → not elevated (same level)', () => {
    expect(isWcagElevated('AA', 'AA')).toBe(false);
  });

  it('A < AA → not elevated (lower than soul floor)', () => {
    // Journeys MAY NOT lower the WCAG level below parent (RFC-0018 §5.3)
    // The elevation check returns false when journey level ≤ soul floor.
    expect(isWcagElevated('A', 'AA')).toBe(false);
  });

  it('AAA == AAA → not elevated (same level)', () => {
    expect(isWcagElevated('AAA', 'AAA')).toBe(false);
  });
});

// ── parseTargetedJourneyRef ──────────────────────────────────────────────

describe('parseTargetedJourneyRef', () => {
  it('parses soul-scoped form (soul-id/journey-id)', () => {
    const result = parseTargetedJourneyRef('spry-engage/onboarding');
    expect(result).toEqual({
      soulId: 'spry-engage',
      journeyId: 'onboarding',
      raw: 'spry-engage/onboarding',
    });
    expect(result?.variantId).toBeUndefined();
  });

  it('parses variant-scoped form (soul-id/variant-id/journey-id)', () => {
    const result = parseTargetedJourneyRef('spry-engage/annual-test/regulatory-submission');
    expect(result).toEqual({
      soulId: 'spry-engage',
      variantId: 'annual-test',
      journeyId: 'regulatory-submission',
      raw: 'spry-engage/annual-test/regulatory-submission',
    });
  });

  it('returns undefined for slug starting with digit', () => {
    expect(parseTargetedJourneyRef('1bad/onboarding')).toBeUndefined();
    expect(parseTargetedJourneyRef('spry-engage/1bad')).toBeUndefined();
  });

  it('returns undefined for uppercase slug', () => {
    expect(parseTargetedJourneyRef('Spry-Engage/onboarding')).toBeUndefined();
    expect(parseTargetedJourneyRef('spry-engage/Onboarding')).toBeUndefined();
  });

  it('returns undefined for bare soul-id with no slash', () => {
    expect(parseTargetedJourneyRef('spry-engage')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseTargetedJourneyRef('')).toBeUndefined();
  });

  it('returns undefined for 4-part path (too many segments)', () => {
    expect(parseTargetedJourneyRef('a/b/c/d')).toBeUndefined();
  });

  it('handles kebab slugs correctly', () => {
    const result = parseTargetedJourneyRef('spry-engage/daily-task-management');
    expect(result?.soulId).toBe('spry-engage');
    expect(result?.journeyId).toBe('daily-task-management');
  });
});

// ── resolveTargetedJourneys ──────────────────────────────────────────────

describe('resolveTargetedJourneys', () => {
  it('returns empty array when no journeyCtx provided (backward-compat)', () => {
    expect(resolveTargetedJourneys('AISDLC-100', undefined)).toEqual([]);
  });

  it('returns empty array when workItemTargeting is absent', () => {
    const ctx = makeJourneyContext({ workItemTargeting: undefined });
    expect(resolveTargetedJourneys('AISDLC-100', ctx)).toEqual([]);
  });

  it('returns empty array when work item not in targeting list', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-200', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    expect(resolveTargetedJourneys('AISDLC-100', ctx)).toEqual([]);
  });

  it('returns empty array when work item has no targetedJourneys', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: [] }],
    });
    expect(resolveTargetedJourneys('AISDLC-100', ctx)).toEqual([]);
  });

  it('resolves single valid soul-scoped journey', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const result = resolveTargetedJourneys('AISDLC-100', ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      soulId: 'spry-engage',
      journeyId: 'onboarding',
      raw: 'spry-engage/onboarding',
    });
  });

  it('resolves variant-scoped journey', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/annual-test/regulatory-submission'],
        },
      ],
    });
    const result = resolveTargetedJourneys('AISDLC-100', ctx);
    expect(result).toHaveLength(1);
    expect(result[0].variantId).toBe('annual-test');
    expect(result[0].journeyId).toBe('regulatory-submission');
  });

  it('filters out references to non-existent soul', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['nonexistent-soul/onboarding', 'spry-engage/onboarding'],
        },
      ],
    });
    const result = resolveTargetedJourneys('AISDLC-100', ctx);
    expect(result).toHaveLength(1);
    expect(result[0].soulId).toBe('spry-engage');
  });

  it('filters out references to non-existent journey (within valid soul)', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/nonexistent-journey'],
        },
      ],
    });
    expect(resolveTargetedJourneys('AISDLC-100', ctx)).toEqual([]);
  });

  it('matches work item ID case-insensitively', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'aisdlc-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    expect(resolveTargetedJourneys('AISDLC-100', ctx)).toHaveLength(1);
    expect(resolveTargetedJourneys('aisdlc-100', ctx)).toHaveLength(1);
  });

  it('resolves multiple valid journeys', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = resolveTargetedJourneys('AISDLC-100', ctx);
    expect(result).toHaveLength(2);
  });
});

// ── applyCrossJourneyRule ────────────────────────────────────────────────

describe('applyCrossJourneyRule (AC #4)', () => {
  it('returns fallback for empty values array', () => {
    expect(applyCrossJourneyRule([], undefined, 0.5)).toBe(0.5);
    expect(applyCrossJourneyRule([], 'min', 0.3)).toBe(0.3);
  });

  it('returns single value unchanged', () => {
    expect(applyCrossJourneyRule([0.7], 'min', 0.5)).toBe(0.7);
    expect(applyCrossJourneyRule([0.7], 'max', 0.5)).toBe(0.7);
    expect(applyCrossJourneyRule([0.7], 'mean', 0.5)).toBe(0.7);
  });

  it('min rule returns minimum', () => {
    expect(applyCrossJourneyRule([0.9, 0.4, 0.7], 'min')).toBe(0.4);
  });

  it('max rule returns maximum', () => {
    expect(applyCrossJourneyRule([0.9, 0.4, 0.7], 'max')).toBe(0.9);
  });

  it('mean rule returns arithmetic mean', () => {
    const result = applyCrossJourneyRule([0.6, 0.9, 0.75], 'mean');
    expect(result).toBeCloseTo(0.75, 5);
  });

  it('defaults to min when rule is undefined (RFC-0018 §5.4)', () => {
    // undefined rule → same as 'min'
    expect(applyCrossJourneyRule([0.9, 0.4, 0.7], undefined)).toBe(0.4);
  });
});

// ── computeJourneyScopedScores ───────────────────────────────────────────

describe('computeJourneyScopedScores — backward-compat: no targetedJourneys (AC #7)', () => {
  it('returns soul/variant fallback when no journeyCtx provided', () => {
    const result = computeJourneyScopedScores('AISDLC-100', 0.6, 0.7, false, undefined);
    expect(result.routingPath).toBe('no-journey-routing');
    expect(result.sa2).toBe(0.6);
    expect(result.ck).toBe(0.7);
    expect(result.er5Elevated).toBe(false);
    expect(result.targetedJourneys).toEqual([]);
    expect(result.aggregationRule).toBeUndefined();
  });

  it('returns soul/variant fallback when work item has no targetedJourneys', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100' }],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.55, 0.65, false, ctx);
    expect(result.routingPath).toBe('no-journey-routing');
    expect(result.sa2).toBe(0.55);
    expect(result.ck).toBe(0.65);
  });

  it('returns soul/variant fallback when work item not in targeting list', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-999', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('no-journey-routing');
  });
});

describe('computeJourneyScopedScores — single-journey routing (AC #1, AC #2, AC #3)', () => {
  it('routes Sα₂ through journey designImperatives (AC #1)', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    // onboarding journey has sa2=0.85 (pre-computed with most-specific-wins)
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('single-journey');
    expect(result.sa2).toBe(0.85); // from journey scores, not fallback
    expect(result.targetedJourneys).toHaveLength(1);
    expect(result.targetedJourneys[0].journeyId).toBe('onboarding');
  });

  it('routes Cκ through journey successMetrics (AC #2)', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    // onboarding journey has ck=0.9 (boosted because completion-rate can be < alertBelow)
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.ck).toBe(0.9); // journey-scoped Cκ, not fallback
  });

  it('elevates Eρ₅ when journey WCAG > soul-default (AC #3)', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        { id: 'AISDLC-100', targetedJourneys: ['spry-engage/daily-task-management'] },
      ],
    });
    // daily-task-management has wcagLevel: AAA > soul-default AA → er5Elevated=true
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.er5Elevated).toBe(true);
  });

  it('does not elevate Eρ₅ when journey WCAG == soul-default', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    // onboarding has wcagLevel: AA == soul-default → er5Elevated=false
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.er5Elevated).toBe(false);
  });

  it('falls back to soul/variant scores when journey has no pre-computed scores', () => {
    const ctx = makeJourneyContext({
      journeyScores: {}, // no pre-computed scores
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.6, 0.7, false, ctx);
    expect(result.routingPath).toBe('single-journey');
    expect(result.sa2).toBe(0.6); // fallback
    expect(result.ck).toBe(0.7); // fallback
    expect(result.er5Elevated).toBe(false); // fallback
  });

  it('handles variant-scoped journey reference', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/annual-test/regulatory-submission'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('single-journey');
    expect(result.sa2).toBe(0.6); // regulatory-submission.sa2
    expect(result.er5Elevated).toBe(true); // regulatory-submission AAA
  });
});

describe('computeJourneyScopedScores — multi-journey aggregation (AC #4)', () => {
  it('applies default min aggregation across multiple journeys', () => {
    // onboarding: sa2=0.85, ck=0.9, er5=false
    // daily-task: sa2=0.7,  ck=0.6, er5=true
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('multi-journey');
    expect(result.sa2).toBe(0.7); // min(0.85, 0.7)
    expect(result.ck).toBe(0.6); // min(0.9, 0.6)
    expect(result.er5Elevated).toBe(true); // true when ANY journey elevates
    expect(result.targetedJourneys).toHaveLength(2);
    expect(result.aggregationRule).toBe('min');
  });

  it('respects per-Soul max aggregation override (AC #4)', () => {
    const ctx = makeJourneyContext({
      configBySoul: {
        'spry-engage': { crossJourneyAggregation: 'max' },
      },
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('multi-journey');
    expect(result.sa2).toBe(0.85); // max(0.85, 0.7)
    expect(result.ck).toBe(0.9); // max(0.9, 0.6)
    expect(result.aggregationRule).toBe('max');
  });

  it('respects per-Soul mean aggregation override', () => {
    const ctx = makeJourneyContext({
      configBySoul: {
        'spry-engage': { crossJourneyAggregation: 'mean' },
      },
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('multi-journey');
    expect(result.sa2).toBeCloseTo(0.775, 5); // mean(0.85, 0.7)
    expect(result.ck).toBeCloseTo(0.75, 5); // mean(0.9, 0.6)
    expect(result.aggregationRule).toBe('mean');
  });

  it('er5Elevated is true when ANY journey in the set elevates', () => {
    // Mix: onboarding (er5=false) + daily-task (er5=true)
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.er5Elevated).toBe(true);
  });

  it('er5Elevated is false when no journey in the set elevates', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-billing/billing-inquiry-resolution'],
        },
      ],
    });
    // both: onboarding.er5Elevated=false, billing.er5Elevated=false
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.er5Elevated).toBe(false);
  });

  it('cross-Soul multi-journey uses min between souls (RFC-0009 §7.2)', () => {
    // spry-engage/onboarding: sa2=0.85, spry-billing/billing-inquiry-resolution: sa2=0.75
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-billing/billing-inquiry-resolution'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('multi-journey');
    expect(result.sa2).toBe(0.75); // min(0.85, 0.75) — cross-soul min
    expect(result.targetedJourneys).toHaveLength(2);
  });

  it('aggregationRule exposed for audit on multi-journey path', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.aggregationRule).toBeDefined();
    expect(['min', 'max', 'mean']).toContain(result.aggregationRule);
  });
});

// ── Conflict resolution: most-specific wins (AC #1, AC #8) ──────────────

describe('computeJourneyScopedScores — conflict resolution + Sα₂ composition (AC #1, AC #8)', () => {
  it('pre-computed sa2 in journeyScores encodes most-specific-wins resolution', () => {
    // The journey-scope router trusts the pre-computed journeyScores.sa2 which
    // was built by the loader implementing most-specific-wins:
    //   journey.designImperatives ∪ variant.designImperatives ∪ soul.designImperatives
    //   (journey overrides variant which overrides soul for conflicting entries)
    // This test verifies the router uses journeyScores.sa2 not the fallback.
    const ctx = makeJourneyContext({
      journeyScores: {
        'spry-engage': {
          onboarding: {
            sa2: 0.92, // journey-resolved value (higher than soul-agg fallback)
            ck: 0.85,
            er5Elevated: false,
          },
        },
      },
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.sa2).toBe(0.92); // journey-scope wins over fallback 0.5
  });

  it('sa2 fallback used when journeyScores has no entry for targeted journey', () => {
    // Simulates a journey declared in journeysBySoul but not yet scored
    const ctx = makeJourneyContext({
      journeyScores: {
        'spry-engage': {
          // onboarding not scored — missing key
          'daily-task-management': { sa2: 0.7, ck: 0.6, er5Elevated: true },
        },
      },
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const fallbackSa2 = 0.55;
    const result = computeJourneyScopedScores('AISDLC-100', fallbackSa2, 0.5, false, ctx);
    expect(result.sa2).toBe(fallbackSa2);
  });
});

// ── Cκ boost pattern (AC #2) ─────────────────────────────────────────────

describe('computeJourneyScopedScores — Cκ boost when completion-rate < alertBelow (AC #2)', () => {
  it('uses elevated ck score when journey is below alertBelow threshold', () => {
    // Journey has ck=0.9 (boosted because current completion-rate < alertBelow)
    // The loader computes the boost; the router trusts journeyScores.ck.
    const ctx = makeJourneyContext({
      journeyScores: {
        'spry-engage': {
          onboarding: {
            sa2: 0.85,
            ck: 0.9, // boosted: completion-rate was 0.42 < alertBelow 0.5
            er5Elevated: false,
          },
        },
      },
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const fallbackCk = 0.5;
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, fallbackCk, false, ctx);
    expect(result.ck).toBe(0.9); // boosted, higher than soul-agg fallback
    expect(result.ck).toBeGreaterThan(fallbackCk);
  });

  it('uses non-boosted ck score when journey metrics are healthy', () => {
    const ctx = makeJourneyContext({
      journeyScores: {
        'spry-engage': {
          onboarding: {
            sa2: 0.85,
            ck: 0.4, // NOT boosted: completion-rate is healthy above alertBelow
            er5Elevated: false,
          },
        },
      },
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const fallbackCk = 0.5;
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, fallbackCk, false, ctx);
    expect(result.ck).toBe(0.4); // journey's ck, below fallback (no boost applied)
  });
});

// ── Eρ₅ elevation integration (AC #3) ───────────────────────────────────

describe('computeJourneyScopedScores — Eρ₅ elevation (AC #3)', () => {
  it('regulatory-submission journey (AAA) elevates Eρ₅ above soul-default (AA)', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/annual-test/regulatory-submission'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.er5Elevated).toBe(true);
  });

  it('onboarding journey (AA) does not elevate when soul-default is also AA', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.er5Elevated).toBe(false);
  });
});

// ── Return shape completeness (AC #8) ────────────────────────────────────

describe('JourneyScopedResult return shape (AC #8)', () => {
  it('single-journey result has aggregationRule undefined', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('single-journey');
    expect(result.aggregationRule).toBeUndefined();
  });

  it('no-journey-routing result has aggregationRule undefined', () => {
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, undefined);
    expect(result.routingPath).toBe('no-journey-routing');
    expect(result.aggregationRule).toBeUndefined();
  });

  it('multi-journey result always has aggregationRule defined', () => {
    const ctx = makeJourneyContext({
      workItemTargeting: [
        {
          id: 'AISDLC-100',
          targetedJourneys: ['spry-engage/onboarding', 'spry-engage/daily-task-management'],
        },
      ],
    });
    const result = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(result.routingPath).toBe('multi-journey');
    expect(result.aggregationRule).toBeDefined();
  });

  it('targetedJourneys is always an array (never undefined)', () => {
    const r1 = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, undefined);
    expect(Array.isArray(r1.targetedJourneys)).toBe(true);

    const ctx = makeJourneyContext({
      workItemTargeting: [{ id: 'AISDLC-100', targetedJourneys: ['spry-engage/onboarding'] }],
    });
    const r2 = computeJourneyScopedScores('AISDLC-100', 0.5, 0.5, false, ctx);
    expect(Array.isArray(r2.targetedJourneys)).toBe(true);
  });
});
