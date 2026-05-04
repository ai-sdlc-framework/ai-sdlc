import { describe, it, expect } from 'vitest';
import type { DesignSystemBinding } from '@ai-sdlc/reference';
import type { AdmissionInput } from './admission-score.js';
import { scoreIssueForAdmission, type AdmissionThresholds } from './admission-score.js';
import { computeAdmissionComposite } from './admission-composite.js';
import { enrichAdmissionInput } from './admission-enrichment.js';
import {
  computePillarBreakdown,
  detectTensions,
  pillarSignalScore,
  type PillarBreakdown,
} from './pillar-breakdown.js';

const DEFAULT_THRESHOLDS: AdmissionThresholds = { minimumScore: 0, minimumConfidence: 0 };

function makeInput(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    issueNumber: 1,
    title: 't',
    body: '### Complexity\n5',
    labels: [],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('pillarSignalScore', () => {
  it('averages values clamped to [0, 1]', () => {
    expect(pillarSignalScore([0.8, 0.6, 0.4])).toBeCloseTo(0.6, 6);
    expect(pillarSignalScore([])).toBe(0);
    expect(pillarSignalScore([5])).toBe(1); // clamped
    expect(pillarSignalScore([-1])).toBe(0); // clamped
  });
});

describe('computePillarBreakdown', () => {
  it('returns three pillars and a shared section', () => {
    const composite = computeAdmissionComposite(makeInput());
    const breakdown = computePillarBreakdown(composite);

    expect(breakdown.product.pillar).toBe('product');
    expect(breakdown.design.pillar).toBe('design');
    expect(breakdown.engineering.pillar).toBe('engineering');

    expect(breakdown.product.governedDimensions).toEqual(['SA-1', 'D-pi', 'HC_explicit']);
    expect(breakdown.design.governedDimensions).toEqual(['ER-4', 'HC_design']);
    expect(breakdown.engineering.governedDimensions).toEqual(['ER-1', 'ER-2', 'ER-3']);

    expect(breakdown.shared.hcComposite).toBeDefined();
  });

  it('AC #4: shared.hcComposite exposes per-channel map', () => {
    const composite = computeAdmissionComposite(
      makeInput({
        labels: ['high'],
        reactionCount: 5,
        designAuthoritySignal: {
          isDesignAuthority: true,
          signalType: 'advances-design-coherence',
        },
      }),
    );
    const breakdown = computePillarBreakdown(composite);
    expect(breakdown.shared.hcComposite.explicit).toBe(1); // 'high' label
    expect(breakdown.shared.hcComposite.consensus).toBe(1); // 5 reactions → centered 1
    expect(breakdown.shared.hcComposite.decision).toBe(0);
    expect(breakdown.shared.hcComposite.design).toBeCloseTo(0.6, 6);
    expect(breakdown.shared.hcComposite.value).toBeCloseTo(Math.tanh(0.71), 6);
  });

  it('AC #5: interpretation strings are stable and snapshot-testable', () => {
    const composite = computeAdmissionComposite(
      makeInput({
        labels: ['spec'], // SA = 0.9
        reactionCount: 10,
        commentCount: 5,
        authorAssociation: 'OWNER',
      }),
    );
    const breakdown = computePillarBreakdown(composite);

    // Each interpretation follows a fixed template.
    expect(breakdown.product.interpretation).toMatch(
      /^(strong|moderate|neutral|weak) Product signal \(\d\.\d{2}\) from mission alignment, demand, and explicit priority$/,
    );
    expect(breakdown.design.interpretation).toMatch(
      /^(strong|moderate|neutral|weak) Design signal \(\d\.\d{2}\) from design-system readiness and design-authority signal$/,
    );
    expect(breakdown.engineering.interpretation).toMatch(
      /^(strong|moderate|neutral|weak) Engineering signal \(\d\.\d{2}\) from complexity feasibility, autonomy gap, and code-area defect risk$/,
    );
  });

  it('product pillar signal reflects soul alignment + demand + HC_explicit', () => {
    const composite = computeAdmissionComposite(
      makeInput({
        labels: ['spec', 'high'], // SA=0.9, HC_explicit=1
        reactionCount: 5,
        commentCount: 5,
        authorAssociation: 'OWNER',
      }),
    );
    const breakdown = computePillarBreakdown(composite);
    expect(breakdown.product.signal).toBeGreaterThan(0.5);
  });

  it('design pillar signal reflects readiness and design authority', () => {
    const composite = computeAdmissionComposite(
      makeInput({
        designSystemContext: {
          catalogCoverage: 0.9,
          tokenCompliance: 0.9,
          baselineCoverage: 0.9,
          inBootstrapPhase: false,
        },
        designAuthoritySignal: {
          isDesignAuthority: true,
          signalType: 'advances-design-coherence',
        },
      }),
    );
    const breakdown = computePillarBreakdown(composite);
    expect(breakdown.design.signal).toBeGreaterThan(0.5);
  });

  it('engineering pillar signal reflects complexity + autonomy + defect risk', () => {
    const easy = computeAdmissionComposite(
      makeInput({
        body: '### Complexity\n2', // baseER = 0.8
        autonomyContext: { currentEarnedLevel: 3, requiredLevel: 1 }, // 1.0
      }),
    );
    const hard = computeAdmissionComposite(
      makeInput({
        body: '### Complexity\n9', // baseER = 0.1
        autonomyContext: { currentEarnedLevel: 0, requiredLevel: 3 }, // 0.1
        codeAreaQuality: {
          defectDensity: 10,
          churnRate: 10,
          prRejectionRate: 10,
          hasFrontendComponents: false,
        }, // defectRisk = 0.5
      }),
    );
    const easyB = computePillarBreakdown(easy);
    const hardB = computePillarBreakdown(hard);
    expect(easyB.engineering.signal).toBeGreaterThan(hardB.engineering.signal);
  });
});

describe('detectTensions', () => {
  function makeBreakdown(p: number, d: number, e: number): PillarBreakdown {
    return {
      product: { pillar: 'product', governedDimensions: [], signal: p, interpretation: '' },
      design: { pillar: 'design', governedDimensions: [], signal: d, interpretation: '' },
      engineering: {
        pillar: 'engineering',
        governedDimensions: [],
        signal: e,
        interpretation: '',
      },
      shared: {
        hcComposite: { explicit: 0, consensus: 0, decision: 0, design: 0, value: 0 },
      },
      tensions: [],
    };
  }

  it('AC #2: product high + design low → PRODUCT_HIGH_DESIGN_LOW with exact action', () => {
    const flags = detectTensions(makeBreakdown(0.85, 0.2, 0.55));
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe('PRODUCT_HIGH_DESIGN_LOW');
    expect(flags[0].suggestedAction).toBe(
      'Product intent is strong but design-system readiness is weak; consider catalog-first work or route through design authority before building.',
    );
  });

  it('product high + engineering low → PRODUCT_HIGH_ENGINEERING_LOW', () => {
    const flags = detectTensions(makeBreakdown(0.85, 0.55, 0.1));
    expect(flags.map((f) => f.type)).toContain('PRODUCT_HIGH_ENGINEERING_LOW');
  });

  it('design high + product low → DESIGN_HIGH_PRODUCT_LOW', () => {
    const flags = detectTensions(makeBreakdown(0.1, 0.85, 0.55));
    expect(flags.map((f) => f.type)).toContain('DESIGN_HIGH_PRODUCT_LOW');
  });

  it('engineering high + product low → ENGINEERING_HIGH_PRODUCT_LOW', () => {
    const flags = detectTensions(makeBreakdown(0.1, 0.55, 0.85));
    expect(flags.map((f) => f.type)).toContain('ENGINEERING_HIGH_PRODUCT_LOW');
  });

  it('AC #3: all three pillars in [0.3, 0.5] → ALL_MEDIUM', () => {
    const flags = detectTensions(makeBreakdown(0.4, 0.4, 0.4));
    expect(flags).toHaveLength(1);
    expect(flags[0].type).toBe('ALL_MEDIUM');
    expect(flags[0].suggestedAction).toBe(
      'All pillars are in the neutral band; the score is likely noise — gather more evidence or defer.',
    );
  });

  it('emits multiple flags when conditions overlap', () => {
    // product high, design low, engineering low → both PRODUCT_HIGH_DESIGN_LOW + PRODUCT_HIGH_ENGINEERING_LOW
    const flags = detectTensions(makeBreakdown(0.9, 0.1, 0.1));
    const types = flags.map((f) => f.type);
    expect(types).toContain('PRODUCT_HIGH_DESIGN_LOW');
    expect(types).toContain('PRODUCT_HIGH_ENGINEERING_LOW');
  });

  it('emits no flags when all pillars are strong and balanced', () => {
    const flags = detectTensions(makeBreakdown(0.8, 0.8, 0.8));
    expect(flags).toEqual([]);
  });

  it('emits no flags when all pillars are weak and balanced (no HIGH/LOW mismatch)', () => {
    const flags = detectTensions(makeBreakdown(0.2, 0.2, 0.2));
    expect(flags).toEqual([]); // all weak but no cross-pillar tension
  });
});

describe('scoreIssueForAdmission — pillarBreakdown required (AC #1)', () => {
  it('every admitted result includes pillarBreakdown', () => {
    const result = scoreIssueForAdmission(makeInput(), DEFAULT_THRESHOLDS);
    expect(result.pillarBreakdown).toBeDefined();
    expect(result.pillarBreakdown.product).toBeDefined();
    expect(result.pillarBreakdown.design).toBeDefined();
    expect(result.pillarBreakdown.engineering).toBeDefined();
    expect(result.pillarBreakdown.shared).toBeDefined();
    expect(Array.isArray(result.pillarBreakdown.tensions)).toBe(true);
  });

  it('every rejected result includes pillarBreakdown', () => {
    const result = scoreIssueForAdmission(makeInput({ labels: ['security-rejected'] }), {
      minimumScore: 0.5,
      minimumConfidence: 0,
    });
    expect(result.admitted).toBe(false);
    expect(result.pillarBreakdown).toBeDefined();
    expect(result.pillarBreakdown.product).toBeDefined();
  });
});

// AISDLC-171 — end-to-end fixture for Alex's RFC-0009 §13 OQ-8 observation.
// Reproduces the three observable states of the
// `pillarBreakdown.shared.hcComposite.{design, designAuthorityConfigured}`
// surface so adopters can tell the wiring is working as intended (per
// RFC-0008 §14.2) — even when `design === 0`.
describe('AISDLC-171 — pillarBreakdown.shared.hcComposite design channel states', () => {
  const dsbWithPrincipals = (principals: string[]): DesignSystemBinding => ({
    apiVersion: 'ai-sdlc.io/v1alpha1' as const,
    kind: 'DesignSystemBinding',
    metadata: { name: 'ds' },
    spec: {
      stewardship: {
        designAuthority: { principals, scope: [] },
        engineeringAuthority: { principals: ['eng'], scope: [] },
      },
      designToolAuthority: 'collaborative',
      tokens: {
        provider: 'p',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor',
      },
      catalog: { provider: 'c' },
      compliance: { coverage: { minimum: 85 } },
    },
  });

  it('preDesignSystem (no DSB) → design=0, designAuthorityConfigured undefined', () => {
    const composite = computeAdmissionComposite(makeInput());
    const breakdown = computePillarBreakdown(composite);
    expect(breakdown.shared.hcComposite.design).toBe(0);
    // Distinct sentinel: undefined means "no DSB at all" — not the
    // "configured but inactive" state Alex flagged in OQ-8.
    expect(breakdown.shared.hcComposite.designAuthorityConfigured).toBeUndefined();
  });

  it('OQ-8 reproduction: DSB has principals, author is not one → design=0, configured=true', () => {
    // This is exactly the scenario Alex filed in RFC-0009 §13 OQ-8 —
    // `stewardship.designAuthority.principals: [name]` is declared,
    // but `pillarBreakdown.shared.hcComposite.design` does not populate.
    // Per RFC-0008 §14.2 this is intentional behavior (only principals
    // can emit HC_design); the `designAuthorityConfigured` flag now
    // surfaces "structure exists but no principal participated" so
    // operators can distinguish this from preDesignSystem.
    const dsb = dsbWithPrincipals(['alice']);
    const enriched = enrichAdmissionInput(
      { ...makeInput(), authorLogin: 'mallory', commenterLogins: ['bob'] },
      { designSystemBinding: dsb, dsbAdoptedAt: '2026-01-01' },
    );
    const composite = computeAdmissionComposite(enriched);
    const breakdown = computePillarBreakdown(composite);
    expect(breakdown.shared.hcComposite.design).toBe(0);
    expect(breakdown.shared.hcComposite.designAuthorityConfigured).toBe(true);
  });

  it('principal participates → design fires at signalType weight, configured=true', () => {
    const dsb = dsbWithPrincipals(['alice']);
    const enriched = enrichAdmissionInput(
      {
        ...makeInput(),
        authorLogin: 'alice',
        labels: ['design/advances-coherence'],
      },
      { designSystemBinding: dsb, dsbAdoptedAt: '2026-01-01' },
    );
    const composite = computeAdmissionComposite(enriched);
    const breakdown = computePillarBreakdown(composite);
    // Base weight for advances-design-coherence is 0.6, no compliance
    // modulation supplied → hcDesign = 0.6.
    expect(breakdown.shared.hcComposite.design).toBeCloseTo(0.6, 6);
    expect(breakdown.shared.hcComposite.designAuthorityConfigured).toBe(true);
  });

  it('empty principals array → design=0, configured=false (DSB without authority structure)', () => {
    const dsb = dsbWithPrincipals([]);
    const enriched = enrichAdmissionInput(
      { ...makeInput(), authorLogin: 'alice' },
      { designSystemBinding: dsb, dsbAdoptedAt: '2026-01-01' },
    );
    const composite = computeAdmissionComposite(enriched);
    const breakdown = computePillarBreakdown(composite);
    expect(breakdown.shared.hcComposite.design).toBe(0);
    expect(breakdown.shared.hcComposite.designAuthorityConfigured).toBe(false);
  });
});
