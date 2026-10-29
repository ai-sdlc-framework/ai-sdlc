/**
 * RFC-0018 Phase 6 — InternalAdopter journey reference impl (AISDLC-470) ACs #1-#6, #10.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import _Ajv2020 from 'ajv/dist/2020.js';
import {
  journeysProductA,
  journeysProductB,
  journeysProductC,
  journeysProductD,
  INTERNAL_ADOPTER_JOURNEY_SOULS,
  journeyUri,
  validateJourneyStateMachine,
  buildAuditReports,
  trackCrossSoulCoordinationRequests,
  CROSS_SOUL_COORDINATION_DECISION_KIND,
  type InternalAdopterJourney,
} from './journeys.js';
import { validateJourneyDeclarations } from '../../journey/inheritance-validator.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const schema = JSON.parse(
  readFileSync(new URL('../../../../spec/schemas/journey.v1.schema.json', import.meta.url), 'utf8'),
);
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const ids = (s: { journeys: readonly InternalAdopterJourney[] }) => s.journeys.map((j) => j.id);

describe('journey declarations (AC #1-#4)', () => {
  it('ProductA ships onboarding / daily-task-management / billing-inquiry-resolution', () => {
    expect(ids(journeysProductA)).toEqual([
      'onboarding',
      'daily-task-management',
      'billing-inquiry-resolution',
    ]);
  });
  it('ProductB ships shift-start / route-completion / end-of-shift-handoff', () => {
    expect(ids(journeysProductB)).toEqual([
      'shift-start',
      'route-completion',
      'end-of-shift-handoff',
    ]);
  });
  it('ProductC ships variant-scoped csr vs customer-portal journeys', () => {
    const byId = Object.fromEntries(journeysProductC.journeys.map((j) => [j.id, j]));
    expect(byId['csr-onboarding'].scope).toBe('variant:csr');
    expect(byId['customer-self-service'].scope).toBe('variant:customer-portal');
    expect(byId['dispute-resolution']).toBeDefined();
    expect(journeyUri('product-c', byId['csr-onboarding'])).toBe('product-c/csr/csr-onboarding');
  });
  it('ProductD annual-test journeys elevate to WCAG AAA independently of soul level', () => {
    expect(ids(journeysProductD)).toEqual([
      'submit-test-results',
      'request-extension',
      'view-historical-tests',
    ]);
    for (const j of journeysProductD.journeys) {
      expect(j.scope).toBe('variant:annual-test');
      expect(j.accessibility.wcagLevel).toBe('AAA');
    }
    expect(journeysProductD.soulWcagDefault).toBe('AA');
  });
  it('every journey validates against journey.v1.schema.json', () => {
    for (const soul of INTERNAL_ADOPTER_JOURNEY_SOULS) {
      for (const j of soul.journeys) {
        const ok = validateSchema(JSON.parse(JSON.stringify(j)));
        expect(ok, `${soul.soulId}/${j.id}: ${JSON.stringify(validateSchema.errors)}`).toBe(true);
      }
    }
  });
  it('declarations pass inheritance validation with no blocking events', () => {
    for (const soul of INTERNAL_ADOPTER_JOURNEY_SOULS) {
      const events = validateJourneyDeclarations({
        soulId: soul.soulId,
        journeys: soul.journeys.map((j) => JSON.parse(JSON.stringify(j))),
        parentWcagLevel: soul.soulWcagDefault,
      });
      expect(events.filter((e) => 'blocking' in e && e.blocking)).toEqual([]);
    }
  });
});

describe('state-machine validation (AC #5)', () => {
  it('all InternalAdopter journeys are valid state machines', () => {
    for (const soul of INTERNAL_ADOPTER_JOURNEY_SOULS) {
      for (const j of soul.journeys) {
        expect(validateJourneyStateMachine(j), `${soul.soulId}/${j.id}`).toEqual([]);
      }
    }
  });
  it('detects unreachable states, missing flags, bad targets and dangling transitions', () => {
    const bad: InternalAdopterJourney = {
      ...journeysProductA.journeys[0],
      states: [
        { id: 'a', terminal: false },
        { id: 'a', terminal: false },
        { id: 'orphan', terminal: false },
        { id: 'end', terminal: true },
      ],
      transitions: [
        { from: 'a', to: 'end', trigger: 't' },
        { from: 'end', to: 'a', trigger: 'back' },
        { from: 'a', to: 'ghost', trigger: 'x' },
      ],
      completionCriteria: { kind: 'terminal-success-state', target: 'end' },
    };
    const kinds = validateJourneyStateMachine(bad).map((i) => i.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'duplicate-state-id',
        'unreachable-state',
        'terminal-missing-success-flag',
        'terminal-has-outgoing-transition',
        'unknown-transition-state',
        'no-success-terminal',
        'completion-target-not-success-terminal',
      ]),
    );
  });
});

describe('WCAG audit reports map 1:1 to journeys (AC #6)', () => {
  it('produces exactly one report per journey with a unique target journey URI', () => {
    for (const soul of INTERNAL_ADOPTER_JOURNEY_SOULS) {
      const reports = buildAuditReports(soul);
      expect(reports.map((r) => r.targetJourney)).toEqual(
        soul.journeys.map((j) => journeyUri(soul.soulId, j)),
      );
      expect(new Set(reports.map((r) => r.targetJourney)).size).toBe(soul.journeys.length);
    }
  });
  it('flags journey-level elevation independently of the soul level', () => {
    expect(buildAuditReports(journeysProductD).every((r) => r.elevatedAboveSoul)).toBe(true);
    expect(buildAuditReports(journeysProductA).some((r) => r.elevatedAboveSoul)).toBe(false);
    const c = buildAuditReports(journeysProductC);
    expect(c.find((r) => r.targetJourney.endsWith('dispute-resolution'))?.elevatedAboveSoul).toBe(
      true,
    );
    expect(c.find((r) => r.targetJourney.endsWith('csr-onboarding'))?.elevatedAboveSoul).toBe(
      false,
    );
  });
});

describe('cross-soul coordination Stage A counter (AC #10)', () => {
  it('counts distinct adopters and promotes at >=2 with no activation surface', () => {
    expect(
      trackCrossSoulCoordinationRequests([{ requestedBy: 'a' }, { requestedBy: 'a' }]),
    ).toMatchObject({
      decision: CROSS_SOUL_COORDINATION_DECISION_KIND,
      distinctAdopterCount: 1,
      promotedToOperatorReview: false,
    });
    const r = trackCrossSoulCoordinationRequests([{ requestedBy: 'a' }, { requestedBy: 'b' }]);
    expect(r.promotedToOperatorReview).toBe(true);
    expect(r.adopters).toEqual(['a', 'b']);
    expect(trackCrossSoulCoordinationRequests([], 1).promotedToOperatorReview).toBe(false);
  });
});
