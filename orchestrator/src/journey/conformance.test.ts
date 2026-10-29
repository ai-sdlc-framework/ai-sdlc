/**
 * RFC-0018 Phase 6 — journey pattern conformance suite (AISDLC-470 AC #8).
 *
 * One block per RFC-0018 §10 OQ resolution plus inheritance, cross-journey
 * aggregation, round-trip, and the cross-soul workaround.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import _Ajv2020 from 'ajv/dist/2020.js';
import {
  validateJourneyDeclarations,
  trackSubFlowActivationRequests,
} from './inheritance-validator.js';
import {
  getLatestMetricSnapshot,
  computeAuditOverdueErho5,
  type MetricSnapshot,
} from './metric-snapshot.js';
import { JourneyStateIdDriftRule } from './state-id-drift-rule.js';
import { createTessellation13Registry } from '../tessellation/rule-registry.js';
import {
  applyCrossJourneyRule,
  computeJourneyScopedScores,
  evaluateWcagVersion,
  validateCompletionCriteriaKind,
  createCustomPredicateDecisionCounter,
  incrementDecisionCounter,
  type JourneyContext,
} from '../journey-sa2-router.js';
import {
  journeysProductA,
  journeysProductB,
  journeyUri,
  trackCrossSoulCoordinationRequests,
  validateJourneyStateMachine,
  type InternalAdopterJourney,
} from '../variant/internal-adopter/journeys.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const schema = JSON.parse(
  readFileSync(new URL('../../../spec/schemas/journey.v1.schema.json', import.meta.url), 'utf8'),
);
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
// Deep-copies a fixture into a mutable, loosely typed declaration (as loaded from YAML).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = (v: unknown): any => JSON.parse(JSON.stringify(v));
const onboarding = journeysProductA.journeys[0];

describe('round-trip', () => {
  it('write -> read -> schema validate', () => {
    const roundTripped = JSON.parse(JSON.stringify(onboarding));
    expect(roundTripped).toEqual(clone(onboarding));
    expect(validateSchema(roundTripped)).toBe(true);
  });
});

describe('OQ-1 journey count limits', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ...clone(onboarding), id: `j-${i}` }));
  it('soft-warns at 10 and hard-limits at 50 (per-org configurable)', () => {
    expect(
      validateJourneyDeclarations({ soulId: 's', journeys: make(10) }).map((e) => e.kind),
    ).toContain('JourneyCountSoftWarning');
    expect(
      validateJourneyDeclarations({ soulId: 's', journeys: make(50) }).map((e) => e.kind),
    ).toContain('JourneyCountHardLimitExceeded');
    expect(
      validateJourneyDeclarations({
        soulId: 's',
        journeys: make(3),
        limits: { softWarnAt: 2 },
      }).map((e) => e.kind),
    ).toContain('JourneyCountSoftWarning');
  });
});

describe('OQ-2 state cardinality', () => {
  it('soft-warns at 12 states and rejects at 100', () => {
    const withStates = (n: number) => ({
      ...clone(onboarding),
      states: Array.from({ length: n }, (_, i) => ({ id: `s-${i}`, terminal: false })),
    });
    expect(
      validateJourneyDeclarations({ soulId: 's', journeys: [withStates(12)] }).map((e) => e.kind),
    ).toContain('JourneyStateCountSoftWarning');
    expect(
      validateJourneyDeclarations({ soulId: 's', journeys: [withStates(100)] }).map((e) => e.kind),
    ).toContain('JourneyStateCountHardLimitExceeded');
  });
});

describe('OQ-3 nested journeys rejected (flat) + sub-flow Stage A counter', () => {
  it('rejects nested journeys[] at validator and schema', () => {
    const nested = { ...clone(onboarding), journeys: [clone(onboarding)] };
    expect(
      validateJourneyDeclarations({ soulId: 's', journeys: [nested] }).map((e) => e.kind),
    ).toContain('NestedJourneyRejected');
    expect(validateSchema(nested)).toBe(false);
  });
  it('promotes at >=2 distinct adopters', () => {
    expect(
      trackSubFlowActivationRequests([{ requestedBy: 'a' }, { requestedBy: 'b' }])
        .promotedToOperatorReview,
    ).toBe(true);
  });
});

describe('OQ-4 completion criteria closed enum', () => {
  it('rejects custom-predicate and counts the activation request', () => {
    expect(validateCompletionCriteriaKind('terminal-success-state').valid).toBe(true);
    expect(validateCompletionCriteriaKind('all-states-reached').valid).toBe(true);
    const r = validateCompletionCriteriaKind('custom-predicate');
    expect(r.valid).toBe(false);
    const counter = createCustomPredicateDecisionCounter();
    incrementDecisionCounter(counter, 'a');
    incrementDecisionCounter(counter, 'b');
    expect(counter.shouldAutoPromote).toBe(true);
    const bad = clone(onboarding) as unknown as { completionCriteria: { kind: string } };
    bad.completionCriteria.kind = 'custom-predicate';
    expect(validateSchema(bad)).toBe(false);
  });
});

describe('OQ-5 stale metrics (warn-and-unknown)', () => {
  const snap = (recordedAt: string): MetricSnapshot => ({
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'MetricSnapshot',
    metadata: { journey: 'product-a/onboarding', metricId: 'completion-rate' },
    spec: { value: 0.4, recordedAt, sourceTool: 'internal-pipeline' },
  });
  const now = '2026-06-30T00:00:00.000Z';
  it('fresh within 30d, stale beyond with Decision, missing when absent', () => {
    const j = 'product-a/onboarding';
    expect(
      getLatestMetricSnapshot(j, 'completion-rate', {
        snapshots: [snap('2026-06-20T00:00:00.000Z')],
        now,
      }).freshness,
    ).toBe('fresh');
    const stale = getLatestMetricSnapshot(j, 'completion-rate', {
      snapshots: [snap('2026-04-01T00:00:00.000Z')],
      now,
    });
    expect(stale.freshness).toBe('stale');
    expect(stale.decision).toBe('journey-metric-stale');
    expect(getLatestMetricSnapshot(j, 'completion-rate', { snapshots: [], now }).freshness).toBe(
      'missing',
    );
  });
});

describe('OQ-6 graduated accessibility cadence', () => {
  const impact = (d: number, policy?: 'graduated' | 'binary-30d' | 'hard-block') =>
    computeAuditOverdueErho5({ soulId: 's', journeyId: 'j', daysOverdue: d, policy });
  it('graduated thresholds emit the right Decision + multiplier', () => {
    expect(impact(-1).decision).toBeNull();
    expect(impact(0)).toMatchObject({ impact: 'warn', erho5Multiplier: 1 });
    expect(impact(30)).toMatchObject({ impact: 'reduced-25', erho5Multiplier: 0.75 });
    expect(impact(60)).toMatchObject({ impact: 'reduced-50', erho5Multiplier: 0.5 });
    expect(impact(90)).toMatchObject({ impact: 'effective-block', erho5Multiplier: 0 });
  });
  it('stricter per-Soul policies', () => {
    expect(impact(29, 'binary-30d').erho5Multiplier).toBe(1);
    expect(impact(30, 'binary-30d').impact).toBe('effective-block');
    expect(impact(0, 'hard-block').impact).toBe('effective-block');
  });
});

describe('OQ-7 WCAG version evolution', () => {
  it('additive enum; 2.0 superseded advisory only', () => {
    expect(schema.properties.accessibility.properties.wcagVersion.enum).toContain('3.0');
    expect(evaluateWcagVersion('2.0')?.advisory).toBe(true);
    expect(evaluateWcagVersion('2.2')).toBeNull();
  });
});

describe('OQ-8 + OQ-10 state-ID drift as 4th rule in the §13 engine', () => {
  const journeysBySoul = {
    'product-b': journeysProductB.journeys.map((j) => ({
      id: j.id,
      states: j.states.map((s) => ({ id: s.id })),
    })),
  };
  it('registers on the shared registry; positive case flags a removed journey state', () => {
    const registry = createTessellation13Registry();
    const rule = new JourneyStateIdDriftRule();
    registry.register(rule);
    const events = rule.scan({
      tessellatedDid: 'did:platform-x:platform',
      substrateFiles: [{ path: 'src/a.ts', contents: `track('shift-active');` }],
      journeysBySoul,
      journeyStatus: { 'product-b/shift-start': 'removed' },
    });
    expect(events).toHaveLength(1);
  });
  it('negative case: active journey state is not drift', () => {
    const events = new JourneyStateIdDriftRule().scan({
      tessellatedDid: 'did:platform-x:platform',
      substrateFiles: [{ path: 'src/a.ts', contents: `track('shift-active');` }],
      journeysBySoul,
    });
    expect(events).toHaveLength(0);
  });
});

describe('OQ-9 cross-soul per-soul-with-handoff', () => {
  it('validates without framework-level cross-soul support', () => {
    const handoff: InternalAdopterJourney = {
      ...clone(onboarding),
      id: 'onboarding-with-handoff',
      states: [
        { id: 'signup', terminal: false },
        { id: 'transitioned-to-product-b', terminal: true, successState: true },
      ],
      transitions: [{ from: 'signup', to: 'transitioned-to-product-b', trigger: 'handoff' }],
      completionCriteria: { kind: 'terminal-success-state', target: 'transitioned-to-product-b' },
    };
    expect(validateJourneyStateMachine(handoff)).toEqual([]);
    expect(validateSchema(clone(handoff))).toBe(true);
    expect(journeyUri('product-a', handoff)).toBe('product-a/onboarding-with-handoff');
  });
  it('Stage A counter has no activation surface (flag only)', () => {
    const r = trackCrossSoulCoordinationRequests([{ requestedBy: 'x' }, { requestedBy: 'y' }]);
    expect(r.decision).toBe('cross-soul-journey-coordination-request');
    expect(r.promotedToOperatorReview).toBe(true);
  });
});

describe('inheritance enforcement', () => {
  it('rejects complianceFloor escape and WCAG-below-parent', () => {
    const escape = {
      ...clone(onboarding),
      scope: 'variant:csr',
      complianceFloor: 'override',
    };
    const lowered = {
      ...clone(onboarding),
      id: 'low',
      accessibility: { ...onboarding.accessibility, wcagLevel: 'A' },
    };
    const kinds = validateJourneyDeclarations({
      soulId: 's',
      journeys: [escape, lowered],
      parentWcagLevel: 'AA',
    }).map((e) => (e.kind === 'JourneyInheritanceViolation' ? e.violationClass : e.kind));
    expect(kinds).toContain('complianceFloor');
    expect(kinds).toContain('wcagLevel-lowered-below-parent');
    expect(validateSchema(escape)).toBe(false);
  });
});

describe('admission scoring composition + cross-journey aggregation', () => {
  const ctx = (rule?: 'min' | 'max' | 'mean'): JourneyContext => ({
    journeysBySoul: { 'product-a': journeysProductA.journeys as never },
    journeyScores: {
      'product-a': {
        onboarding: { sa2: 0.9, ck: 0.8, er5Elevated: false },
        'daily-task-management': { sa2: 0.5, ck: 0.4, er5Elevated: true },
      },
    },
    workItemTargeting: [
      { id: 'T-1', targetedJourneys: ['product-a/onboarding', 'product-a/daily-task-management'] },
      { id: 'T-2', targetedJourneys: ['product-a/daily-task-management'] },
    ],
    configBySoul: rule ? { 'product-a': { crossJourneyAggregation: rule } } : undefined,
  });
  it('routes targetedJourneys to journey-scoped Sa2 / Ck / Er5', () => {
    const r = computeJourneyScopedScores('T-2', 0.1, 0.1, false, ctx());
    expect(r).toMatchObject({
      sa2: 0.5,
      ck: 0.4,
      er5Elevated: true,
      routingPath: 'single-journey',
    });
  });
  it('no targeting -> backward-compatible passthrough', () => {
    expect(computeJourneyScopedScores('T-9', 0.1, 0.2, false, ctx()).routingPath).toBe(
      'no-journey-routing',
    );
  });
  it('defaults to min across journeys; per-Soul override honoured', () => {
    expect(computeJourneyScopedScores('T-1', 0, 0, false, ctx()).sa2).toBe(0.5);
    expect(computeJourneyScopedScores('T-1', 0, 0, false, ctx('max')).sa2).toBe(0.9);
    expect(applyCrossJourneyRule([0.2, 0.4], 'mean')).toBeCloseTo(0.3);
  });
});
