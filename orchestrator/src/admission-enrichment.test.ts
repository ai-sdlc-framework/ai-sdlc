import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { DesignSystemBinding } from '@ai-sdlc/reference';
import { StateStore } from './state/store.js';
import type { AdmissionInput } from './admission-score.js';
import type { AutonomyPolicy } from '@ai-sdlc/reference';
import {
  enrichAdmissionInput,
  computeDesignSystemReadiness,
  computeDefectRiskFactor,
  computeAutonomyFactor,
  computeDesignAuthorityWeight,
  complexityToAutonomyLevel,
  computeDsbAgeDays,
  computeBaselineCoverage,
  detectLifecyclePhase,
  CODE_AREA_METRICS_MIN_DATA_POINTS,
  type EnrichmentContext,
} from './admission-enrichment.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDsb(name: string, status?: DesignSystemBinding['status']): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name },
    spec: {
      stewardship: {
        designAuthority: { principals: ['d'], scope: [] },
        engineeringAuthority: { principals: ['e'], scope: [] },
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
    status,
  };
}

function makeInput(): AdmissionInput {
  return {
    issueNumber: 1,
    title: 't',
    body: 'b',
    labels: [],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

// Frozen clock: 2026-04-24 (after an assumed DSB adoption of 2026-04-01 → 23 days)
const FROZEN_NOW_MS = Date.parse('2026-04-24T00:00:00Z');
const frozenNow = () => FROZEN_NOW_MS;

describe('computeDsbAgeDays', () => {
  it('returns days elapsed since adoption', () => {
    expect(computeDsbAgeDays('2026-04-01T00:00:00Z', frozenNow)).toBe(23);
  });

  it('returns 0 when adoptedAt is undefined (bootstrap-friendly default)', () => {
    expect(computeDsbAgeDays(undefined, frozenNow)).toBe(0);
  });

  it('returns 0 when adoptedAt is unparseable', () => {
    expect(computeDsbAgeDays('not-a-date', frozenNow)).toBe(0);
  });

  it('clamps negative intervals (future adoption) to 0', () => {
    expect(computeDsbAgeDays('2099-01-01T00:00:00Z', frozenNow)).toBe(0);
  });
});

describe('detectLifecyclePhase', () => {
  const dsb = makeDsb('ds');

  it('returns preDesignSystem when no DSB', () => {
    expect(detectLifecyclePhase(undefined, 0.9, 1000)).toBe('preDesignSystem');
  });

  it('returns catalogBootstrap when coverage < 20% AND age < 90d', () => {
    expect(detectLifecyclePhase(dsb, 0.1, 30)).toBe('catalogBootstrap');
  });

  it('returns postDesignSystem when coverage ≥ 20%', () => {
    expect(detectLifecyclePhase(dsb, 0.2, 30)).toBe('postDesignSystem');
  });

  it('returns postDesignSystem when age ≥ 90d', () => {
    expect(detectLifecyclePhase(dsb, 0.1, 90)).toBe('postDesignSystem');
  });
});

describe('computeBaselineCoverage', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('returns 0 when no visual baselines exist (AC #5)', () => {
    expect(computeBaselineCoverage(store, 'ds')).toBe(0);
  });

  it('returns approved/total fraction', () => {
    store.insertVisualRegressionResult({
      bindingName: 'ds',
      storyName: 'Button/Default',
      diffPercentage: 0,
      approved: true,
    });
    store.insertVisualRegressionResult({
      bindingName: 'ds',
      storyName: 'Button/Primary',
      diffPercentage: 0.5,
      approved: false,
    });
    store.insertVisualRegressionResult({
      bindingName: 'ds',
      storyName: 'Card/Elevated',
      diffPercentage: 0,
      approved: true,
    });
    // 2 of 3 approved → 0.667
    expect(computeBaselineCoverage(store, 'ds')).toBeCloseTo(2 / 3, 4);
  });

  it('scopes results to bindingName (ignores other bindings)', () => {
    store.insertVisualRegressionResult({
      bindingName: 'other',
      storyName: 'X',
      diffPercentage: 0,
      approved: true,
    });
    expect(computeBaselineCoverage(store, 'ds')).toBe(0);
  });
});

describe('computeDesignSystemReadiness', () => {
  it('preDesignSystem phase: returns 1.0 when no DSB (AC #1)', () => {
    expect(computeDesignSystemReadiness({})).toBe(1.0);
  });

  it('catalogBootstrap phase: floors at 0.3 when computed would be < 0.3 (AC #2)', () => {
    // cat=10%, tok=10%, baseline=0 → computed = 0.07, age 10d, coverage < 20% → floor 0.3
    const dsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 10 },
      tokenCompliance: { currentCoverage: 10 },
    });
    const ctx: EnrichmentContext = {
      designSystemBinding: dsb,
      dsbAdoptedAt: '2026-04-14T00:00:00Z', // 10d old
      now: frozenNow,
    };
    expect(computeDesignSystemReadiness(ctx)).toBeCloseTo(0.3, 6);
  });

  it('catalogBootstrap phase: uses computed value when it exceeds the floor', () => {
    // cat=15%, tok=80%, baseline=0 → computed = 0.06 + 0.24 + 0 = 0.30 (equal to floor)
    // Shift to cat=15%, tok=90%, baseline=0 → computed = 0.06 + 0.27 = 0.33
    const dsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 15 },
      tokenCompliance: { currentCoverage: 90 },
    });
    const ctx: EnrichmentContext = {
      designSystemBinding: dsb,
      dsbAdoptedAt: '2026-04-14T00:00:00Z',
      now: frozenNow,
    };
    expect(computeDesignSystemReadiness(ctx)).toBeCloseTo(0.33, 6);
  });

  it('postDesignSystem phase: matches 0.4×cat + 0.3×tok + 0.3×baseline exactly (AC #3)', () => {
    // cat=80%, tok=90%, baseline supplied via store → 0.5
    const db = new Database(':memory:');
    const store = StateStore.open(db);
    for (let i = 0; i < 10; i++) {
      store.insertVisualRegressionResult({
        bindingName: 'ds',
        storyName: `s${i}`,
        diffPercentage: 0,
        approved: i < 5, // 5 of 10 approved → 0.5
      });
    }
    const dsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 80 },
      tokenCompliance: { currentCoverage: 90 },
    });
    const ctx: EnrichmentContext = {
      designSystemBinding: dsb,
      stateStore: store,
      dsbAdoptedAt: '2026-01-01T00:00:00Z', // > 90d old
      now: frozenNow,
    };
    const expected = 0.4 * 0.8 + 0.3 * 0.9 + 0.3 * 0.5;
    expect(computeDesignSystemReadiness(ctx)).toBeCloseTo(expected, 10);
    store.close();
  });

  it('golden values for all three phases (AC #4)', () => {
    // 1) preDesignSystem → 1.0
    expect(computeDesignSystemReadiness({})).toBe(1.0);

    // 2) catalogBootstrap (cat=5%, tok=0%, baseline=0, age=30d) → floor 0.3
    const bootstrapDsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 5 },
      tokenCompliance: { currentCoverage: 0 },
    });
    expect(
      computeDesignSystemReadiness({
        designSystemBinding: bootstrapDsb,
        dsbAdoptedAt: '2026-03-25T00:00:00Z', // 30d old vs 2026-04-24
        now: frozenNow,
      }),
    ).toBeCloseTo(0.3, 6);

    // 3) postDesignSystem (cat=100%, tok=100%, baseline=0, >90d) → 0.4 + 0.3 + 0 = 0.7
    const postDsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 100 },
      tokenCompliance: { currentCoverage: 100 },
    });
    expect(
      computeDesignSystemReadiness({
        designSystemBinding: postDsb,
        dsbAdoptedAt: '2026-01-01T00:00:00Z',
        now: frozenNow,
      }),
    ).toBeCloseTo(0.7, 10);
  });
});

describe('enrichAdmissionInput', () => {
  it('returns input unchanged when no DSB resolved (preDesignSystem)', () => {
    const input = makeInput();
    const out = enrichAdmissionInput(input, {});
    expect(out).toEqual(input);
    expect(out.designSystemContext).toBeUndefined();
  });

  it('populates designSystemContext when DSB present', () => {
    const dsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 60 },
      tokenCompliance: { currentCoverage: 75 },
    });
    const out = enrichAdmissionInput(makeInput(), {
      designSystemBinding: dsb,
      dsbAdoptedAt: '2026-01-01T00:00:00Z',
      now: frozenNow,
      catalogGaps: ['Avatar', 'Toast'],
    });
    expect(out.designSystemContext).toBeDefined();
    expect(out.designSystemContext!.catalogCoverage).toBeCloseTo(0.6, 6);
    expect(out.designSystemContext!.tokenCompliance).toBeCloseTo(0.75, 6);
    expect(out.designSystemContext!.inBootstrapPhase).toBe(false);
    expect(out.designSystemContext!.catalogGaps).toEqual(['Avatar', 'Toast']);
    // No state store → baseline = 0
    expect(out.designSystemContext!.baselineCoverage).toBe(0);
  });

  it('flags inBootstrapPhase when coverage < 20% and age < 90d', () => {
    const dsb = makeDsb('ds', {
      catalogHealth: { coveragePercent: 10 },
      tokenCompliance: { currentCoverage: 20 },
    });
    const out = enrichAdmissionInput(makeInput(), {
      designSystemBinding: dsb,
      dsbAdoptedAt: '2026-04-14T00:00:00Z',
      now: frozenNow,
    });
    expect(out.designSystemContext!.inBootstrapPhase).toBe(true);
  });

  it('defaults catalogGaps to empty array when not provided', () => {
    const dsb = makeDsb('ds', { catalogHealth: { coveragePercent: 80 } });
    const out = enrichAdmissionInput(makeInput(), {
      designSystemBinding: dsb,
      dsbAdoptedAt: '2026-01-01T00:00:00Z',
      now: frozenNow,
    });
    expect(out.designSystemContext!.catalogGaps).toEqual([]);
  });

  it('preserves all non-RFC-0008 AdmissionInput fields', () => {
    const input: AdmissionInput = {
      ...makeInput(),
      title: 'important',
      labels: ['enhancement'],
      reactionCount: 5,
      commentCount: 2,
      authorAssociation: 'OWNER',
    };
    const dsb = makeDsb('ds', { catalogHealth: { coveragePercent: 50 } });
    const out = enrichAdmissionInput(input, {
      designSystemBinding: dsb,
      dsbAdoptedAt: '2026-01-01T00:00:00Z',
      now: frozenNow,
    });
    expect(out.title).toBe('important');
    expect(out.labels).toEqual(['enhancement']);
    expect(out.reactionCount).toBe(5);
    expect(out.commentCount).toBe(2);
    expect(out.authorAssociation).toBe('OWNER');
  });
});

// ── C3: code-area quality + defect risk factor ────────────────────────

describe('computeDefectRiskFactor', () => {
  it('returns 0 when codeAreaQuality is absent (AC #4 insufficient-data path)', () => {
    expect(computeDefectRiskFactor(undefined)).toBe(0);
  });

  it('pure code path (hasFrontendComponents=false) ignores designQuality (AC #1)', () => {
    // Even if designQuality is supplied, it should be ignored when !hasFrontendComponents.
    const quality = {
      defectDensity: 0.1,
      churnRate: 0.2,
      prRejectionRate: 0.05,
      hasFrontendComponents: false,
      designQuality: {
        designCIPassRate: 0.0, // extreme design signal — must be ignored
        designReviewRejectionRate: 1.0,
        usabilitySimPassRate: 0.0,
      },
    };
    // pure code: 0.5*0.1 + 0.3*0.2 + 0.2*0.05 = 0.05 + 0.06 + 0.01 = 0.12
    expect(computeDefectRiskFactor(quality)).toBeCloseTo(0.12, 6);
  });

  it('frontend without designQuality uses pure-code formula (AC #2 negative case)', () => {
    const quality = {
      defectDensity: 0.1,
      churnRate: 0.2,
      prRejectionRate: 0.05,
      hasFrontendComponents: true,
      // designQuality absent
    };
    expect(computeDefectRiskFactor(quality)).toBeCloseTo(0.12, 6);
  });

  it('frontend WITH designQuality applies blend (AC #2 positive case)', () => {
    const quality = {
      defectDensity: 0.1,
      churnRate: 0.2,
      prRejectionRate: 0.05,
      hasFrontendComponents: true,
      designQuality: {
        designCIPassRate: 0.8, // → (1-0.8) = 0.2 contribution
        designReviewRejectionRate: 0.1,
        usabilitySimPassRate: 0.9, // → (1-0.9) = 0.1 contribution
      },
    };
    // code = 0.12 (as above)
    // design = 0.4*0.2 + 0.4*0.1 + 0.2*0.1 = 0.08 + 0.04 + 0.02 = 0.14
    // blended = 0.7*0.12 + 0.3*0.14 = 0.084 + 0.042 = 0.126
    expect(computeDefectRiskFactor(quality)).toBeCloseTo(0.126, 6);
  });

  it('clamps the ceiling at 0.5 (AC #3)', () => {
    const quality = {
      defectDensity: 10, // extreme
      churnRate: 10,
      prRejectionRate: 10,
      hasFrontendComponents: false,
    };
    expect(computeDefectRiskFactor(quality)).toBe(0.5);
  });

  it('clamps the floor at 0 (no negative risk)', () => {
    const quality = {
      defectDensity: -1,
      churnRate: -1,
      prRejectionRate: -1,
      hasFrontendComponents: false,
    };
    expect(computeDefectRiskFactor(quality)).toBe(0);
  });

  it('table-driven coverage of all 4 hasFrontend × hasDesignQuality permutations (AC #5)', () => {
    const baseCode = {
      defectDensity: 0.2,
      churnRate: 0.1,
      prRejectionRate: 0.05,
    };
    const code = 0.5 * 0.2 + 0.3 * 0.1 + 0.2 * 0.05; // 0.14
    const dq = {
      designCIPassRate: 0.9,
      designReviewRejectionRate: 0.05,
      usabilitySimPassRate: 0.95,
    };
    const design = 0.4 * 0.1 + 0.4 * 0.05 + 0.2 * 0.05; // 0.07

    // (F, F): pure-code
    expect(computeDefectRiskFactor({ ...baseCode, hasFrontendComponents: false })).toBeCloseTo(
      code,
      6,
    );

    // (F, T): pure-code (design ignored when !hasFrontend)
    expect(
      computeDefectRiskFactor({
        ...baseCode,
        hasFrontendComponents: false,
        designQuality: dq,
      }),
    ).toBeCloseTo(code, 6);

    // (T, F): pure-code (no design signal to blend)
    expect(computeDefectRiskFactor({ ...baseCode, hasFrontendComponents: true })).toBeCloseTo(
      code,
      6,
    );

    // (T, T): blended
    expect(
      computeDefectRiskFactor({
        ...baseCode,
        hasFrontendComponents: true,
        designQuality: dq,
      }),
    ).toBeCloseTo(0.7 * code + 0.3 * design, 6);
  });
});

describe('enrichAdmissionInput — codeAreaQuality population', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('populates codeAreaQuality when metrics ≥ min data points', () => {
    store.insertCodeAreaMetrics({
      codeArea: 'components/Button.tsx',
      defectDensity: 0.05,
      churnRate: 0.2,
      prRejectionRate: 0.1,
      hasFrontendComponents: true,
      designMetricsJson: JSON.stringify({
        designCIPassRate: 0.9,
        designReviewRejectionRate: 0.05,
      }),
      dataPointCount: 15,
    });

    const out = enrichAdmissionInput(makeInput(), {
      stateStore: store,
      codeArea: 'components/Button.tsx',
      now: frozenNow,
    });

    expect(out.codeAreaQuality).toBeDefined();
    expect(out.codeAreaQuality!.hasFrontendComponents).toBe(true);
    expect(out.codeAreaQuality!.defectDensity).toBeCloseTo(0.05, 6);
    expect(out.codeAreaQuality!.designQuality?.designCIPassRate).toBeCloseTo(0.9, 6);
    expect(out.codeAreaQuality!.designQuality?.usabilitySimPassRate).toBeUndefined();
  });

  it('omits codeAreaQuality when dataPointCount < minimum (AC #4 gate)', () => {
    store.insertCodeAreaMetrics({
      codeArea: 'components/Button.tsx',
      defectDensity: 0.5,
      hasFrontendComponents: true,
      dataPointCount: CODE_AREA_METRICS_MIN_DATA_POINTS - 1,
    });

    const out = enrichAdmissionInput(makeInput(), {
      stateStore: store,
      codeArea: 'components/Button.tsx',
      now: frozenNow,
    });
    expect(out.codeAreaQuality).toBeUndefined();
    // Downstream compute yields 0 — AC #4 satisfied.
    expect(computeDefectRiskFactor(out.codeAreaQuality)).toBe(0);
  });

  it('falls back to heuristic classification when no state store provided', () => {
    const out = enrichAdmissionInput(makeInput(), {
      codeArea: 'ui/Button.tsx',
      now: frozenNow,
    });
    expect(out.codeAreaQuality).toBeDefined();
    expect(out.codeAreaQuality!.hasFrontendComponents).toBe(true);
    // No defect/churn — compute returns 0
    expect(computeDefectRiskFactor(out.codeAreaQuality)).toBe(0);
  });

  it('omits codeAreaQuality when codeArea not provided and no state store', () => {
    const out = enrichAdmissionInput(makeInput(), {});
    expect(out.codeAreaQuality).toBeUndefined();
  });

  it('does not attach codeAreaQuality when codeArea has no matching metrics row', () => {
    const out = enrichAdmissionInput(makeInput(), {
      stateStore: store,
      codeArea: 'unmapped/area.ts',
      now: frozenNow,
    });
    expect(out.codeAreaQuality).toBeUndefined();
  });
});

// ── C4: autonomy factor ────────────────────────────────────────────────

function makePolicy(agents: { name: string; currentLevel: number }[]): AutonomyPolicy {
  return {
    apiVersion: API_VERSION,
    kind: 'AutonomyPolicy',
    metadata: { name: 'team-autonomy' },
    spec: { levels: [], promotionCriteria: {}, demotionTriggers: [] },
    status: {
      agents: agents.map((a) => ({ name: a.name, currentLevel: a.currentLevel })),
    },
  };
}

describe('complexityToAutonomyLevel', () => {
  it.each([
    [0, 1],
    [1, 1],
    [3, 1],
    [3.5, 2],
    [4, 2],
    [6, 2],
    [6.5, 3],
    [7, 3],
    [10, 3],
  ])('complexity=%s → level %s', (complexity, expected) => {
    expect(complexityToAutonomyLevel(complexity)).toBe(expected);
  });
});

describe('computeAutonomyFactor', () => {
  it('returns 1.0 when context absent (AC #2)', () => {
    expect(computeAutonomyFactor(undefined)).toBe(1.0);
  });

  it.each([
    [0, 1.0],
    [1, 0.6],
    [2, 0.2],
    [3, 0.1], // floor
    [4, 0.1], // still floor
  ])('gap=%s → %s (AC #1)', (gap, expected) => {
    const ctx = { currentEarnedLevel: 1, requiredLevel: 1 + gap };
    expect(computeAutonomyFactor(ctx)).toBeCloseTo(expected, 6);
  });

  it('over-earned agent (gap < 0) still returns 1.0 (no bonus)', () => {
    const ctx = { currentEarnedLevel: 3, requiredLevel: 1 };
    expect(computeAutonomyFactor(ctx)).toBe(1.0);
  });
});

describe('enrichAdmissionInput — autonomyContext population', () => {
  it('omits autonomyContext when no AutonomyPolicy in context (AC #2)', () => {
    const out = enrichAdmissionInput(makeInput(), {});
    expect(out.autonomyContext).toBeUndefined();
    expect(computeAutonomyFactor(out.autonomyContext)).toBe(1.0);
  });

  it('picks the named agent when agentName is supplied', () => {
    const policy = makePolicy([
      { name: 'devloop-alpha', currentLevel: 1 },
      { name: 'devloop-beta', currentLevel: 3 },
    ]);
    const out = enrichAdmissionInput(makeInput(), {
      autonomyPolicy: policy,
      agentName: 'devloop-alpha',
      complexity: 7, // requires level 3
    });
    expect(out.autonomyContext).toEqual({ currentEarnedLevel: 1, requiredLevel: 3 });
    expect(computeAutonomyFactor(out.autonomyContext)).toBeCloseTo(0.2, 6);
  });

  it('falls back to most permissive agent when agentName not supplied', () => {
    const policy = makePolicy([
      { name: 'a', currentLevel: 1 },
      { name: 'b', currentLevel: 3 },
    ]);
    const out = enrichAdmissionInput(makeInput(), {
      autonomyPolicy: policy,
      complexity: 7, // requires level 3
    });
    expect(out.autonomyContext).toEqual({ currentEarnedLevel: 3, requiredLevel: 3 });
    expect(computeAutonomyFactor(out.autonomyContext)).toBe(1.0);
  });

  it('when complexity unspecified, requiredLevel = currentEarnedLevel (gap 0)', () => {
    const policy = makePolicy([{ name: 'a', currentLevel: 2 }]);
    const out = enrichAdmissionInput(makeInput(), { autonomyPolicy: policy });
    expect(out.autonomyContext).toEqual({ currentEarnedLevel: 2, requiredLevel: 2 });
    expect(computeAutonomyFactor(out.autonomyContext)).toBe(1.0);
  });

  it('omits autonomyContext when policy has no agents', () => {
    const emptyPolicy = makePolicy([]);
    const out = enrichAdmissionInput(makeInput(), { autonomyPolicy: emptyPolicy });
    expect(out.autonomyContext).toBeUndefined();
  });

  it('omits autonomyContext when named agent is not in the policy', () => {
    const policy = makePolicy([{ name: 'known-agent', currentLevel: 2 }]);
    const out = enrichAdmissionInput(makeInput(), {
      autonomyPolicy: policy,
      agentName: 'missing-agent',
    });
    expect(out.autonomyContext).toBeUndefined();
  });
});

describe('computeAutonomyFactor — each band (AC #3)', () => {
  // Explicit band coverage matching the acceptance criterion verbatim.
  it('gap=0 → 1.0', () =>
    expect(computeAutonomyFactor({ currentEarnedLevel: 2, requiredLevel: 2 })).toBe(1.0));
  it('gap=1 → 0.6', () =>
    expect(computeAutonomyFactor({ currentEarnedLevel: 1, requiredLevel: 2 })).toBeCloseTo(0.6, 6));
  it('gap=2 → 0.2', () =>
    expect(computeAutonomyFactor({ currentEarnedLevel: 1, requiredLevel: 3 })).toBeCloseTo(0.2, 6));
  it('gap=3 → 0.1 (floor)', () =>
    expect(computeAutonomyFactor({ currentEarnedLevel: 0, requiredLevel: 3 })).toBeCloseTo(0.1, 6));
});

// ── C5: design authority signal ────────────────────────────────────────

describe('computeDesignAuthorityWeight', () => {
  it('returns 0 when signal absent (AC #1 non-authority)', () => {
    expect(computeDesignAuthorityWeight(undefined)).toBe(0);
  });

  it('returns 0 when signal is explicitly non-authority (AC #1)', () => {
    expect(computeDesignAuthorityWeight({ isDesignAuthority: false })).toBe(0);
  });

  it('authority + advances-design-coherence + areaComplianceScore=0.9 → 0.18 (AC #2)', () => {
    const weight = computeDesignAuthorityWeight({
      isDesignAuthority: true,
      signalType: 'advances-design-coherence',
      areaComplianceScore: 0.9,
    });
    expect(weight).toBeCloseTo(0.6 * (1.2 - 0.9), 6);
    expect(weight).toBeCloseTo(0.18, 6);
  });

  it('authority + no typed signal → 0.3 when areaComplianceScore absent (AC #3)', () => {
    const weight = computeDesignAuthorityWeight({
      isDesignAuthority: true,
      signalType: 'unspecified',
    });
    expect(weight).toBeCloseTo(0.3, 6);
  });

  it.each([
    ['advances-design-coherence', 0.6],
    ['fills-catalog-gap', 0.6],
    ['fragments-component-catalog', -0.4],
    ['misaligned-with-brand', -0.4],
    ['unspecified', 0.3],
  ] as const)('base weight for %s = %s (AC #4)', (signalType, expected) => {
    const weight = computeDesignAuthorityWeight({
      isDesignAuthority: true,
      signalType,
    });
    expect(weight).toBeCloseTo(expected, 6);
  });

  it('compliance modulation applies to all signal types (AC #4)', () => {
    const compliance = 0.5;
    const modulation = 1.2 - compliance;

    for (const [signalType, base] of [
      ['advances-design-coherence', 0.6],
      ['fills-catalog-gap', 0.6],
      ['fragments-component-catalog', -0.4],
      ['misaligned-with-brand', -0.4],
      ['unspecified', 0.3],
    ] as const) {
      const weight = computeDesignAuthorityWeight({
        isDesignAuthority: true,
        signalType,
        areaComplianceScore: compliance,
      });
      expect(weight).toBeCloseTo(base * modulation, 6);
    }
  });
});

describe('enrichAdmissionInput — designAuthoritySignal population', () => {
  const baseDsb = (principals: string[]): DesignSystemBinding => ({
    apiVersion: API_VERSION,
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

  it('omits designAuthoritySignal when no DSB present', () => {
    const out = enrichAdmissionInput(makeInput(), {});
    expect(out.designAuthoritySignal).toBeUndefined();
  });

  it('populates isDesignAuthority=false for non-authority authors', () => {
    const dsb = baseDsb(['alice']);
    const out = enrichAdmissionInput(
      { ...makeInput(), authorLogin: 'mallory' },
      { designSystemBinding: dsb, dsbAdoptedAt: '2026-01-01', now: frozenNow },
    );
    expect(out.designAuthoritySignal).toEqual({ isDesignAuthority: false });
    expect(computeDesignAuthorityWeight(out.designAuthoritySignal)).toBe(0);
  });

  it('populates authority=true + signalType when author is a principal with a typed label', () => {
    const dsb = baseDsb(['alice']);
    const out = enrichAdmissionInput(
      {
        ...makeInput(),
        authorLogin: 'alice',
        labels: ['design/advances-coherence'],
      },
      {
        designSystemBinding: dsb,
        dsbAdoptedAt: '2026-01-01',
        now: frozenNow,
        areaComplianceScore: 0.9,
      },
    );
    expect(out.designAuthoritySignal).toEqual({
      isDesignAuthority: true,
      signalType: 'advances-design-coherence',
      areaComplianceScore: 0.9,
    });
    expect(computeDesignAuthorityWeight(out.designAuthoritySignal)).toBeCloseTo(0.18, 6);
  });

  it('recognizes principal matches via commenterLogins', () => {
    const dsb = baseDsb(['bob']);
    const out = enrichAdmissionInput(
      {
        ...makeInput(),
        authorLogin: 'mallory',
        commenterLogins: ['bob'],
        labels: ['design/misaligned-brand'],
      },
      { designSystemBinding: dsb, dsbAdoptedAt: '2026-01-01', now: frozenNow },
    );
    expect(out.designAuthoritySignal?.isDesignAuthority).toBe(true);
    expect(out.designAuthoritySignal?.signalType).toBe('misaligned-with-brand');
    // Base weight -0.4, no modulation since areaComplianceScore absent
    expect(computeDesignAuthorityWeight(out.designAuthoritySignal)).toBeCloseTo(-0.4, 6);
  });
});
