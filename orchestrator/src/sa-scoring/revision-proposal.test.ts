/**
 * Tests for RFC-0031 DIDRevisionProposal mechanism.
 *
 * AC coverage:
 *   AC #1 — DIDRevisionProposal fires from SoulDriftDetected trigger conditions
 *   AC #2 — Drift classifier: healthy / unhealthy / ambiguous per §3
 *   AC #3 — Approval routing by identityClass per §4 (OQ-12.4)
 *   AC #4 — 14-day expiry + DIDRevisionProposalExpired event per §5
 *   AC #5 — lockNoProposal opt-out per OQ-12.3
 *   AC #6 — Rejection learnings + precedent weight per OQ-12.5
 *   AC #7 — Multi-field bundling deferred (one-field-per-proposal shape per OQ-12.2)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDrift,
  deriveApprovalPath,
  computeConfidence,
  evaluateRevisionProposal,
  triggerConditionMet,
  isFieldLocked,
  isProposalExpired,
  archiveExpiredProposals,
  recordRejection,
  computeRejectionPrecedentFactor,
  DEFAULT_DISMISS_THRESHOLD,
  DEFAULT_DEMAND_MISALIGNMENT_THRESHOLD,
  DEFAULT_DRIFT_EVENTS_THRESHOLD,
  DEFAULT_PROPOSAL_EXPIRY_DAYS,
  HEALTHY_ICP_MATCH_MIN,
  UNHEALTHY_ICP_MATCH_MAX,
  type ClassificationEvidence,
  type TriggerConditions,
  type DIDRevisionProposalEvent,
  type ProposalRejectionRecord,
} from './revision-proposal.js';

const NOW_MS = Date.parse('2026-05-13T00:00:00Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ── Shared fixtures ───────────────────────────────────────────────────

function healthyEvidence(overrides?: Partial<ClassificationEvidence>): ClassificationEvidence {
  return {
    demandClusterICPMatchRate: 0.8, // > 0.6 → healthy
    demandClusterChurnCorrelation: 0.7,
    dismissToEscalateRatio: 3.0,
    coreDIDFieldsAffected: false,
    ...overrides,
  };
}

function unhealthyEvidence(overrides?: Partial<ClassificationEvidence>): ClassificationEvidence {
  return {
    demandClusterICPMatchRate: 0.1, // < 0.3 → unhealthy
    demandClusterChurnCorrelation: 0.2,
    dismissToEscalateRatio: 0.5,
    coreDIDFieldsAffected: false,
    ...overrides,
  };
}

function ambiguousEvidence(overrides?: Partial<ClassificationEvidence>): ClassificationEvidence {
  return {
    demandClusterICPMatchRate: 0.45, // between 0.3 and 0.6
    demandClusterChurnCorrelation: 0.4,
    dismissToEscalateRatio: 1.5,
    coreDIDFieldsAffected: false,
    ...overrides,
  };
}

function triggeredConditions(overrides?: Partial<TriggerConditions>): TriggerConditions {
  return {
    dismissSignals: 15, // >= 10 threshold
    escalateSignals: 2,
    demandMisalignment: 0.1,
    driftEvents: 0,
    ...overrides,
  };
}

function makeProposal(overrides?: Partial<DIDRevisionProposalEvent>): DIDRevisionProposalEvent {
  return {
    type: 'DIDRevisionProposal',
    proposalId: 'test-id',
    scope: 'shard',
    shardId: 'acme',
    field: 'soulPurpose.mission',
    currentValue: 'old',
    proposedValue: 'new',
    identityClass: 'evolving',
    classification: 'healthy',
    classificationEvidence: healthyEvidence(),
    triggerEvidence: {
      dismissSignals: 15,
      escalateSignals: 2,
      demandMisalignment: 0.1,
      driftEvents: 1,
      triggerWindow: 'P60D',
    },
    confidence: 'medium',
    approvalPath: 'pillarLead',
    expiresAt: new Date(NOW_MS + 14 * ONE_DAY_MS).toISOString(),
    createdAt: new Date(NOW_MS).toISOString(),
    status: 'pending',
    ...overrides,
  };
}

// ── AC #2: Drift classifier ───────────────────────────────────────────

describe('classifyDrift (AC #2)', () => {
  it('returns healthy when icpMatchRate > 0.6 and no core fields affected', () => {
    expect(classifyDrift(healthyEvidence())).toBe('healthy');
  });

  it('returns unhealthy when icpMatchRate < 0.3', () => {
    expect(classifyDrift(unhealthyEvidence())).toBe('unhealthy');
  });

  it('returns unhealthy when core fields affected + dismissToEscalateRatio < 1.0', () => {
    expect(
      classifyDrift({
        demandClusterICPMatchRate: 0.5, // not in unhealthy range by ICP alone
        demandClusterChurnCorrelation: 0.4,
        dismissToEscalateRatio: 0.8, // < 1.0
        coreDIDFieldsAffected: true, // core field affected
      }),
    ).toBe('unhealthy');
  });

  it('returns healthy even with high ICP match when core fields affected (healthy ICP takes precedence only when NOT core)', () => {
    // coreDIDFieldsAffected=true blocks the healthy path
    expect(
      classifyDrift({
        demandClusterICPMatchRate: 0.9, // > 0.6, but core affected
        demandClusterChurnCorrelation: 0.8,
        dismissToEscalateRatio: 5,
        coreDIDFieldsAffected: true,
      }),
    ).toBe('ambiguous'); // falls through to ambiguous because healthy path blocked
  });

  it('returns ambiguous for middle-ground evidence', () => {
    expect(classifyDrift(ambiguousEvidence())).toBe('ambiguous');
  });

  it('exports correct threshold constants', () => {
    expect(HEALTHY_ICP_MATCH_MIN).toBe(0.6);
    expect(UNHEALTHY_ICP_MATCH_MAX).toBe(0.3);
  });
});

// ── AC #3: Approval routing ───────────────────────────────────────────

describe('deriveApprovalPath (AC #3 + OQ-12.4)', () => {
  it('core identityClass → triad', () => {
    expect(deriveApprovalPath('core', 'healthy')).toBe('triad');
  });

  it('evolving identityClass → pillarLead for healthy drift', () => {
    expect(deriveApprovalPath('evolving', 'healthy')).toBe('pillarLead');
  });

  it('undefined identityClass → triad (safe default per §8)', () => {
    expect(deriveApprovalPath(undefined, 'healthy')).toBe('triad');
  });

  it('ambiguous classification → triad regardless of identityClass (§7 override)', () => {
    expect(deriveApprovalPath('evolving', 'ambiguous')).toBe('triad');
    expect(deriveApprovalPath('core', 'ambiguous')).toBe('triad');
    expect(deriveApprovalPath(undefined, 'ambiguous')).toBe('triad');
  });

  it('unhealthy classification + evolving → pillarLead', () => {
    expect(deriveApprovalPath('evolving', 'unhealthy')).toBe('pillarLead');
  });
});

// ── Confidence calculation (OQ-12.1) ─────────────────────────────────

describe('computeConfidence (OQ-12.1)', () => {
  const largeTrigger = {
    dismissSignals: 18,
    escalateSignals: 5,
    demandMisalignment: 0.4,
    driftEvents: 3,
    triggerWindow: 'P60D',
  };
  const smallTrigger = {
    dismissSignals: 3,
    escalateSignals: 1,
    demandMisalignment: 0.1,
    driftEvents: 0,
    triggerWindow: 'P60D',
  };
  const mediumTrigger = {
    dismissSignals: 8,
    escalateSignals: 2,
    demandMisalignment: 0.2,
    driftEvents: 2,
    triggerWindow: 'P60D',
  };

  it('returns high for large sample + clear classification + evolving', () => {
    expect(computeConfidence(largeTrigger, 'healthy', 'evolving')).toBe('high');
  });

  it('returns low for small sample', () => {
    expect(computeConfidence(smallTrigger, 'healthy', 'evolving')).toBe('low');
  });

  it('returns low for ambiguous classification regardless of sample size', () => {
    expect(computeConfidence(largeTrigger, 'ambiguous', 'evolving')).toBe('low');
  });

  it('returns low for core identityClass (higher stakes, lower confidence)', () => {
    expect(computeConfidence(largeTrigger, 'healthy', 'core')).toBe('low');
  });

  it('returns medium for moderate sample + non-ambiguous + evolving', () => {
    expect(computeConfidence(mediumTrigger, 'healthy', 'evolving')).toBe('medium');
  });
});

// ── Trigger condition evaluation ──────────────────────────────────────

describe('triggerConditionMet', () => {
  it('fires when dismiss signals meet threshold', () => {
    expect(
      triggerConditionMet({
        dismissSignals: 10,
        escalateSignals: 0,
        demandMisalignment: 0,
        driftEvents: 0,
      }),
    ).toBe(true);
  });

  it('does not fire below threshold', () => {
    expect(
      triggerConditionMet({
        dismissSignals: 9,
        escalateSignals: 0,
        demandMisalignment: 0,
        driftEvents: 0,
      }),
    ).toBe(false);
  });

  it('fires when demand misalignment exceeds threshold', () => {
    expect(
      triggerConditionMet({
        dismissSignals: 0,
        escalateSignals: 0,
        demandMisalignment: 0.4,
        driftEvents: 0,
      }),
    ).toBe(true);
  });

  it('fires when drift events meet threshold', () => {
    expect(
      triggerConditionMet({
        dismissSignals: 0,
        escalateSignals: 0,
        demandMisalignment: 0,
        driftEvents: 3,
      }),
    ).toBe(true);
  });

  it('respects configurable thresholds', () => {
    expect(
      triggerConditionMet(
        { dismissSignals: 5, escalateSignals: 0, demandMisalignment: 0, driftEvents: 0 },
        { dismissThreshold: 3 },
      ),
    ).toBe(true);
  });

  it('exports correct default threshold constants', () => {
    expect(DEFAULT_DISMISS_THRESHOLD).toBe(10);
    expect(DEFAULT_DEMAND_MISALIGNMENT_THRESHOLD).toBe(0.3);
    expect(DEFAULT_DRIFT_EVENTS_THRESHOLD).toBe(3);
  });
});

// ── AC #5: lockNoProposal opt-out ─────────────────────────────────────

describe('isFieldLocked (AC #5 + OQ-12.3)', () => {
  it('returns false when lockConfig is empty', () => {
    expect(isFieldLocked('soulPurpose.mission', {})).toBe(false);
  });

  it('returns true when field is in lockNoProposal list', () => {
    expect(isFieldLocked('soulPurpose.mission', { lockNoProposal: ['soulPurpose.mission'] })).toBe(
      true,
    );
  });

  it('returns false when field is not in list', () => {
    expect(
      isFieldLocked('soulPurpose.constraints', { lockNoProposal: ['soulPurpose.mission'] }),
    ).toBe(false);
  });
});

// ── AC #1: evaluateRevisionProposal (main entry point) ───────────────

describe('evaluateRevisionProposal (AC #1)', () => {
  const baseInput = {
    shardId: 'acme',
    field: 'soulPurpose.mission',
    currentValue: 'Help small businesses onboard in under 60 seconds.',
    proposedValue: 'Help SMBs onboard in under 60 seconds with zero code.',
    identityClass: 'evolving' as const,
    now: () => NOW_MS,
  };

  it('returns skipped:locked when field is in lockNoProposal list (AC #5)', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
      lockConfig: { lockNoProposal: ['soulPurpose.mission'] },
    });
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('locked');
    }
  });

  it('returns skipped:no-trigger when conditions not met', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: {
        dismissSignals: 1,
        escalateSignals: 0,
        demandMisalignment: 0,
        driftEvents: 0,
      },
      classificationEvidence: healthyEvidence(),
    });
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('no-trigger');
    }
  });

  it('returns proposal event for healthy drift', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
    });
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      const e = result.event;
      expect(e.type).toBe('DIDRevisionProposal');
      expect(e.scope).toBe('shard');
      expect(e.shardId).toBe('acme');
      expect(e.field).toBe('soulPurpose.mission');
      expect(e.classification).toBe('healthy');
      expect(e.approvalPath).toBe('pillarLead'); // evolving → pillarLead
      expect(e.status).toBe('pending');
      expect(typeof e.proposalId).toBe('string');
      expect(e.proposalId.length).toBeGreaterThan(0);
      expect(e.expiresAt).toBeDefined();
      expect(e.createdAt).toBeDefined();
      // Expiry should be 14 days from now
      const expiryMs = Date.parse(e.expiresAt);
      expect(expiryMs).toBeCloseTo(NOW_MS + DEFAULT_PROPOSAL_EXPIRY_DAYS * ONE_DAY_MS, -3);
    }
  });

  it('returns diagnostic event for unhealthy drift', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions({ driftEvents: 5 }),
      classificationEvidence: unhealthyEvidence(),
    });
    expect(result.kind).toBe('diagnostic');
    if (result.kind === 'diagnostic') {
      const e = result.event;
      expect(e.type).toBe('SoulHealthDiagnostic');
      expect(e.classification).toBe('unhealthy');
      expect(['tighten-admission-threshold', 'review-demand-source']).toContain(e.recommendation);
    }
  });

  it('returns ambiguous result with both events for ambiguous drift', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions(),
      classificationEvidence: ambiguousEvidence(),
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.proposal.type).toBe('DIDRevisionProposal');
      expect(result.proposal.classification).toBe('ambiguous');
      expect(result.proposal.approvalPath).toBe('triad'); // forced for ambiguous
      expect(result.diagnostic.type).toBe('SoulHealthDiagnostic');
    }
  });

  it('forces triad approval for core identityClass (AC #3)', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      identityClass: 'core',
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
    });
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      expect(result.event.approvalPath).toBe('triad');
    }
  });

  it('uses triggerWindow from config in trigger evidence', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
      config: { triggerWindowDays: 90 },
    });
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      expect(result.event.triggerEvidence.triggerWindow).toBe('P90D');
    }
  });

  it('uses custom expiry from config (AC #4)', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
      config: { expiryDays: 7 },
    });
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      const expiryMs = Date.parse(result.event.expiresAt);
      expect(expiryMs).toBeCloseTo(NOW_MS + 7 * ONE_DAY_MS, -3);
    }
  });

  it('scope is always shard (platform proposals not generated per §2.3)', () => {
    const result = evaluateRevisionProposal({
      ...baseInput,
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
    });
    if (result.kind === 'proposal') {
      expect(result.event.scope).toBe('shard');
    }
    if (result.kind === 'ambiguous') {
      expect(result.proposal.scope).toBe('shard');
    }
  });
});

// ── AC #4: Proposal expiry (§9) ───────────────────────────────────────

describe('proposal expiry (AC #4)', () => {
  it('isProposalExpired returns true when past expiresAt', () => {
    const proposal = makeProposal({
      expiresAt: new Date(NOW_MS - ONE_DAY_MS).toISOString(), // expired yesterday
    });
    expect(isProposalExpired(proposal, NOW_MS)).toBe(true);
  });

  it('isProposalExpired returns false before expiresAt', () => {
    const proposal = makeProposal({
      expiresAt: new Date(NOW_MS + ONE_DAY_MS).toISOString(), // expires tomorrow
    });
    expect(isProposalExpired(proposal, NOW_MS)).toBe(false);
  });

  it('archiveExpiredProposals emits DIDRevisionProposalExpired events and marks status expired', () => {
    const expired = makeProposal({
      proposalId: 'expired-id',
      expiresAt: new Date(NOW_MS - ONE_DAY_MS).toISOString(),
      status: 'pending',
    });
    const active = makeProposal({
      proposalId: 'active-id',
      expiresAt: new Date(NOW_MS + 5 * ONE_DAY_MS).toISOString(),
      status: 'pending',
    });

    const result = archiveExpiredProposals([expired, active], NOW_MS);

    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].type).toBe('DIDRevisionProposalExpired');
    expect(result.expired[0].proposalId).toBe('expired-id');

    expect(result.remaining).toHaveLength(2);
    const expiredInRemaining = result.remaining.find((p) => p.proposalId === 'expired-id');
    expect(expiredInRemaining?.status).toBe('expired');

    const activeInRemaining = result.remaining.find((p) => p.proposalId === 'active-id');
    expect(activeInRemaining?.status).toBe('pending');
  });

  it('archiveExpiredProposals skips already-resolved proposals', () => {
    const approved = makeProposal({
      proposalId: 'approved-id',
      expiresAt: new Date(NOW_MS - ONE_DAY_MS).toISOString(), // past expiry
      status: 'approved', // already resolved
    });

    const result = archiveExpiredProposals([approved], NOW_MS);
    // Should not emit expiry event for already-resolved proposals
    expect(result.expired).toHaveLength(0);
    expect(result.remaining[0].status).toBe('approved'); // unchanged
  });

  it('exports correct default expiry constant', () => {
    expect(DEFAULT_PROPOSAL_EXPIRY_DAYS).toBe(14);
  });
});

// ── AC #6: Rejection learnings (OQ-12.5) ─────────────────────────────

describe('rejection learnings (AC #6 + OQ-12.5)', () => {
  it('recordRejection captures rationale + rejection precedent weight', () => {
    const proposal = makeProposal({ confidence: 'high' });
    const record = recordRejection(
      proposal,
      'alex@example.com',
      'DID accurately reflects intent',
      () => NOW_MS,
    );

    expect(record.proposalId).toBe(proposal.proposalId);
    expect(record.field).toBe(proposal.field);
    expect(record.rejectedBy).toBe('alex@example.com');
    expect(record.rationale).toBe('DID accurately reflects intent');
    expect(record.rejectionPrecedentWeight).toBe(0.8); // high confidence → 0.8
    expect(record.rejectedAt).toBe(new Date(NOW_MS).toISOString());
    expect(record.classification).toBe('healthy');
  });

  it('recordRejection maps medium confidence to 0.5 weight', () => {
    const proposal = makeProposal({ confidence: 'medium' });
    const record = recordRejection(proposal, 'dom@example.com', 'not yet', () => NOW_MS);
    expect(record.rejectionPrecedentWeight).toBe(0.5);
  });

  it('recordRejection maps low confidence to 0.2 weight', () => {
    const proposal = makeProposal({ confidence: 'low' });
    const record = recordRejection(proposal, 'morgan@example.com', 'noise', () => NOW_MS);
    expect(record.rejectionPrecedentWeight).toBe(0.2);
  });

  it('computeRejectionPrecedentFactor returns 1.0 when no prior rejections', () => {
    expect(computeRejectionPrecedentFactor('soulPurpose.mission', [])).toBe(1.0);
  });

  it('computeRejectionPrecedentFactor reduces factor for prior high-weight rejections', () => {
    const rejections: ProposalRejectionRecord[] = [
      {
        proposalId: 'p1',
        shardId: 'acme',
        field: 'soulPurpose.mission',
        rejectedBy: 'alex@example.com',
        rationale: 'nope',
        rejectedAt: new Date(NOW_MS).toISOString(),
        classification: 'healthy',
        rejectionPrecedentWeight: 0.8,
      },
    ];
    const factor = computeRejectionPrecedentFactor('soulPurpose.mission', rejections);
    // factor = 1.0 - 0.8 * 0.5 = 0.6
    expect(factor).toBeCloseTo(0.6, 6);
  });

  it('computeRejectionPrecedentFactor clamps to 0.2 minimum', () => {
    const rejections: ProposalRejectionRecord[] = [
      {
        proposalId: 'p1',
        shardId: 'acme',
        field: 'f',
        rejectedBy: 'a',
        rationale: 'r',
        rejectedAt: '',
        classification: 'healthy',
        rejectionPrecedentWeight: 1.6, // artificially high to test clamp
      },
    ];
    const factor = computeRejectionPrecedentFactor('f', rejections);
    expect(factor).toBeGreaterThanOrEqual(0.2);
  });

  it('computeRejectionPrecedentFactor only considers rejections for the given field', () => {
    const rejections: ProposalRejectionRecord[] = [
      {
        proposalId: 'p1',
        shardId: 'acme',
        field: 'OTHER.field',
        rejectedBy: 'a',
        rationale: 'r',
        rejectedAt: '',
        classification: 'healthy',
        rejectionPrecedentWeight: 0.8,
      },
    ];
    // Different field — should not affect result
    expect(computeRejectionPrecedentFactor('soulPurpose.mission', rejections)).toBe(1.0);
  });
});

// ── AC #7: One-field-per-proposal (OQ-12.2 defer) ────────────────────

describe('one-field-per-proposal (AC #7 + OQ-12.2)', () => {
  it('evaluateRevisionProposal targets exactly one field per call', () => {
    // The function signature only accepts one `field`. Multi-field bundling
    // requires separate calls (v2 concern per OQ-12.2). This test confirms
    // each call produces a single-field proposal, not a bundle.
    const result = evaluateRevisionProposal({
      shardId: 'acme',
      field: 'soulPurpose.mission',
      currentValue: 'old',
      proposedValue: 'new',
      identityClass: 'evolving',
      triggerConditions: triggeredConditions(),
      classificationEvidence: healthyEvidence(),
      now: () => NOW_MS,
    });
    expect(result.kind).toBe('proposal');
    if (result.kind === 'proposal') {
      expect(result.event.field).toBe('soulPurpose.mission');
      // No array of fields — one field per proposal in v1
      expect(typeof result.event.field).toBe('string');
    }
  });
});
