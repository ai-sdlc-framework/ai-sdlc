/**
 * Type-level + runtime tests for RFC-0008 AdmissionInput / PriorityInput
 * extensions (AISDLC-42).
 *
 * These tests exist to lock in the backward-compatibility contract: the
 * extensions MUST be optional so that existing workflows that build
 * AdmissionInput / PriorityInput from minimal GitHub fields continue to
 * compile and score correctly.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import type { PriorityInput } from '@ai-sdlc/reference';
import {
  mapIssueToPriorityInput,
  scoreIssueForAdmission,
  type AdmissionInput,
  type DesignSystemContext,
  type AutonomyContext,
  type CodeAreaQuality,
  type DesignAuthoritySignal,
} from './admission-score.js';

describe('AdmissionInput — RFC-0008 extensions are optional', () => {
  it('legacy AdmissionInput (no RFC-0008 fields) still satisfies the type', () => {
    const legacy: AdmissionInput = {
      issueNumber: 1,
      title: 'Fix bug',
      body: 'something',
      labels: ['bug'],
      reactionCount: 0,
      commentCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(legacy.issueNumber).toBe(1);
    // mapIssueToPriorityInput should accept the legacy shape unchanged
    const p = mapIssueToPriorityInput(legacy);
    expect(p.itemId).toBe('#1');
  });

  it('enriched AdmissionInput accepts all four RFC-0008 context fields', () => {
    const ds: DesignSystemContext = {
      catalogCoverage: 85,
      tokenCompliance: 90,
      inBootstrapPhase: false,
      baselineCoverage: 70,
      catalogGaps: ['Avatar', 'Toast'],
    };
    const au: AutonomyContext = { currentEarnedLevel: 2, requiredLevel: 3 };
    const cq: CodeAreaQuality = {
      defectDensity: 0.02,
      churnRate: 0.15,
      prRejectionRate: 0.05,
      hasFrontendComponents: true,
      designQuality: {
        designCIPassRate: 0.95,
        designReviewRejectionRate: 0.1,
        usabilitySimPassRate: 0.9,
      },
    };
    const da: DesignAuthoritySignal = {
      isDesignAuthority: true,
      signalType: 'advances-design-coherence',
      areaComplianceScore: 0.8,
    };

    const enriched: AdmissionInput = {
      issueNumber: 42,
      title: 't',
      body: 'b',
      labels: [],
      reactionCount: 3,
      commentCount: 1,
      createdAt: '2026-04-01T00:00:00Z',
      designSystemContext: ds,
      autonomyContext: au,
      codeAreaQuality: cq,
      designAuthoritySignal: da,
    };
    expect(enriched.designSystemContext?.catalogGaps).toEqual(['Avatar', 'Toast']);
    expect(enriched.autonomyContext?.requiredLevel).toBe(3);
    expect(enriched.codeAreaQuality?.hasFrontendComponents).toBe(true);
    expect(enriched.designAuthoritySignal?.signalType).toBe('advances-design-coherence');
  });

  it('CodeAreaQuality requires hasFrontendComponents but other fields stay optional', () => {
    const minimal: CodeAreaQuality = { hasFrontendComponents: false };
    expect(minimal.hasFrontendComponents).toBe(false);
    expectTypeOf<CodeAreaQuality>().toHaveProperty('hasFrontendComponents');
  });

  it('scoreIssueForAdmission ignores RFC-0008 fields in Phase 1', () => {
    const enriched: AdmissionInput = {
      issueNumber: 7,
      title: 'enrich me',
      body: '### Complexity\n5',
      labels: ['enhancement'],
      reactionCount: 2,
      commentCount: 1,
      createdAt: '2026-04-01T00:00:00Z',
      // These should be tolerated but not influence the score yet — wiring
      // happens in AISDLC-48.
      designSystemContext: { catalogCoverage: 90, tokenCompliance: 95 },
      autonomyContext: { currentEarnedLevel: 2, requiredLevel: 2 },
      codeAreaQuality: { hasFrontendComponents: false, defectDensity: 0.01 },
      designAuthoritySignal: { isDesignAuthority: false },
    };

    const result = scoreIssueForAdmission(enriched, {
      minimumScore: 0,
      minimumConfidence: 0,
    });
    expect(result.score).toBeDefined();
    expect(result.score.composite).toBeGreaterThan(0);
  });
});

describe('PriorityInput — RFC-0008 extensions are optional', () => {
  it('legacy PriorityInput (no RFC-0008 fields) still satisfies the type', () => {
    const legacy: PriorityInput = {
      itemId: '#1',
      title: 't',
      description: 'd',
      soulAlignment: 0.7,
      complexity: 4,
    };
    expect(legacy.itemId).toBe('#1');
  });

  it('enriched PriorityInput accepts all four new dimension fields', () => {
    const enriched: PriorityInput = {
      itemId: '#1',
      title: 't',
      description: 'd',
      designSystemReadiness: 0.8,
      autonomyFactor: 0.6,
      defectRiskFactor: 0.2,
      designAuthorityWeight: -0.4,
    };
    expect(enriched.designSystemReadiness).toBeCloseTo(0.8, 6);
    expect(enriched.autonomyFactor).toBeCloseTo(0.6, 6);
    expect(enriched.defectRiskFactor).toBeCloseTo(0.2, 6);
    expect(enriched.designAuthorityWeight).toBeCloseTo(-0.4, 6);
  });

  it('designAuthorityWeight permits the full [-1.0, 1.0] range at the type level', () => {
    const neg: PriorityInput = {
      itemId: '#n',
      title: 't',
      description: 'd',
      designAuthorityWeight: -1.0,
    };
    const pos: PriorityInput = {
      itemId: '#p',
      title: 't',
      description: 'd',
      designAuthorityWeight: 1.0,
    };
    expect(neg.designAuthorityWeight).toBe(-1);
    expect(pos.designAuthorityWeight).toBe(1);
  });
});
