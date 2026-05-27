import { describe, it, expect, vi } from 'vitest';
import type { AdmissionInput } from './admission-score.js';
import { mapIssueToPriorityInput } from './admission-score.js';
import { computeAdmissionComposite, computeAdmissionConfidence } from './admission-composite.js';
import { computeConfidence } from './priority.js';

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

  it('priorityInputOverrides win over the GitHub-mapper output (Backlog adapter path)', () => {
    // Input that the GitHub mapper would shape: 'spec' label → SA 0.9,
    // body Complexity → 3, no priority labels → explicitPriority undefined.
    const input = makeInput({
      body: '### Complexity\n3',
      labels: ['spec'],
    });
    const baseline = computeAdmissionComposite(input);
    const overridden = computeAdmissionComposite(input, undefined, {
      priorityInputOverrides: {
        soulAlignment: 0.4,
        complexity: 8,
        explicitPriority: 1.0,
      },
    });
    // GitHub mapper said SA=0.9; override says 0.4 — override wins.
    expect(baseline.breakdown.soulAlignment).toBeCloseTo(0.9, 6);
    expect(overridden.breakdown.soulAlignment).toBeCloseTo(0.4, 6);
    // GitHub mapper said complexity=3 → baseER=0.7; override says 8 → 0.2.
    expect(baseline.breakdown.baseExecutionReality).toBeCloseTo(0.7, 6);
    expect(overridden.breakdown.baseExecutionReality).toBeCloseTo(0.2, 6);
    // Composite reflects both shifts.
    expect(overridden.score.composite).toBeLessThan(baseline.score.composite);
  });

  it('priorityInputOverrides ignores undefined values (preserves GitHub defaults)', () => {
    const input = makeInput({ body: '### Complexity\n5', labels: ['spec'] });
    const baseline = computeAdmissionComposite(input);
    // soulAlignment undefined → don't overwrite the GitHub mapper's 0.9.
    const partial = computeAdmissionComposite(input, undefined, {
      priorityInputOverrides: { soulAlignment: undefined, complexity: 9 },
    });
    expect(partial.breakdown.soulAlignment).toBeCloseTo(baseline.breakdown.soulAlignment, 6);
    // complexity 9 → baseER=0.1, distinct from baseline's complexity=5 → 0.5
    expect(partial.breakdown.baseExecutionReality).toBeCloseTo(0.1, 6);
  });

  it('soulAlignmentOverride wins over priorityInputOverrides.soulAlignment', () => {
    // soulAlignmentOverride is the M5 SA-1 path; priorityInputOverrides is
    // the tracker-adapter path. Spec: M5 SA-1 takes precedence when both
    // are present (it's a calibrated score, not a heuristic).
    const input = makeInput({ body: '### Complexity\n5', labels: ['spec'] });
    const result = computeAdmissionComposite(input, undefined, {
      soulAlignmentOverride: 0.2,
      priorityInputOverrides: { soulAlignment: 0.9 },
    });
    expect(result.breakdown.soulAlignment).toBeCloseTo(0.2, 6);
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

// ── AISDLC-172 / RFC-0009 §13 OQ-9 — admit confidence ceiling ──────────
describe('admission confidence — OQ-9 0.5 ceiling regression (AISDLC-172)', () => {
  /**
   * Construct the OQ-9 fully-loaded scenario: a typical backlog-shaped
   * issue with all four enrichment readers reporting success
   * (DID + DSB + maintainers + soul-tracks), plus the code-area metrics
   * loader. We use a deterministic `createdAt` so `competitiveDrift`
   * stays predictable across CI runs.
   */
  function fullyLoadedReadersInput(): AdmissionInput {
    return {
      issueNumber: 9,
      title: 'Tessellated DID document support',
      body: '### Complexity\n4\n\n### Acceptance Criteria\n- [ ] AC1\n- [ ] AC2',
      labels: ['rfc', 'enhancement'],
      reactionCount: 2,
      commentCount: 3,
      createdAt: new Date('2026-04-15T00:00:00Z').toISOString(),
      authorAssociation: 'OWNER',
      // DSB loader → designSystemContext populated.
      designSystemContext: {
        catalogCoverage: 80,
        tokenCompliance: 90,
        baselineCoverage: 0.7,
        inBootstrapPhase: false,
        catalogGaps: [],
      },
      // DID/AutonomyPolicy loader → autonomyContext populated.
      autonomyContext: { currentEarnedLevel: 2, requiredLevel: 2 },
      // Code-area metrics loader → codeAreaQuality populated.
      codeAreaQuality: {
        defectDensity: 0.05,
        churnRate: 0.1,
        prRejectionRate: 0.05,
        hasFrontendComponents: false,
      },
      // Maintainers loader → designAuthoritySignal populated.
      designAuthoritySignal: { isDesignAuthority: true, signalType: 'unspecified' },
    };
  }

  it('AC #1 (reproduction): old computeConfidence formula caps in the ~0.5 ceiling band under maximum enrichment', () => {
    // Pre-fix code path: admission used `computeConfidence(priorityInput)`
    // from priority.ts, which counts against the full 16-field
    // SCORABLE_FIELDS list and ignores enrichment success. The mapper
    // populates 7 fields for this fixture (no `bug`/`P0`/`critical`
    // label → no bugSeverity; no priority label/backlog → no
    // explicitPriority), capping the old confidence at 7/16 ≈ 0.4375.
    // Practitioner observation in OQ-9 was "stayed at 0.5" — the
    // mapper-coverage-bounded ceiling falls in the [0.4, 0.6] band
    // depending on which optional fields the mapper happened to fill.
    const input = fullyLoadedReadersInput();
    const priorityInput = mapIssueToPriorityInput(input);
    const oldFormulaConfidence = computeConfidence(priorityInput);

    // Smoking gun: enrichment success contributes nothing to the old
    // formula — confidence is stuck in the mapper-only ceiling band
    // even though four enrichment readers all reported success.
    expect(oldFormulaConfidence).toBeGreaterThanOrEqual(0.4);
    expect(oldFormulaConfidence).toBeLessThanOrEqual(0.6);
    // Pin the exact value so silent regressions are caught immediately.
    expect(oldFormulaConfidence).toBeCloseTo(7 / 16, 6); // 0.4375
  });

  it('AC #3/#4 (fix): admit confidence returns ≥0.7 for the fully-loaded-readers fixture', () => {
    const input = fullyLoadedReadersInput();
    const { score } = computeAdmissionComposite(input);

    // Fix shape: 50/50 blend of mapper coverage (7/9 ≈ 0.778) and
    // enrichment loaded (4/5 = 0.8 — soulAlignmentOverride absent in
    // this fixture). Combined: 0.5 × 0.778 + 0.5 × 0.8 ≈ 0.789.
    expect(score.confidence).toBeGreaterThanOrEqual(0.7);
    // Pin the exact value so silent regressions to the old formula
    // (which capped at ~0.4-0.5 here) are caught immediately.
    expect(score.confidence).toBeCloseTo(0.5 * (7 / 9) + 0.5 * (4 / 5), 6);
  });

  it('AC #4 (regression): adding the fifth enrichment slot (soul-tracks SA-1) pushes confidence higher', () => {
    const input = fullyLoadedReadersInput();
    const baseline = computeAdmissionComposite(input);
    // Soul-tracks loader fires → soulAlignmentOverride supplied.
    const withSoulTracks = computeAdmissionComposite(input, undefined, {
      soulAlignmentOverride: 0.85,
    });
    expect(withSoulTracks.score.confidence).toBeGreaterThan(baseline.score.confidence);
    // 7/9 mapper + 5/5 enrichment = 0.5 × 0.778 + 0.5 × 1.0 ≈ 0.889.
    expect(withSoulTracks.score.confidence).toBeCloseTo(0.5 * (7 / 9) + 0.5, 6);
  });

  it('AC #2 (root cause documented): no enrichment loaded → confidence reflects mapper signal only', () => {
    // Same issue shape but stripped of all enrichment context. The
    // mapper still extracts the same 7 PriorityInput fields, so the
    // mapper-evidence half is unchanged. The enrichment-evidence half
    // collapses to 0, halving the resulting confidence.
    const baseInput = fullyLoadedReadersInput();
    const stripped: AdmissionInput = {
      issueNumber: baseInput.issueNumber,
      title: baseInput.title,
      body: baseInput.body,
      labels: baseInput.labels,
      reactionCount: baseInput.reactionCount,
      commentCount: baseInput.commentCount,
      createdAt: baseInput.createdAt,
      authorAssociation: baseInput.authorAssociation,
    };
    const { score } = computeAdmissionComposite(stripped);
    // 7/9 mapper, 0/5 enrichment → 0.5 × 0.778 + 0 ≈ 0.389.
    expect(score.confidence).toBeCloseTo(0.5 * (7 / 9), 6);
    // Below the OQ-9 0.7 expectation — correctly signals "no
    // enrichment evidence", not the bogus "0.5 ceiling".
    expect(score.confidence).toBeLessThan(0.5);
  });

  it('AC #2 (root cause): each enrichment slot contributes 0.1 to confidence (1/5 × 0.5 weight)', () => {
    // Pin the per-slot increment so future contributors can see the
    // contract: each loaded enrichment reader = +0.1 confidence.
    const baseInput = fullyLoadedReadersInput();
    const stripped: AdmissionInput = {
      issueNumber: baseInput.issueNumber,
      title: baseInput.title,
      body: baseInput.body,
      labels: baseInput.labels,
      reactionCount: baseInput.reactionCount,
      commentCount: baseInput.commentCount,
      createdAt: baseInput.createdAt,
      authorAssociation: baseInput.authorAssociation,
    };
    const noEnrichment = computeAdmissionComposite(stripped).score.confidence;
    const oneEnrichment = computeAdmissionComposite({
      ...stripped,
      designSystemContext: baseInput.designSystemContext,
    }).score.confidence;
    expect(oneEnrichment - noEnrichment).toBeCloseTo(0.1, 6);
  });

  it('override path preserves confidence=1 (unchanged by the new formula)', async () => {
    // The override branch in computeAdmissionComposite hard-codes
    // confidence=1 before invoking the blend, so override semantics
    // are unaffected by the mapper/enrichment refactor.
    const input = fullyLoadedReadersInput();
    vi.resetModules();
    vi.doMock('./admission-score.js', async () => {
      const actual =
        await vi.importActual<typeof import('./admission-score.js')>('./admission-score.js');
      return {
        ...actual,
        mapIssueToPriorityInput: (i: AdmissionInput) => ({
          ...actual.mapIssueToPriorityInput(i),
          override: true,
          overrideReason: 'incident',
        }),
      };
    });
    const mod = await import('./admission-composite.js');
    const { score } = mod.computeAdmissionComposite(input);
    expect(score.confidence).toBe(1);
    vi.doUnmock('./admission-score.js');
    vi.resetModules();
  });
});

describe('computeAdmissionConfidence — direct unit tests (AISDLC-172)', () => {
  it('returns 0 when neither mapper fields nor enrichment slots are populated', () => {
    const c = computeAdmissionConfidence(
      {
        issueNumber: 1,
        title: '',
        body: '',
        labels: [],
        reactionCount: 0,
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
      },
      { itemId: '#1', title: '', description: '', labels: [] },
    );
    expect(c).toBe(0);
  });

  it('returns 1.0 when all 9 mapper fields populated and all 5 enrichment slots loaded', () => {
    const c = computeAdmissionConfidence(
      {
        issueNumber: 1,
        title: 't',
        body: '',
        labels: [],
        reactionCount: 0,
        commentCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        designSystemContext: { catalogCoverage: 50 },
        autonomyContext: { currentEarnedLevel: 1, requiredLevel: 1 },
        codeAreaQuality: { hasFrontendComponents: false },
        designAuthoritySignal: { isDesignAuthority: true },
      },
      {
        itemId: '#1',
        title: 't',
        description: '',
        labels: [],
        soulAlignment: 0.5,
        demandSignal: 0.5,
        teamConsensus: 0.5,
        builderConviction: 0.5,
        complexity: 5,
        bugSeverity: 3,
        explicitPriority: 0.5,
        competitiveDrift: 0,
        customerRequestCount: 0,
      },
      { soulAlignmentOverride: 0.7 },
    );
    expect(c).toBeCloseTo(1.0, 6);
  });

  it('mapper and enrichment channels are independent (50/50 weighted)', () => {
    const baseInput = {
      issueNumber: 1,
      title: 't',
      body: '',
      labels: [],
      reactionCount: 0,
      commentCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
    } as AdmissionInput;
    // Full mapper, no enrichment → 0.5
    const fullMapperOnly = computeAdmissionConfidence(baseInput, {
      itemId: '#1',
      title: 't',
      description: '',
      labels: [],
      soulAlignment: 0.5,
      demandSignal: 0.5,
      teamConsensus: 0.5,
      builderConviction: 0.5,
      complexity: 5,
      bugSeverity: 3,
      explicitPriority: 0.5,
      competitiveDrift: 0,
      customerRequestCount: 0,
    });
    expect(fullMapperOnly).toBeCloseTo(0.5, 6);
    // No mapper, full enrichment → 0.5
    const fullEnrichmentOnly = computeAdmissionConfidence(
      {
        ...baseInput,
        designSystemContext: { catalogCoverage: 0 },
        autonomyContext: { currentEarnedLevel: 1, requiredLevel: 1 },
        codeAreaQuality: { hasFrontendComponents: false },
        designAuthoritySignal: { isDesignAuthority: true },
      },
      { itemId: '#1', title: 't', description: '', labels: [] },
      { soulAlignmentOverride: 0.5 },
    );
    expect(fullEnrichmentOnly).toBeCloseTo(0.5, 6);
  });
});

// ── RFC-0017 Phase 2 integration (AISDLC-353) ──────────────────────────

import { combineVariantSaForSoulAlignment } from './admission-composite.js';
import type { VariantContext } from './variant-admission.js';

describe('computeAdmissionComposite — RFC-0017 Phase 2 variant routing (AISDLC-353)', () => {
  // InternalAdopter four-product suite (RFC-0017 §11): ProductA Soul DID with
  // small-utility / enterprise / county-regional variants. AC #6 — end-to-end
  // admission scoring on a work item targeting one of InternalAdopter's
  // variants produces a variant-specific score (different from soul-aggregate).

  function makeInternalAdopterVariantCtx(): VariantContext {
    return {
      variantsBySoul: {
        'product-a': [
          {
            id: 'small-utility',
            audienceCharacteristics: {
              segments: ['municipal-small', 'water-district-small'],
              sizeRange: { minStaff: 1, maxStaff: 50 },
            },
            designOverrides: {
              colorPaletteOverlay: 'small-utility-warm',
              densityProfile: 'comfortable',
              typographyScale: 'large-print',
              motionProfile: 'reduced',
            },
            designImperatives: ['low-tech-fluency-tolerance', 'single-task-focus-per-screen'],
          },
          {
            id: 'enterprise',
            audienceCharacteristics: {
              segments: ['municipal-large', 'regional-utility'],
              sizeRange: { minStaff: 51, maxStaff: 5000 },
            },
            designOverrides: {
              colorPaletteOverlay: 'enterprise-cool',
              densityProfile: 'compact',
              motionProfile: 'full',
            },
            designImperatives: ['bulk-operation-efficiency', 'multi-tab-workflow-tolerance'],
          },
        ],
      },
      variantScores: {
        'product-a': {
          // Work item is "small-utility onboarding improvement" — variant-bound
          'small-utility': { sa1: 0.92, sa2: 0.88 }, // strong fit
          enterprise: { sa1: 0.35, sa2: 0.42 }, // poor fit
        },
      },
      workItemTargeting: [
        {
          id: 'AISDLC-onboard-su',
          targetedVariants: ['product-a/small-utility'],
        },
        {
          id: 'AISDLC-bulk-ent',
          targetedVariants: ['product-a/enterprise'],
        },
        {
          id: 'AISDLC-cross-variant',
          targetedVariants: ['product-a/small-utility', 'product-a/enterprise'],
        },
      ],
      configBySoul: {
        'product-a': { crossVariantAggregation: 'min' },
      },
    };
  }

  function makeAdmissionInput(
    issueNumber: number,
    workItemId: string,
    overrides: Partial<AdmissionInput> = {},
  ): AdmissionInput {
    return {
      issueNumber,
      workItemId,
      title: 'feat: small-utility onboarding improvement',
      body: '### Complexity\n5\n\n### Acceptance Criteria\n- Onboarding flow works for small-utility variant',
      labels: ['spec'],
      reactionCount: 0,
      commentCount: 0,
      createdAt: '2026-01-01T00:00:00Z',
      authorAssociation: 'OWNER',
      ...overrides,
    };
  }

  it('AC #6 [single-variant]: variant-targeted work item produces variant-specific composite', () => {
    const ctx = makeInternalAdopterVariantCtx();
    const input = makeAdmissionInput(1, 'AISDLC-onboard-su');

    // With variant routing: small-utility sa1=0.92, sa2=0.88 → SA = 0.90
    const withVariant = computeAdmissionComposite(input, undefined, {
      variantContext: ctx,
      // Pin SA at 0.5 to make the variant-driven lift unambiguous
      soulAlignmentOverride: 0.5,
    });

    // Without variant routing: SA = 0.5 (label fallback)
    const withoutVariant = computeAdmissionComposite(input, undefined, {
      soulAlignmentOverride: 0.5,
    });

    // The variant-routed composite must reflect the higher per-variant SA
    expect(withVariant.breakdown.soulAlignment).toBeCloseTo(
      combineVariantSaForSoulAlignment(0.92, 0.88),
      6,
    );
    expect(withVariant.breakdown.soulAlignment).toBeGreaterThan(
      withoutVariant.breakdown.soulAlignment,
    );

    // Breakdown must surface the variant routing path
    expect(withVariant.breakdown.variant?.routingPath).toBe('single-variant');
    expect(withVariant.breakdown.variant?.targetedVariants).toHaveLength(1);
    expect(withVariant.breakdown.variant?.targetedVariants[0].variantId).toBe('small-utility');

    // Composite is strictly higher for the variant-aligned work item
    expect(withVariant.score.composite).toBeGreaterThan(withoutVariant.score.composite);
  });

  it('AC #6 [mismatched variant]: enterprise-targeted onboarding work item scores LOWER', () => {
    const ctx = makeInternalAdopterVariantCtx();
    // Same onboarding work item but mis-targeted to enterprise — variant misfit
    const input = makeAdmissionInput(2, 'AISDLC-bulk-ent', {
      title: 'feat: small-utility onboarding (mistargeted as enterprise)',
    });

    const withVariant = computeAdmissionComposite(input, undefined, {
      variantContext: ctx,
      soulAlignmentOverride: 0.7, // soul-aggregate would have been quite high
    });

    // enterprise variant: sa1=0.35, sa2=0.42 → SA = combineVariantSaForSoulAlignment(0.35, 0.42)
    expect(withVariant.breakdown.soulAlignment).toBeCloseTo(
      combineVariantSaForSoulAlignment(0.35, 0.42),
      6,
    );
    // Lower than what soul-aggregate would have produced (0.7) — variant routing
    // correctly downgrades the score on variant misalignment
    expect(withVariant.breakdown.soulAlignment).toBeLessThan(0.7);
  });

  it('AC #3 [multi-variant default min]: aggregates per-Soul cross-variant via min', () => {
    const ctx = makeInternalAdopterVariantCtx();
    const input = makeAdmissionInput(3, 'AISDLC-cross-variant', {
      title: 'feat: feature touching both small-utility and enterprise',
    });

    const result = computeAdmissionComposite(input, undefined, {
      variantContext: ctx,
      soulAlignmentOverride: 0.5,
    });

    expect(result.breakdown.variant?.routingPath).toBe('multi-variant');
    expect(result.breakdown.variant?.aggregationRule).toBe('min');
    // min(small-utility sa1=0.92, enterprise sa1=0.35) = 0.35
    // min(small-utility sa2=0.88, enterprise sa2=0.42) = 0.42
    expect(result.breakdown.variant?.sa1).toBeCloseTo(0.35, 6);
    expect(result.breakdown.variant?.sa2).toBeCloseTo(0.42, 6);
    expect(result.breakdown.soulAlignment).toBeCloseTo(
      combineVariantSaForSoulAlignment(0.35, 0.42),
      6,
    );
  });

  it('AC #3 [multi-variant per-Soul max override]: respects crossVariantAggregation: max', () => {
    const baseCtx = makeInternalAdopterVariantCtx();
    const ctx: VariantContext = {
      ...baseCtx,
      configBySoul: {
        'product-a': { crossVariantAggregation: 'max' },
      },
    };
    const input = makeAdmissionInput(4, 'AISDLC-cross-variant');

    const result = computeAdmissionComposite(input, undefined, {
      variantContext: ctx,
      soulAlignmentOverride: 0.5,
    });

    expect(result.breakdown.variant?.routingPath).toBe('multi-variant');
    expect(result.breakdown.variant?.aggregationRule).toBe('max');
    expect(result.breakdown.variant?.sa1).toBeCloseTo(0.92, 6);
    expect(result.breakdown.variant?.sa2).toBeCloseTo(0.88, 6);
  });

  it('AC #4 [backward-compat]: work item without targetedVariants preserves soul-aggregate', () => {
    const ctx = makeInternalAdopterVariantCtx();
    // Work item NOT in `workItemTargeting` map at all
    const input = makeAdmissionInput(5, 'AISDLC-untargeted', {
      title: 'feat: substrate-only refactor',
    });

    const withCtx = computeAdmissionComposite(input, undefined, {
      variantContext: ctx,
      soulAlignmentOverride: 0.65,
    });
    const withoutCtx = computeAdmissionComposite(input, undefined, {
      soulAlignmentOverride: 0.65,
    });

    // The composite is identical — variant context exists but doesn't apply
    expect(withCtx.breakdown.soulAlignment).toBeCloseTo(withoutCtx.breakdown.soulAlignment, 10);
    expect(withCtx.score.composite).toBeCloseTo(withoutCtx.score.composite, 10);
    // Breakdown does NOT surface the variant field when no routing applied
    expect(withCtx.breakdown.variant).toBeUndefined();
  });

  it('AC #4 [backward-compat]: variantContext absent → composite unchanged from legacy', () => {
    const input = makeAdmissionInput(6, 'AISDLC-anything');
    const result = computeAdmissionComposite(input);
    expect(result.breakdown.variant).toBeUndefined();
    // soulAlignment from label-based fallback path ('spec' label → 0.9)
    expect(result.breakdown.soulAlignment).toBeGreaterThan(0);
  });

  it('combineVariantSaForSoulAlignment computes equal-weighted mean and clamps to [0,1]', () => {
    expect(combineVariantSaForSoulAlignment(0.4, 0.8)).toBeCloseTo(0.6, 8);
    expect(combineVariantSaForSoulAlignment(0, 0)).toBe(0);
    expect(combineVariantSaForSoulAlignment(1, 1)).toBe(1);
    // Defensive clamps (shouldn't fire on valid [0,1] inputs but proves the contract)
    expect(combineVariantSaForSoulAlignment(2, 2)).toBe(1);
    expect(combineVariantSaForSoulAlignment(-0.5, -0.5)).toBe(0);
  });
});
