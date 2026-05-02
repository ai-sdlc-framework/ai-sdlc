/**
 * Escalation decider tests (RFC-0011 §6.3 + Q4 + Phase 6).
 */

import { describe, expect, it } from 'vitest';
import {
  decideEscalation,
  DOR_ESCALATION_MARKER,
  renderEscalationComment,
  type EscalationDecision,
} from './escalation.js';
import type { RefinementVerdict } from './types.js';

function lowConfidenceVerdict(): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'needs-clarification',
    overallConfidence: 'low',
    gates: [
      {
        gateId: 4,
        verdict: 'fail',
        severity: 'block',
        stage: 'B',
        confidence: 'low',
        finding: 'Scope is not bounded — multiple unrelated changes in one issue.',
      },
    ],
    signedAt: '2026-05-01T12:00:00.000Z',
    evaluatorVersion: 'e2e-stage-b-v1',
    questions: ['Which of these changes is the primary scope?'],
  };
}

function highConfidenceVerdict(): RefinementVerdict {
  return {
    issueId: 'AISDLC-hc',
    rubricVersion: 'v1',
    overallVerdict: 'needs-clarification',
    overallConfidence: 'high',
    gates: [
      {
        gateId: 1,
        verdict: 'fail',
        severity: 'block',
        stage: 'A',
        confidence: 'high',
        finding: 'No checklist found.',
      },
    ],
    signedAt: '2026-05-01T12:00:00.000Z',
    evaluatorVersion: 'e2e-stage-b-v1',
    questions: ['What metric defines success?'],
  };
}

describe('decideEscalation — round-cap trigger (RFC §6.3)', () => {
  it('does not escalate when the round count is at-or-below the cap', () => {
    const r = decideEscalation({ issueId: 'A', roundCount: 3 });
    expect(r.shouldEscalate).toBe(false);
    expect(r.triggers).toEqual([]);
  });

  it('escalates when the round count exceeds the cap', () => {
    const r = decideEscalation({ issueId: 'A', roundCount: 4 });
    expect(r.shouldEscalate).toBe(true);
    expect(r.triggers).toContain('round-cap');
    expect(r.reason).toContain('round-cap');
  });

  it('honors a custom maxRoundsBeforeHumanTriage from config', () => {
    const r = decideEscalation(
      { issueId: 'A', roundCount: 2 },
      { config: { maxRoundsBeforeHumanTriage: 1, triager: '@triager' } },
    );
    expect(r.shouldEscalate).toBe(true);
    expect(r.triggers).toEqual(['round-cap']);
    expect(r.maxRoundsBeforeHumanTriage).toBe(1);
  });
});

describe('decideEscalation — low-confidence trigger (Q4)', () => {
  it('escalates on a low-confidence verdict regardless of round count', () => {
    const r = decideEscalation({
      issueId: 'A',
      roundCount: 0,
      verdict: lowConfidenceVerdict(),
    });
    expect(r.shouldEscalate).toBe(true);
    expect(r.triggers).toEqual(['low-confidence']);
    expect(r.reason).toContain('low-confidence');
  });

  it('does not escalate on a high-confidence verdict at round 0', () => {
    const r = decideEscalation({
      issueId: 'A',
      roundCount: 0,
      verdict: highConfidenceVerdict(),
    });
    expect(r.shouldEscalate).toBe(false);
    expect(r.triggers).toEqual([]);
  });

  it('reports BOTH triggers when round-cap and low-confidence both fire', () => {
    const r = decideEscalation({
      issueId: 'A',
      roundCount: 5,
      verdict: lowConfidenceVerdict(),
    });
    expect(r.shouldEscalate).toBe(true);
    expect(r.triggers).toEqual(['round-cap', 'low-confidence']);
    expect(r.reason).toMatch(/round-cap.*low-confidence/);
  });
});

describe('decideEscalation — routing', () => {
  it('marks unrouted=true when no triager is configured', () => {
    const r = decideEscalation(
      { issueId: 'A', roundCount: 4 },
      { config: { maxRoundsBeforeHumanTriage: 3 } },
    );
    expect(r.shouldEscalate).toBe(true);
    expect(r.unrouted).toBe(true);
    expect(r.triager).toBeUndefined();
  });

  it('surfaces the configured triager and marks unrouted=false', () => {
    const r = decideEscalation(
      { issueId: 'A', roundCount: 4 },
      { config: { maxRoundsBeforeHumanTriage: 3, triager: '@ops-team' } },
    );
    expect(r.shouldEscalate).toBe(true);
    expect(r.unrouted).toBe(false);
    expect(r.triager).toBe('@ops-team');
  });

  it('does not flag unrouted on a no-escalation decision', () => {
    const r = decideEscalation({ issueId: 'A', roundCount: 0 });
    expect(r.shouldEscalate).toBe(false);
    expect(r.unrouted).toBe(false);
  });
});

describe('renderEscalationComment', () => {
  function decision(over: Partial<EscalationDecision> = {}): EscalationDecision {
    return {
      issueId: 'A',
      shouldEscalate: true,
      triggers: ['round-cap'],
      unrouted: false,
      reason: 'round-cap (4 > 3)',
      roundCount: 4,
      maxRoundsBeforeHumanTriage: 3,
      triager: '@ops-team',
      ...over,
    };
  }

  it('emits the marker as the first line', () => {
    const body = renderEscalationComment(decision());
    expect(body.split('\n')[0]).toBe(DOR_ESCALATION_MARKER);
  });

  it('names the triager when configured', () => {
    const body = renderEscalationComment(decision({ triager: '@ops-team' }));
    expect(body).toContain('Routing to @ops-team');
  });

  it('flags unrouted when no triager is configured', () => {
    const body = renderEscalationComment(decision({ triager: undefined, unrouted: true }));
    expect(body).toContain('unrouted');
    expect(body).toContain('No `escalation.triager`');
  });

  it('includes the round-cap context for round-cap triggers', () => {
    const body = renderEscalationComment(decision());
    expect(body).toContain('Round-cap');
    expect(body).toContain('4 clarification rounds');
    expect(body).toContain('cap: 3');
  });

  it('includes the low-confidence context for low-confidence triggers', () => {
    const body = renderEscalationComment(
      decision({
        triggers: ['low-confidence'],
        reason: 'low-confidence verdict (Q4 — never auto-act)',
      }),
      lowConfidenceVerdict(),
    );
    expect(body).toContain('Low-confidence verdict');
    expect(body).toContain('overallConfidence: low');
  });

  it('renders both blocking gate findings and clarifying questions when verdict is supplied', () => {
    const body = renderEscalationComment(decision(), lowConfidenceVerdict());
    expect(body).toContain('Latest verdict — blocking gates');
    expect(body).toContain('Gate 4');
    expect(body).toContain('Scope is not bounded');
    expect(body).toContain('Outstanding clarifying questions');
    expect(body).toContain('Which of these changes is the primary scope?');
  });

  it('omits the blocked-gates and questions sections when no verdict is supplied', () => {
    const body = renderEscalationComment(decision());
    expect(body).not.toContain('Latest verdict — blocking gates');
    expect(body).not.toContain('Outstanding clarifying questions');
  });

  it('redacts secrets from finding text', () => {
    const verdict = lowConfidenceVerdict();
    verdict.gates[0]!.finding = 'leaked token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const body = renderEscalationComment(decision(), verdict);
    expect(body).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('points the triager at the bypass + close + split options from RFC §6.3', () => {
    const body = renderEscalationComment(decision());
    expect(body).toContain('dor-bypass');
    expect(body).toContain('close as not actionable');
    expect(body).toContain('split into smaller issues');
  });
});
