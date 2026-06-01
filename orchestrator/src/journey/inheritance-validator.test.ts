/**
 * RFC-0018 Phase 1 — Journey inheritance validator unit tests (AISDLC-465).
 *
 * Covers acceptance criteria:
 *   AC #5: JourneyInheritanceViolation emitted for all 5 violation classes.
 *   AC #7: Journey count thresholds emit correct Decisions.
 *          journey-count-soft-warning at >=10; journey-count-hard-limit-exceeded at >=50.
 *   AC #8: State count thresholds emit correct Decisions.
 *          journey-state-count-soft-warning at >=12 with v1-workaround message;
 *          journey-state-count-hard-limit-exceeded at >=100.
 *   AC #9: Nested journeys[] rejected at schema validation (OQ-3 schema-enforced flat).
 *  AC #10: journey-sub-flow-activation-request Stage A counter wired.
 *  AC #11: Hermetic tests cover all validation paths + per-org override + URI parsing.
 */

import { describe, it, expect } from 'vitest';

import {
  validateJourneyDeclarations,
  hasBlockingJourneyViolations,
  trackSubFlowActivationRequests,
  parseTargetedJourneyRef,
  DEFAULT_JOURNEY_SOFT_WARN_AT,
  DEFAULT_JOURNEY_HARD_LIMIT,
  DEFAULT_STATE_SOFT_WARN_AT,
  DEFAULT_STATE_HARD_LIMIT,
  DEFAULT_STATE_SOFT_WARN_MESSAGE,
  DEFAULT_SUB_FLOW_ACTIVATION_THRESHOLD,
  JOURNEY_INHERITED_LOCKED_FIELDS,
  WCAG_LEVEL_ORDER,
  type JourneyDeclarationInput,
} from './inheritance-validator.js';

// ── Helper factories ────────────────────────────────────────────────────────────

const FIXED_TS = '2026-05-31T00:00:00.000Z';

/** Minimal valid journey with the given number of states. */
function makeJourney(
  id: string,
  stateCount: number = 2,
  overrides: Record<string, unknown> = {},
): JourneyDeclarationInput {
  const states = Array.from({ length: stateCount }, (_, i) =>
    i === stateCount - 1
      ? { id: `state-${i + 1}`, terminal: true, successState: true }
      : { id: `state-${i + 1}`, terminal: false },
  );
  return {
    id,
    scope: 'soul',
    states,
    transitions: [{ from: 'state-1', to: `state-${stateCount}`, trigger: 'complete' }],
    completionCriteria: { kind: 'terminal-success-state', target: `state-${stateCount}` },
    accessibility: { wcagLevel: 'AA', wcagVersion: '2.1', conformanceTarget: 100 },
    ...overrides,
  };
}

/** Build an array of N valid journeys. */
function makeJourneys(n: number): JourneyDeclarationInput[] {
  return Array.from({ length: n }, (_, i) => makeJourney(`journey-${i + 1}`));
}

// ── AC #5: JourneyInheritanceViolation — all 5 violation classes ────────────────

describe('validateJourneyDeclarations — inheritance violations (AC #5)', () => {
  it('emits no events for clean journey declarations', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding')],
      now: FIXED_TS,
    });
    expect(events).toHaveLength(0);
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('detects violations for all locked field names', () => {
    for (const field of JOURNEY_INHERITED_LOCKED_FIELDS) {
      const events = validateJourneyDeclarations({
        soulId: 'spry-engage',
        journeys: [makeJourney('test-journey', 2, { [field]: 'any-value' })],
        now: FIXED_TS,
      });
      const violations = events.filter((e) => e.kind === 'JourneyInheritanceViolation');
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const v = violations.find(
        (e) => e.kind === 'JourneyInheritanceViolation' && e.violationClass === field,
      );
      expect(v).toBeDefined();
      expect(v?.blocking).toBe(true);
    }
  });

  it('violation class 1: emits JourneyInheritanceViolation when complianceRegimes overridden', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding', 2, { complianceRegimes: ['HIPAA'] })],
      now: FIXED_TS,
    });
    const v = events.find(
      (e) => e.kind === 'JourneyInheritanceViolation' && e.violationClass === 'complianceRegimes',
    );
    expect(v).toBeDefined();
    expect(v?.blocking).toBe(true);
    if (v?.kind === 'JourneyInheritanceViolation') {
      expect(v.journeyId).toBe('onboarding');
      expect(v.soulId).toBe('spry-engage');
      expect(v.message).toContain('complianceRegimes');
      expect(v.message).toContain('inherited-and-locked');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('violation class 2: emits JourneyInheritanceViolation when targetAudience overridden', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding', 2, { targetAudience: 'enterprise' })],
      now: FIXED_TS,
    });
    const v = events.find(
      (e) => e.kind === 'JourneyInheritanceViolation' && e.violationClass === 'targetAudience',
    );
    expect(v).toBeDefined();
    expect(v?.blocking).toBe(true);
    if (v?.kind === 'JourneyInheritanceViolation') {
      expect(v.message).toContain('targetAudience');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('violation class 3: emits JourneyInheritanceViolation when substrateInvariants overridden', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding', 2, { substrateInvariants: ['kafka-v2'] })],
      now: FIXED_TS,
    });
    const v = events.find(
      (e) => e.kind === 'JourneyInheritanceViolation' && e.violationClass === 'substrateInvariants',
    );
    expect(v).toBeDefined();
    expect(v?.blocking).toBe(true);
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('violation class 4: emits JourneyInheritanceViolation when variant-scoped complianceFloor is not "inherit"', () => {
    const journey = makeJourney('annual-test', 2, {
      scope: 'variant:annual-test',
      complianceFloor: 'strict',
    });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      now: FIXED_TS,
    });
    const v = events.find(
      (e) => e.kind === 'JourneyInheritanceViolation' && e.violationClass === 'complianceFloor',
    );
    expect(v).toBeDefined();
    expect(v?.blocking).toBe(true);
    if (v?.kind === 'JourneyInheritanceViolation') {
      expect(v.message).toContain('complianceFloor');
      expect(v.message).toContain('inherit');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('does NOT emit complianceFloor violation when variant-scoped and complianceFloor is "inherit"', () => {
    const journey = makeJourney('annual-test', 2, {
      scope: 'variant:annual-test',
      complianceFloor: 'inherit',
    });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyInheritanceViolation')).toBeUndefined();
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('does NOT emit complianceFloor violation for soul-scoped journey (no complianceFloor required)', () => {
    const journey = makeJourney('onboarding', 2, { scope: 'soul' });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyInheritanceViolation')).toBeUndefined();
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('violation class 5: emits JourneyInheritanceViolation when WCAG level lowered below parent', () => {
    const journey = makeJourney('onboarding', 2, {
      accessibility: { wcagLevel: 'A', wcagVersion: '2.1', conformanceTarget: 100 },
    });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      parentWcagLevel: 'AA',
      now: FIXED_TS,
    });
    const v = events.find(
      (e) =>
        e.kind === 'JourneyInheritanceViolation' &&
        e.violationClass === 'wcagLevel-lowered-below-parent',
    );
    expect(v).toBeDefined();
    expect(v?.blocking).toBe(true);
    if (v?.kind === 'JourneyInheritanceViolation') {
      expect(v.message).toContain('lower');
      expect(v.message).toContain('AA');
      expect(v.message).toContain("'A'");
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('does NOT emit violation when WCAG level raised above parent', () => {
    const journey = makeJourney('regulatory', 2, {
      accessibility: { wcagLevel: 'AAA', wcagVersion: '2.1', conformanceTarget: 100 },
    });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      parentWcagLevel: 'AA',
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyInheritanceViolation')).toBeUndefined();
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('does NOT emit WCAG violation when no parentWcagLevel provided', () => {
    const journey = makeJourney('onboarding', 2, {
      accessibility: { wcagLevel: 'A', wcagVersion: '2.1', conformanceTarget: 100 },
    });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      // parentWcagLevel not provided
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyInheritanceViolation')).toBeUndefined();
  });

  it('emits separate violation events for multiple locked field overrides', () => {
    const journey = makeJourney('multi-violation', 2, {
      complianceRegimes: ['GDPR'],
      targetAudience: 'enterprise',
      substrateInvariants: ['kafka-v2'],
    });
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [journey],
      now: FIXED_TS,
    });
    const violations = events.filter((e) => e.kind === 'JourneyInheritanceViolation');
    expect(violations).toHaveLength(3);
    const classes = violations.map((v) =>
      v.kind === 'JourneyInheritanceViolation' ? v.violationClass : null,
    );
    expect(classes).toContain('complianceRegimes');
    expect(classes).toContain('targetAudience');
    expect(classes).toContain('substrateInvariants');
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('includes soulId, journeyId, and timestamp in violation events', () => {
    const events = validateJourneyDeclarations({
      soulId: 'my-soul',
      journeys: [makeJourney('j1', 2, { complianceRegimes: ['SOC2'] })],
      now: FIXED_TS,
    });
    const v = events.find((e) => e.kind === 'JourneyInheritanceViolation');
    expect(v?.timestamp).toBe(FIXED_TS);
    if (v?.kind === 'JourneyInheritanceViolation') {
      expect(v.soulId).toBe('my-soul');
      expect(v.journeyId).toBe('j1');
    }
  });

  it('WCAG level ordering is A < AA < AAA', () => {
    expect(WCAG_LEVEL_ORDER['A']).toBeLessThan(WCAG_LEVEL_ORDER['AA']!);
    expect(WCAG_LEVEL_ORDER['AA']).toBeLessThan(WCAG_LEVEL_ORDER['AAA']!);
  });
});

// ── AC #7: Journey count thresholds ────────────────────────────────────────────

describe('validateJourneyDeclarations — journey count limits (AC #7)', () => {
  it('emits no warning below soft-warn threshold (9 journeys)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(9),
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyCountSoftWarning')).toBeUndefined();
    expect(events.find((e) => e.kind === 'JourneyCountHardLimitExceeded')).toBeUndefined();
  });

  it('emits non-blocking JourneyCountSoftWarning at exactly softWarnAt (10 journeys)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(DEFAULT_JOURNEY_SOFT_WARN_AT),
      now: FIXED_TS,
    });
    const w = events.find((e) => e.kind === 'JourneyCountSoftWarning');
    expect(w).toBeDefined();
    expect(w?.blocking).toBe(false);
    if (w?.kind === 'JourneyCountSoftWarning') {
      expect(w.journeyCount).toBe(DEFAULT_JOURNEY_SOFT_WARN_AT);
      expect(w.threshold).toBe(DEFAULT_JOURNEY_SOFT_WARN_AT);
      expect(w.message).toContain('journey-count-soft-warning');
      expect(w.soulId).toBe('spry-engage');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('emits soft warning at 15 journeys (mid-range)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(15),
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyCountSoftWarning')).toBeDefined();
    expect(events.find((e) => e.kind === 'JourneyCountHardLimitExceeded')).toBeUndefined();
  });

  it('emits no hard-limit event at 49 journeys (just below)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(49),
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyCountHardLimitExceeded')).toBeUndefined();
  });

  it('emits blocking JourneyCountHardLimitExceeded at exactly hardLimit (50 journeys)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(DEFAULT_JOURNEY_HARD_LIMIT),
      now: FIXED_TS,
    });
    const exceeded = events.find((e) => e.kind === 'JourneyCountHardLimitExceeded');
    expect(exceeded).toBeDefined();
    expect(exceeded?.blocking).toBe(true);
    if (exceeded?.kind === 'JourneyCountHardLimitExceeded') {
      expect(exceeded.journeyCount).toBe(DEFAULT_JOURNEY_HARD_LIMIT);
      expect(exceeded.limit).toBe(DEFAULT_JOURNEY_HARD_LIMIT);
      expect(exceeded.message).toContain('journey-count-hard-limit-exceeded');
      expect(exceeded.soulId).toBe('spry-engage');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
    // No soft warning when hard limit fires
    expect(events.find((e) => e.kind === 'JourneyCountSoftWarning')).toBeUndefined();
  });

  it('respects per-org softWarnAt override', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(7),
      limits: { softWarnAt: 7, hardLimit: 100 },
      now: FIXED_TS,
    });
    const w = events.find((e) => e.kind === 'JourneyCountSoftWarning');
    expect(w).toBeDefined();
    if (w?.kind === 'JourneyCountSoftWarning') {
      expect(w.threshold).toBe(7);
    }
  });

  it('respects per-org hardLimit override', () => {
    const events = validateJourneyDeclarations({
      soulId: 'enterprise-soul',
      journeys: makeJourneys(75),
      limits: { softWarnAt: 10, hardLimit: 100 },
      now: FIXED_TS,
    });
    // Below custom hardLimit=100, no hard-limit event
    expect(events.find((e) => e.kind === 'JourneyCountHardLimitExceeded')).toBeUndefined();
    // But soft warn fires
    expect(events.find((e) => e.kind === 'JourneyCountSoftWarning')).toBeDefined();
  });

  it('per-org hardLimit=100 blocks at 100', () => {
    const events = validateJourneyDeclarations({
      soulId: 'enterprise-soul',
      journeys: makeJourneys(100),
      limits: { softWarnAt: 10, hardLimit: 100 },
      now: FIXED_TS,
    });
    const exceeded = events.find((e) => e.kind === 'JourneyCountHardLimitExceeded');
    expect(exceeded).toBeDefined();
    if (exceeded?.kind === 'JourneyCountHardLimitExceeded') {
      expect(exceeded.limit).toBe(100);
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });
});

// ── AC #8: State count thresholds ──────────────────────────────────────────────

describe('validateJourneyDeclarations — state count limits (AC #8)', () => {
  it('emits no warning for journey with 11 states (below soft-warn)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding', 11)],
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyStateCountSoftWarning')).toBeUndefined();
    expect(events.find((e) => e.kind === 'JourneyStateCountHardLimitExceeded')).toBeUndefined();
  });

  it('emits JourneyStateCountSoftWarning at exactly stateSoftWarnAt (12 states)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding', DEFAULT_STATE_SOFT_WARN_AT)],
      now: FIXED_TS,
    });
    const w = events.find((e) => e.kind === 'JourneyStateCountSoftWarning');
    expect(w).toBeDefined();
    expect(w?.blocking).toBe(false);
    if (w?.kind === 'JourneyStateCountSoftWarning') {
      expect(w.stateCount).toBe(DEFAULT_STATE_SOFT_WARN_AT);
      expect(w.threshold).toBe(DEFAULT_STATE_SOFT_WARN_AT);
      expect(w.journeyId).toBe('onboarding');
      expect(w.message).toContain('journey-state-count-soft-warning');
      expect(w.v1WorkaroundMessage).toBe(DEFAULT_STATE_SOFT_WARN_MESSAGE);
      expect(w.v1WorkaroundMessage).toContain('splitting');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('soft-warn message includes v1 workaround reference', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('regulatory', 20)],
      now: FIXED_TS,
    });
    const w = events.find((e) => e.kind === 'JourneyStateCountSoftWarning');
    expect(w).toBeDefined();
    if (w?.kind === 'JourneyStateCountSoftWarning') {
      // OQ-2 resolution: message must include concrete v1 workaround
      expect(w.v1WorkaroundMessage).toContain('handoff terminal states');
    }
  });

  it('emits no hard-limit event at 99 states (just below)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('complex', 99)],
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'JourneyStateCountHardLimitExceeded')).toBeUndefined();
  });

  it('emits blocking JourneyStateCountHardLimitExceeded at exactly stateHardLimit (100 states)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('runaway', DEFAULT_STATE_HARD_LIMIT)],
      now: FIXED_TS,
    });
    const exceeded = events.find((e) => e.kind === 'JourneyStateCountHardLimitExceeded');
    expect(exceeded).toBeDefined();
    expect(exceeded?.blocking).toBe(true);
    if (exceeded?.kind === 'JourneyStateCountHardLimitExceeded') {
      expect(exceeded.stateCount).toBe(DEFAULT_STATE_HARD_LIMIT);
      expect(exceeded.limit).toBe(DEFAULT_STATE_HARD_LIMIT);
      expect(exceeded.journeyId).toBe('runaway');
      expect(exceeded.message).toContain('journey-state-count-hard-limit-exceeded');
      expect(exceeded.message).toContain('sanity-guard');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('respects per-org stateSoftWarnAt override', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('regulated', 8)],
      stateLimits: { softWarnAt: 8, hardLimit: 200 },
      now: FIXED_TS,
    });
    const w = events.find((e) => e.kind === 'JourneyStateCountSoftWarning');
    expect(w).toBeDefined();
    if (w?.kind === 'JourneyStateCountSoftWarning') {
      expect(w.threshold).toBe(8);
    }
  });

  it('respects per-org custom softWarnMessage', () => {
    const customMessage = 'Custom v1 workaround: use handoff states';
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('flow', 15)],
      stateLimits: { softWarnAt: 12, hardLimit: 100, softWarnMessage: customMessage },
      now: FIXED_TS,
    });
    const w = events.find((e) => e.kind === 'JourneyStateCountSoftWarning');
    expect(w).toBeDefined();
    if (w?.kind === 'JourneyStateCountSoftWarning') {
      expect(w.v1WorkaroundMessage).toBe(customMessage);
    }
  });

  it('reports state count per-journey (multiple journeys with high state counts)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [
        makeJourney('flow-a', 15),
        makeJourney('flow-b', 13),
        makeJourney('flow-clean', 5),
      ],
      now: FIXED_TS,
    });
    const warnings = events.filter((e) => e.kind === 'JourneyStateCountSoftWarning');
    expect(warnings).toHaveLength(2);
    const journeyIds = warnings.map((w) =>
      w.kind === 'JourneyStateCountSoftWarning' ? w.journeyId : null,
    );
    expect(journeyIds).toContain('flow-a');
    expect(journeyIds).toContain('flow-b');
    expect(journeyIds).not.toContain('flow-clean');
  });
});

// ── AC #9: Nested journeys rejection (OQ-3) ────────────────────────────────────

describe('validateJourneyDeclarations — nested journey rejection (AC #9)', () => {
  it('emits NestedJourneyRejected when a journey contains a nested journeys[] field', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [
        makeJourney('checkout', 2, {
          journeys: [{ id: 'payment', scope: 'soul' }], // FORBIDDEN
        }),
      ],
      now: FIXED_TS,
    });
    const rejected = events.find((e) => e.kind === 'NestedJourneyRejected');
    expect(rejected).toBeDefined();
    expect(rejected?.blocking).toBe(true);
    if (rejected?.kind === 'NestedJourneyRejected') {
      expect(rejected.journeyId).toBe('checkout');
      expect(rejected.soulId).toBe('spry-engage');
      expect(rejected.message).toContain('nested');
      expect(rejected.message).toContain('sub-journeys');
      expect(rejected.message).toContain('journey-sub-flow-activation-request');
    }
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('does NOT emit NestedJourneyRejected for clean journey declarations', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('onboarding')],
      now: FIXED_TS,
    });
    expect(events.find((e) => e.kind === 'NestedJourneyRejected')).toBeUndefined();
  });

  it('emits NestedJourneyRejected for each journey that has nested journeys', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [
        makeJourney('checkout', 2, { journeys: [{ id: 'payment' }] }),
        makeJourney('onboarding'), // clean
        makeJourney('billing', 2, { journeys: [] }), // empty nested array also rejected
      ],
      now: FIXED_TS,
    });
    const rejected = events.filter((e) => e.kind === 'NestedJourneyRejected');
    expect(rejected).toHaveLength(2); // checkout and billing both have the key
  });

  it('nested journey rejection message includes v1 workaround guidance', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('checkout', 2, { journeys: [] })],
      now: FIXED_TS,
    });
    const rejected = events.find((e) => e.kind === 'NestedJourneyRejected');
    if (rejected?.kind === 'NestedJourneyRejected') {
      expect(rejected.message).toContain('handoff terminal states');
      expect(rejected.message).toContain('userId');
    }
  });
});

// ── AC #10: Sub-flow activation counter (OQ-3) ────────────────────────────────

describe('trackSubFlowActivationRequests — Stage A counter (AC #10)', () => {
  it('returns correct count for a single request', () => {
    const result = trackSubFlowActivationRequests([
      { requestedBy: 'adopter-acme', journeyId: 'checkout', soulId: 'spry-engage' },
    ]);
    expect(result.decision).toBe('journey-sub-flow-activation-request');
    expect(result.distinctAdopterCount).toBe(1);
    expect(result.threshold).toBe(DEFAULT_SUB_FLOW_ACTIVATION_THRESHOLD);
    expect(result.promotedToOperatorReview).toBe(false);
    expect(result.adopters).toContain('adopter-acme');
    expect(result.recommendation).toContain('of 2 required');
  });

  it('deduplicates requests from the same adopter', () => {
    const result = trackSubFlowActivationRequests([
      { requestedBy: 'adopter-acme', journeyId: 'checkout' },
      { requestedBy: 'adopter-acme', journeyId: 'onboarding' }, // same adopter, different journey
    ]);
    expect(result.distinctAdopterCount).toBe(1);
    expect(result.promotedToOperatorReview).toBe(false);
  });

  it('promotes to operator review at threshold (2 distinct adopters)', () => {
    const result = trackSubFlowActivationRequests([
      { requestedBy: 'adopter-acme' },
      { requestedBy: 'adopter-beta' },
    ]);
    expect(result.distinctAdopterCount).toBe(2);
    expect(result.promotedToOperatorReview).toBe(true);
    expect(result.recommendation).toContain('file a follow-on RFC');
    expect(result.adopters).toContain('adopter-acme');
    expect(result.adopters).toContain('adopter-beta');
  });

  it('promotes to operator review at 3 distinct adopters (above threshold)', () => {
    const result = trackSubFlowActivationRequests([
      { requestedBy: 'a' },
      { requestedBy: 'b' },
      { requestedBy: 'c' },
    ]);
    expect(result.distinctAdopterCount).toBe(3);
    expect(result.promotedToOperatorReview).toBe(true);
  });

  it('returns empty for empty request list', () => {
    const result = trackSubFlowActivationRequests([]);
    expect(result.distinctAdopterCount).toBe(0);
    expect(result.promotedToOperatorReview).toBe(false);
    expect(result.adopters).toHaveLength(0);
  });

  it('respects custom threshold override', () => {
    const result = trackSubFlowActivationRequests([{ requestedBy: 'adopter-acme' }], {
      distinctAdopterRequestsThreshold: 1,
    });
    expect(result.threshold).toBe(1);
    expect(result.promotedToOperatorReview).toBe(true);
  });

  it('recommendation message references follow-on RFC at promotion threshold', () => {
    const result = trackSubFlowActivationRequests([{ requestedBy: 'a' }, { requestedBy: 'b' }]);
    expect(result.recommendation).toContain('follow-on RFC');
    expect(result.recommendation).toContain('handoff terminal states');
  });
});

// ── AC #11: URI parsing (soul-scoped + variant-scoped forms) ──────────────────

describe('parseTargetedJourneyRef — URI parsing (AC #11)', () => {
  it('parses soul-scoped URI: soul-id/journey-id', () => {
    const ref = parseTargetedJourneyRef('spry-engage/onboarding');
    expect(ref).not.toBeNull();
    expect(ref?.soulId).toBe('spry-engage');
    expect(ref?.variantId).toBeUndefined();
    expect(ref?.journeyId).toBe('onboarding');
  });

  it('parses variant-scoped URI: soul-id/variant-id/journey-id', () => {
    const ref = parseTargetedJourneyRef('spry-engage/annual-test/backflow-submit');
    expect(ref).not.toBeNull();
    expect(ref?.soulId).toBe('spry-engage');
    expect(ref?.variantId).toBe('annual-test');
    expect(ref?.journeyId).toBe('backflow-submit');
  });

  it('returns null for empty string', () => {
    expect(parseTargetedJourneyRef('')).toBeNull();
  });

  it('returns null for malformed URI (no separator)', () => {
    expect(parseTargetedJourneyRef('spryengage')).toBeNull();
  });

  it('returns null for URI with uppercase characters', () => {
    expect(parseTargetedJourneyRef('SpryEngage/Onboarding')).toBeNull();
  });

  it('returns null for URI with trailing slash', () => {
    expect(parseTargetedJourneyRef('spry-engage/')).toBeNull();
  });

  it('returns null for URI with leading slash', () => {
    expect(parseTargetedJourneyRef('/spry-engage/onboarding')).toBeNull();
  });

  it('parses soul-scoped URI with numeric suffix: soul-id/journey-id', () => {
    const ref = parseTargetedJourneyRef('soul-1/journey-2');
    expect(ref).not.toBeNull();
    expect(ref?.soulId).toBe('soul-1');
    expect(ref?.journeyId).toBe('journey-2');
    expect(ref?.variantId).toBeUndefined();
  });

  it('handles null input gracefully', () => {
    expect(parseTargetedJourneyRef(null as unknown as string)).toBeNull();
  });

  it('handles undefined input gracefully', () => {
    expect(parseTargetedJourneyRef(undefined as unknown as string)).toBeNull();
  });

  it('correctly identifies soul-scoped (2 segments) vs variant-scoped (3 segments)', () => {
    const soulScoped = parseTargetedJourneyRef('acme/signup');
    const variantScoped = parseTargetedJourneyRef('acme/enterprise/signup');
    expect(soulScoped?.variantId).toBeUndefined();
    expect(variantScoped?.variantId).toBe('enterprise');
  });
});

// ── Combined scenarios ─────────────────────────────────────────────────────────

describe('validateJourneyDeclarations — combined scenarios', () => {
  it('returns empty events for empty journeys array', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [],
      now: FIXED_TS,
    });
    expect(events).toHaveLength(0);
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('combines journey count soft-warn AND per-journey inheritance violations', () => {
    const journeyList = makeJourneys(9);
    journeyList.push(makeJourney('bad-j', 2, { complianceRegimes: ['GDPR'] }));
    // 10 journeys: triggers soft-warn; bad-j has inheritance violation

    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: journeyList,
      now: FIXED_TS,
    });

    expect(events.find((e) => e.kind === 'JourneyCountSoftWarning')).toBeDefined();
    expect(events.find((e) => e.kind === 'JourneyInheritanceViolation')).toBeDefined();
    // Soft warn is non-blocking, but inheritance violation is blocking
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });

  it('stamps events with the provided timestamp', () => {
    const ts = '2026-01-15T12:00:00.000Z';
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(DEFAULT_JOURNEY_SOFT_WARN_AT),
      now: ts,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.timestamp === ts)).toBe(true);
  });

  it('defaults timestamp to a non-empty ISO string when now not provided', () => {
    const before = Date.now();
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(DEFAULT_JOURNEY_SOFT_WARN_AT),
    });
    const after = Date.now();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const t = new Date(e.timestamp).getTime();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
  });

  it('handles journey with undefined id gracefully', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [{ id: undefined as unknown as string, complianceRegimes: ['GDPR'] }],
      now: FIXED_TS,
    });
    const violation = events.find((e) => e.kind === 'JourneyInheritanceViolation');
    expect(violation).toBeDefined();
    if (violation?.kind === 'JourneyInheritanceViolation') {
      expect(violation.journeyId).toBe('<unknown>');
    }
  });
});

// ── hasBlockingJourneyViolations helper ────────────────────────────────────────

describe('hasBlockingJourneyViolations', () => {
  it('returns false for empty events array', () => {
    expect(hasBlockingJourneyViolations([])).toBe(false);
  });

  it('returns false when all events are non-blocking (soft warn only)', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: makeJourneys(DEFAULT_JOURNEY_SOFT_WARN_AT),
      now: FIXED_TS,
    });
    expect(hasBlockingJourneyViolations(events)).toBe(false);
  });

  it('returns true when any event is blocking', () => {
    const events = validateJourneyDeclarations({
      soulId: 'spry-engage',
      journeys: [makeJourney('j1', 2, { complianceRegimes: ['GDPR'] })],
      now: FIXED_TS,
    });
    expect(hasBlockingJourneyViolations(events)).toBe(true);
  });
});
