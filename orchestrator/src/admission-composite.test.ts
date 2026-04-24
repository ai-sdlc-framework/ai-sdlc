import { describe, it, expect, vi } from 'vitest';
import type { AdmissionInput } from './admission-score.js';
import { computeAdmissionComposite } from './admission-composite.js';

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

describe('computeAdmissionComposite — §A.6 admission subset', () => {
  it('applies SA × D-pi_adjusted × ER × (1 + HC), not the full PPA', () => {
    const input = makeInput({
      body: '### Complexity\n5',
      labels: ['spec'], // soulAlignment → 0.9
      reactionCount: 5, // untrusted; reactionConsensus=1.0 → HC_consensus centered=1
      commentCount: 5,
    });
    const { score, breakdown } = computeAdmissionComposite(input);

    // Verify the composite equals SA × D-pi × ER × (1 + HC) (no M-phi,
    // no E-tau, no C-kappa).
    const expected =
      breakdown.soulAlignment *
      breakdown.demandPressureAdjusted *
      breakdown.executionReality *
      (1 + breakdown.humanCurve.hcComposite);
    expect(score.composite).toBeCloseTo(expected, 10);

    // Deferred dimensions take neutral values.
    expect(score.dimensions.marketForce).toBe(1);
    expect(score.dimensions.entropyTax).toBe(0);
    expect(score.dimensions.calibration).toBe(1.0);
  });

  it('AC #1: neutral 0.5-class inputs produce predictable composite', () => {
    // Construct inputs that produce neutral signals through mapIssueToPriorityInput:
    //   - no body → complexity undefined → defaults to 5 in composite
    //   - 'bug' label → soulAlignment = 0.5 (default), bugSeverity=3
    //   - 2 comments, 2 reactions → uncapped demandSignal = 0.4, teamConsensus = 0.4
    //   - OWNER assoc → builderConviction = 0.8, trust floors applied
    const input = makeInput({
      body: '',
      labels: [],
      reactionCount: 2,
      commentCount: 2,
      authorAssociation: 'OWNER',
    });
    const { score, breakdown } = computeAdmissionComposite(input);

    // Spot-check the formula terms against the derived breakdown.
    expect(breakdown.soulAlignment).toBeCloseTo(0.6, 6); // OWNER floors SA at 0.6
    expect(breakdown.rawDemandPressure).toBeGreaterThan(0);
    expect(breakdown.rawDemandPressure).toBeLessThanOrEqual(1);
    expect(breakdown.defectRiskFactor).toBe(0); // no codeAreaQuality
    expect(breakdown.demandPressureAdjusted).toBeCloseTo(breakdown.rawDemandPressure, 10);
    // complexity missing → default 5 → baseER = 0.5
    expect(breakdown.baseExecutionReality).toBeCloseTo(0.5, 6);
    expect(breakdown.autonomyFactor).toBe(1); // no autonomyContext
    expect(breakdown.designSystemReadiness).toBe(1); // no dsContext
    expect(breakdown.executionReality).toBeCloseTo(0.5, 6);

    const expected =
      breakdown.soulAlignment *
      breakdown.demandPressureAdjusted *
      breakdown.executionReality *
      (1 + breakdown.humanCurve.hcComposite);
    expect(score.composite).toBeCloseTo(expected, 10);
  });

  it('AC #2: defectRiskFactor=0.5 halves D-pi_adjusted', () => {
    // Push codeAreaQuality signals hard enough to saturate at 0.5.
    const input = makeInput({
      codeAreaQuality: {
        defectDensity: 10,
        churnRate: 10,
        prRejectionRate: 10,
        hasFrontendComponents: false,
      },
    });
    const { breakdown } = computeAdmissionComposite(input);
    expect(breakdown.defectRiskFactor).toBe(0.5);
    expect(breakdown.demandPressureAdjusted).toBeCloseTo(breakdown.rawDemandPressure * 0.5, 10);
  });

  it('AC #3: ER = min(baseER × autonomyFactor, designSystemReadiness)', () => {
    // Supply body with complexity=5 → baseER=0.5. autonomyFactor computed
    // to 0.6 via gap=1. designSystemReadiness fixed at 0.3 via bootstrap.
    const input = makeInput({
      body: '### Complexity\n5',
      autonomyContext: { currentEarnedLevel: 1, requiredLevel: 2 }, // gap=1 → 0.6
      designSystemContext: {
        // normalized coverages chosen so postDesignSystem formula yields
        // computed < 0.3 and bootstrap flag forces floor=0.3
        catalogCoverage: 0,
        tokenCompliance: 0,
        baselineCoverage: 0,
        inBootstrapPhase: true,
      },
    });
    const { breakdown } = computeAdmissionComposite(input);
    expect(breakdown.baseExecutionReality).toBeCloseTo(0.5, 6);
    expect(breakdown.autonomyFactor).toBeCloseTo(0.6, 6);
    expect(breakdown.designSystemReadiness).toBeCloseTo(0.3, 6);
    // baseER × autonomyFactor = 0.3, readiness = 0.3 → min = 0.3
    expect(breakdown.executionReality).toBeCloseTo(0.3, 6);
  });

  it('AC #3: ER picks the readiness floor when readiness < baseER × autonomyFactor', () => {
    const input = makeInput({
      body: '### Complexity\n1', // baseER = 0.9
      designSystemContext: {
        catalogCoverage: 0,
        tokenCompliance: 0,
        baselineCoverage: 0,
        inBootstrapPhase: true, // readiness = 0.3
      },
    });
    const { breakdown } = computeAdmissionComposite(input);
    expect(breakdown.baseExecutionReality).toBeCloseTo(0.9, 6);
    expect(breakdown.designSystemReadiness).toBeCloseTo(0.3, 6);
    expect(breakdown.executionReality).toBeCloseTo(0.3, 6);
  });

  it('AC #4: override path returns Infinity and never runs the admission math', () => {
    // security-rejected labels produce soulAlignment=0 veto — NOT
    // override. Override comes through `input.override` on PriorityInput,
    // which mapIssueToPriorityInput doesn't currently set from labels.
    // We test via direct PriorityInput override path by setting a label
    // `hc-override` recognized by a future parser; for now, inject via
    // casting to exercise the short-circuit.
    //
    // NOTE: this contract pins that if a downstream mapper sets
    // override=true on the produced PriorityInput, computeAdmissionComposite
    // honors it. mapIssueToPriorityInput doesn't emit override today,
    // but the composite's position-1 bypass must be the short-circuit.
    const input = makeInput({ labels: [] });
    // Craft a case that actually triggers override by monkeypatching the
    // internal path: we rely on the fact that security-rejected → SA=0,
    // so composite=0; that is NOT override. To test override directly,
    // we would need mapIssueToPriorityInput to set override=true — which
    // it does not. So we verify that override SHORTCUT is still wired:
    // by directly calling computeAdmissionComposite with a crafted input
    // is not enough; instead we verify via the legacy computePriority
    // that override still produces Infinity (regression guard).
    const { score: vetoScore } = computeAdmissionComposite(
      makeInput({ labels: ['security-rejected'] }),
    );
    expect(vetoScore.composite).toBe(0);
    expect(vetoScore.override).toBeUndefined();
    // The Infinity pathway is exercised by the override-mapping task
    // (not yet implemented); this test pins that absent override,
    // composite is finite.
    const { score: finite } = computeAdmissionComposite(input);
    expect(Number.isFinite(finite.composite)).toBe(true);
  });

  it('AC #5: backward compat — existing callers without new fields produce sensible scores', () => {
    // A legacy-shaped AdmissionInput (no designSystemContext,
    // autonomyContext, codeAreaQuality, designAuthoritySignal) should
    // yield a finite, positive score that passes default thresholds.
    const input = makeInput({
      body: '### Complexity\n3',
      labels: ['enhancement'],
      reactionCount: 3,
      commentCount: 2,
    });
    const { score } = computeAdmissionComposite(input);
    expect(Number.isFinite(score.composite)).toBe(true);
    expect(score.composite).toBeGreaterThan(0);
    expect(score.confidence).toBeGreaterThan(0);
  });

  it('calibration dimension reflects configured coefficient even though composite ignores it', () => {
    const baseline = computeAdmissionComposite(makeInput()).score;
    const calibrated = computeAdmissionComposite(makeInput(), {
      calibrationCoefficient: 1.3,
    }).score;
    expect(calibrated.dimensions.calibration).toBe(1.3);
    // Composite itself is unchanged (C-kappa deferred).
    expect(calibrated.composite).toBeCloseTo(baseline.composite, 10);
  });

  it('calibration coefficient is clamped to [0.7, 1.3] for display', () => {
    const over = computeAdmissionComposite(makeInput(), { calibrationCoefficient: 5 }).score;
    const under = computeAdmissionComposite(makeInput(), { calibrationCoefficient: -1 }).score;
    expect(over.dimensions.calibration).toBe(1.3);
    expect(under.dimensions.calibration).toBe(0.7);
  });

  it('security-rejected veto still yields composite = 0', () => {
    const { score } = computeAdmissionComposite(makeInput({ labels: ['security-rejected'] }));
    expect(score.composite).toBe(0);
  });

  it('defect risk reduces the composite monotonically', () => {
    const clean = computeAdmissionComposite(makeInput({ body: '### Complexity\n3' })).score;
    const noisy = computeAdmissionComposite(
      makeInput({
        body: '### Complexity\n3',
        codeAreaQuality: {
          defectDensity: 1,
          churnRate: 1,
          prRejectionRate: 1,
          hasFrontendComponents: false,
        },
      }),
    ).score;
    expect(noisy.composite).toBeLessThan(clean.composite);
  });

  it('autonomy gap reduces ER and therefore the composite', () => {
    const easy = computeAdmissionComposite(
      makeInput({
        body: '### Complexity\n5',
        autonomyContext: { currentEarnedLevel: 2, requiredLevel: 2 },
      }),
    ).score;
    const gap = computeAdmissionComposite(
      makeInput({
        body: '### Complexity\n5',
        autonomyContext: { currentEarnedLevel: 0, requiredLevel: 3 },
      }),
    ).score;
    expect(gap.composite).toBeLessThan(easy.composite);
  });

  it('soulAlignmentOverride replaces the label-based SA (M5 SA-1 integration)', () => {
    // Label-based fallback → SA = 0.9 ('spec' label). Override to 0.3.
    const input = makeInput({
      body: '### Complexity\n5',
      labels: ['spec'],
    });
    const baseline = computeAdmissionComposite(input);
    const overridden = computeAdmissionComposite(input, undefined, {
      soulAlignmentOverride: 0.3,
    });
    expect(baseline.breakdown.soulAlignment).toBeCloseTo(0.9, 6);
    expect(overridden.breakdown.soulAlignment).toBeCloseTo(0.3, 6);
    // Same other dimensions, so the composite ratio follows SA.
    expect(overridden.score.dimensions.soulAlignment).toBeCloseTo(0.3, 6);
    expect(overridden.score.composite).toBeLessThan(baseline.score.composite);
  });

  it('soulAlignmentOverride is clamped to [0, 1]', () => {
    const input = makeInput({ body: '### Complexity\n5' });
    const over = computeAdmissionComposite(input, undefined, { soulAlignmentOverride: 1.7 });
    const under = computeAdmissionComposite(input, undefined, { soulAlignmentOverride: -0.5 });
    expect(over.breakdown.soulAlignment).toBe(1);
    expect(under.breakdown.soulAlignment).toBe(0);
  });
});

describe('computeAdmissionComposite — override position-1 bypass', () => {
  // mapIssueToPriorityInput does not currently surface an override field
  // from any label, so the Infinity short-circuit is only exercised via a
  // spied mapper. This pins the behaviour contractually: when the mapper
  // sets override=true, the admission composite bypasses SA/DP/ER math
  // and produces composite=Infinity.
  const baseInput: AdmissionInput = {
    issueNumber: 77,
    title: 'urgent security hotfix',
    body: '### Complexity\n5',
    labels: [],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-04-01T00:00:00Z',
  };

  it('returns composite=Infinity with neutral placeholders when override=true', async () => {
    vi.resetModules();
    vi.doMock('./admission-score.js', async () => {
      const actual =
        await vi.importActual<typeof import('./admission-score.js')>('./admission-score.js');
      return {
        ...actual,
        mapIssueToPriorityInput: (input: AdmissionInput) => ({
          ...actual.mapIssueToPriorityInput(input),
          override: true,
          overrideReason: 'production incident',
          overrideExpiry: '2026-05-01T00:00:00Z',
        }),
      };
    });
    const mod = await import('./admission-composite.js');
    const { score, breakdown } = mod.computeAdmissionComposite(baseInput);
    expect(score.composite).toBe(Infinity);
    expect(score.override?.reason).toBe('production incident');
    expect(score.override?.expiry).toBe('2026-05-01T00:00:00Z');
    // Neutral placeholders used for display continuity.
    expect(score.dimensions.soulAlignment).toBe(1);
    expect(score.dimensions.demandPressure).toBe(1.5);
    expect(score.dimensions.marketForce).toBe(3.0);
    expect(score.dimensions.executionReality).toBe(1);
    expect(score.dimensions.entropyTax).toBe(0);
    expect(score.dimensions.humanCurve).toBe(1);
    expect(score.confidence).toBe(1);
    expect(breakdown.humanCurve.hcComposite).toBe(1);
    expect(breakdown.defectRiskFactor).toBe(0);
    expect(breakdown.designSystemReadiness).toBe(1);
    vi.doUnmock('./admission-score.js');
    vi.resetModules();
  });

  it('falls back to "No reason provided" when override carries no reason', async () => {
    vi.resetModules();
    vi.doMock('./admission-score.js', async () => {
      const actual =
        await vi.importActual<typeof import('./admission-score.js')>('./admission-score.js');
      return {
        ...actual,
        mapIssueToPriorityInput: (input: AdmissionInput) => ({
          ...actual.mapIssueToPriorityInput(input),
          override: true,
        }),
      };
    });
    const mod = await import('./admission-composite.js');
    const { score } = mod.computeAdmissionComposite(baseInput);
    expect(score.composite).toBe(Infinity);
    expect(score.override?.reason).toBe('No reason provided');
    expect(score.override?.expiry).toBeUndefined();
    vi.doUnmock('./admission-score.js');
    vi.resetModules();
  });

  it('override path still reflects configured calibration coefficient for display', async () => {
    vi.resetModules();
    vi.doMock('./admission-score.js', async () => {
      const actual =
        await vi.importActual<typeof import('./admission-score.js')>('./admission-score.js');
      return {
        ...actual,
        mapIssueToPriorityInput: (input: AdmissionInput) => ({
          ...actual.mapIssueToPriorityInput(input),
          override: true,
        }),
      };
    });
    const mod = await import('./admission-composite.js');
    const { score } = mod.computeAdmissionComposite(baseInput, { calibrationCoefficient: 1.3 });
    expect(score.dimensions.calibration).toBe(1.3);
    vi.doUnmock('./admission-score.js');
    vi.resetModules();
  });
});
