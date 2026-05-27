/**
 * RFC-0017 Phase 3 — OQ-7 Engineering review routing tests.
 *
 * AC #5: variant declaration triggers Engineering review Decision per OQ-7
 * AC #6: substrate-cost block routes via RFC-0029 actor model (Design + Engineering)
 * AC #7: reviewer-subagent flag on variant declarations without Engineering review Decision
 * AC #8: Integration test — full Engineering review loop
 */

import { describe, it, expect } from 'vitest';

import {
  triggerEngineeringReview,
  checkReviewerGate,
  type VariantDeclarationForReview,
  type EngineeringReviewEvent,
} from './engineering-review.js';

const NOW = new Date('2026-06-01T00:00:00Z');

// ── triggerEngineeringReview tests ───────────────────────────────────────────

describe('triggerEngineeringReview', () => {
  it('AC #5: emits variant-substrate-cost-review for each declared variant', () => {
    const declarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'small-utility',
        designOverrides: { densityProfile: 'comfortable', motionProfile: 'reduced' },
      },
    ];
    const events = triggerEngineeringReview(declarations, NOW);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe('variant-substrate-cost-review');
    expect(ev.soulId).toBe('spry-engage');
    expect(ev.variantId).toBe('small-utility');
    expect(ev.routing.blocking).toBe(false);
    expect(ev.routing.assignedPillar).toBe('engineering');
  });

  it('AC #5: emits variant-substrate-cost-review for multiple declarations', () => {
    const declarations: VariantDeclarationForReview[] = [
      { soulId: 'spry-engage', variantId: 'small-utility' },
      { soulId: 'spry-engage', variantId: 'enterprise' },
      { soulId: 'fleet-manage', variantId: 'field-tech' },
    ];
    const events = triggerEngineeringReview(declarations, NOW);
    expect(events).toHaveLength(3);
    expect(events.every((ev) => ev.kind === 'variant-substrate-cost-review')).toBe(true);
  });

  it('AC #6: emits variant-substrate-cost-block when Engineering flags a concern', () => {
    const declarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'experimental-3d',
        designOverrides: { densityProfile: 'spacious' },
        substrateCostAssessment: {
          blocked: true,
          rationale: 'Requires new 3D rendering pipeline — substrate divergence from soul.',
          estimatedCost: '3 new substrate services',
        },
      },
    ];
    const events = triggerEngineeringReview(declarations, NOW);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe('variant-substrate-cost-review');
    expect(events[1].kind).toBe('variant-substrate-cost-block');

    const blockEvent = events[1];
    expect(blockEvent.kind).toBe('variant-substrate-cost-block');
    expect(blockEvent.soulId).toBe('spry-engage');
    expect(blockEvent.variantId).toBe('experimental-3d');
    // AC #6: routes via RFC-0029 Design+Engineering actor model
    expect(blockEvent.routing.assignedPillar).toBe('design-engineering-operator');
    expect(blockEvent.routing.blocking).toBe(false);
    // Rationale carried through
    if (blockEvent.kind === 'variant-substrate-cost-block') {
      expect(blockEvent.rationale).toContain('3D rendering');
      expect(blockEvent.estimatedCost).toBe('3 new substrate services');
    }
  });

  it('AC #6: does NOT emit block event when assessment.blocked is false', () => {
    const declarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'small-utility',
        substrateCostAssessment: {
          blocked: false,
          rationale: 'No additional substrate cost — tokens only.',
        },
      },
    ];
    const events = triggerEngineeringReview(declarations, NOW);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('variant-substrate-cost-review');
  });

  it('emitDecision callback receives all events', () => {
    const declarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'v1',
        substrateCostAssessment: {
          blocked: true,
          rationale: 'Cost concern.',
        },
      },
    ];
    const captured: EngineeringReviewEvent[] = [];
    triggerEngineeringReview(declarations, NOW, (ev) => captured.push(ev));
    expect(captured).toHaveLength(2);
    expect(captured[0].kind).toBe('variant-substrate-cost-review');
    expect(captured[1].kind).toBe('variant-substrate-cost-block');
  });

  it('ALL emitted events have blocking: false (G0 non-blocking contract)', () => {
    const declarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'v1',
        substrateCostAssessment: { blocked: true, rationale: 'Cost.' },
      },
      { soulId: 'soul-b', variantId: 'v2' },
    ];
    const events = triggerEngineeringReview(declarations, NOW);
    for (const ev of events) {
      expect(ev.routing.blocking).toBe(false);
    }
  });

  it('returns empty array for empty declarations', () => {
    const events = triggerEngineeringReview([], NOW);
    expect(events).toHaveLength(0);
  });
});

// ── checkReviewerGate tests ──────────────────────────────────────────────────

describe('checkReviewerGate', () => {
  it('AC #7: no flags when all staged variants have Engineering review Decisions', () => {
    const result = checkReviewerGate({
      stagedVariants: [
        { soulId: 'spry-engage', variantId: 'small-utility' },
        { soulId: 'spry-engage', variantId: 'enterprise' },
      ],
      existingReviewDecisions: [
        { soulId: 'spry-engage', variantId: 'small-utility' },
        { soulId: 'spry-engage', variantId: 'enterprise' },
      ],
    });
    expect(result.hasCriticalFlags).toBe(false);
    expect(result.flags).toHaveLength(0);
  });

  it('AC #7: critical flag for each staged variant without an Engineering review Decision', () => {
    const result = checkReviewerGate({
      stagedVariants: [
        { soulId: 'spry-engage', variantId: 'new-variant' },
        { soulId: 'spry-engage', variantId: 'another-new' },
      ],
      existingReviewDecisions: [],
    });
    expect(result.hasCriticalFlags).toBe(true);
    expect(result.flags).toHaveLength(2);
    expect(result.flags.every((f) => f.severity === 'critical')).toBe(true);
    const variantIds = result.flags.map((f) => f.variantId).sort();
    expect(variantIds).toEqual(['another-new', 'new-variant']);
  });

  it('AC #7: flags only the variants missing review — partial coverage', () => {
    const result = checkReviewerGate({
      stagedVariants: [
        { soulId: 'spry-engage', variantId: 'reviewed-variant' },
        { soulId: 'spry-engage', variantId: 'unreviewed-variant' },
      ],
      existingReviewDecisions: [{ soulId: 'spry-engage', variantId: 'reviewed-variant' }],
    });
    expect(result.hasCriticalFlags).toBe(true);
    expect(result.flags).toHaveLength(1);
    expect(result.flags[0].variantId).toBe('unreviewed-variant');
    expect(result.flags[0].severity).toBe('critical');
  });

  it('AC #7: soul mismatch means no review match (different soul same variant ID)', () => {
    const result = checkReviewerGate({
      stagedVariants: [{ soulId: 'soul-b', variantId: 'small-utility' }],
      existingReviewDecisions: [
        { soulId: 'soul-a', variantId: 'small-utility' }, // different soul
      ],
    });
    expect(result.hasCriticalFlags).toBe(true);
    expect(result.flags[0].soulId).toBe('soul-b');
  });

  it('returns hasCriticalFlags: false and empty flags for empty stagedVariants', () => {
    const result = checkReviewerGate({
      stagedVariants: [],
      existingReviewDecisions: [],
    });
    expect(result.hasCriticalFlags).toBe(false);
    expect(result.flags).toHaveLength(0);
  });

  it('flag message references RFC-0017 OQ-7 and AISDLC-298', () => {
    const result = checkReviewerGate({
      stagedVariants: [{ soulId: 'spry-engage', variantId: 'v1' }],
      existingReviewDecisions: [],
    });
    const msg = result.flags[0].message;
    expect(msg).toContain('RFC-0017');
    expect(msg).toContain('AISDLC-298');
    expect(msg).toContain('variant-substrate-cost-review');
  });
});

// ── Integration test: full Engineering review loop (AC #8) ───────────────────

describe('full Engineering review loop integration (AC #8)', () => {
  it('simulates complete variant declaration → Engineering review → block → operator resolution', () => {
    // Step 1: New variant declared — trigger cost review
    const declarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'new-3d-variant',
        designOverrides: { densityProfile: 'spacious', motionProfile: 'full' },
      },
    ];
    const reviewEvents = triggerEngineeringReview(declarations, NOW);
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0].kind).toBe('variant-substrate-cost-review');

    // Step 2: Reviewer-subagent gate check — before Engineering review exists in catalog
    const gateResultBefore = checkReviewerGate({
      stagedVariants: [{ soulId: 'spry-engage', variantId: 'new-3d-variant' }],
      existingReviewDecisions: [], // catalog empty
    });
    expect(gateResultBefore.hasCriticalFlags).toBe(true);

    // Step 3: Engineering files the review Decision in catalog — gate passes
    const gateResultAfter = checkReviewerGate({
      stagedVariants: [{ soulId: 'spry-engage', variantId: 'new-3d-variant' }],
      existingReviewDecisions: [
        { soulId: 'spry-engage', variantId: 'new-3d-variant' }, // review now in catalog
      ],
    });
    expect(gateResultAfter.hasCriticalFlags).toBe(false);

    // Step 4: Engineering flags a substrate cost concern (block scenario)
    const blockedDeclarations: VariantDeclarationForReview[] = [
      {
        soulId: 'spry-engage',
        variantId: 'new-3d-variant',
        substrateCostAssessment: {
          blocked: true,
          rationale: 'WebGL pipeline required — substrate diverges from soul.',
          estimatedCost: '2 new shared libraries + GPU budget increase',
        },
      },
    ];
    const blockEvents = triggerEngineeringReview(blockedDeclarations, NOW);
    expect(blockEvents).toHaveLength(2);

    const blockEv = blockEvents.find((e) => e.kind === 'variant-substrate-cost-block');
    expect(blockEv).toBeDefined();
    expect(blockEv!.routing.blocking).toBe(false); // G0: block event must be non-blocking
    expect(blockEv!.routing.assignedPillar).toBe('design-engineering-operator');

    // Step 5: All events confirm G0 non-blocking (AC #3 carries through to this flow)
    const allEvents = [...reviewEvents, ...blockEvents];
    for (const ev of allEvents) {
      expect(ev.routing.blocking).toBe(false);
    }
  });
});
