import { describe, it, expect } from 'vitest';
import type { DesignIntentDocument, DesignSystemBinding } from '../core/types.js';
import {
  createDesignIntentReconciler,
  extractKeywords,
  findPrinciplesWithoutDsbCoverage,
  computeNextReviewDueMs,
  flattenIdentityFields,
  type DesignIntentEvent,
  type DesignIntentReconcilerDeps,
  type DesignIntentSnapshot,
} from './design-intent-reconciler.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function baseDid(overrides: Partial<DesignIntentDocument['spec']> = {}): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
        reviewCadence: 'quarterly',
        ...(overrides.stewardship ?? {}),
      },
      soulPurpose: {
        mission: { value: 'Acme helps small businesses succeed.', identityClass: 'core' },
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Forms must be simple and easy to use.',
            identityClass: 'core',
            measurableSignals: [
              { id: 'completion', metric: 'task-completion', threshold: 0.85, operator: 'gte' },
            ],
          },
        ],
        ...(overrides.soulPurpose ?? {}),
      },
      designSystemRef: { name: 'acme-ds' },
      ...overrides,
    },
  };
}

function baseDsb(overrides: Partial<DesignSystemBinding['spec']> = {}): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'acme-ds' },
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
      compliance: {
        coverage: { minimum: 85 },
        disallowHardcoded: [
          {
            category: 'Simple form interactions',
            pattern: '\\bform\\b',
            message: 'Forms must use catalog primitives',
          },
        ],
      },
      ...overrides,
    },
  };
}

/** Minimal dependency bundle — snapshot in-memory, events captured. */
function makeDeps(
  opts: {
    previous?: DesignIntentSnapshot;
    dsb?: DesignSystemBinding;
    inFlight?: number;
    now?: () => number;
  } = {},
): {
  deps: DesignIntentReconcilerDeps;
  events: DesignIntentEvent[];
  saved: Map<string, DesignIntentSnapshot>;
} {
  const events: DesignIntentEvent[] = [];
  const saved = new Map<string, DesignIntentSnapshot>();
  const deps: DesignIntentReconcilerDeps = {
    getDesignSystemBinding: () => opts.dsb,
    getLastSnapshot: async () => opts.previous,
    saveSnapshot: async (name, snap) => {
      saved.set(name, snap);
    },
    countInFlightItems: opts.inFlight !== undefined ? async () => opts.inFlight! : undefined,
    onEvent: (e) => events.push(e),
    now: opts.now,
  };
  return { deps, events, saved };
}

describe('extractKeywords', () => {
  it('returns lowercased stems ≥ 4 chars with stopwords removed', () => {
    const result = extractKeywords('The form must be simple and easy to use.');
    expect(result).toContain('form');
    expect(result).toContain('simple');
    expect(result).not.toContain('must');
    expect(result).not.toContain('the');
    expect(result).not.toContain('be');
  });
});

describe('computeNextReviewDueMs', () => {
  it('adds cadence days to lastReviewed', () => {
    const last = '2026-01-01T00:00:00Z';
    const quarterly = computeNextReviewDueMs(last, 'quarterly');
    expect(new Date(quarterly!).toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns undefined when inputs missing', () => {
    expect(computeNextReviewDueMs(undefined, 'quarterly')).toBeUndefined();
    expect(computeNextReviewDueMs('2026-01-01', undefined)).toBeUndefined();
  });
});

describe('flattenIdentityFields', () => {
  it('includes mission, principles, and inherits evolving default', () => {
    const did = baseDid({
      soulPurpose: {
        mission: { value: 'Mission' }, // no identityClass → evolving
        designPrinciples: [
          {
            id: 'p1',
            name: 'P1',
            description: 'd1',
            identityClass: 'core',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
          },
        ],
      },
    });
    const fields = flattenIdentityFields(did);
    const mission = fields.find((f) => f.path.endsWith('.mission.value'))!;
    const principle = fields.find((f) => f.path.includes('designPrinciples[p1]'))!;
    expect(mission.identityClass).toBe('evolving');
    expect(principle.identityClass).toBe('core');
  });
});

describe('findPrinciplesWithoutDsbCoverage', () => {
  it('returns empty when at least one DSB rule mentions a principle keyword', () => {
    const did = baseDid(); // principle description: "Forms must be simple..."
    const dsb = baseDsb(); // rule message contains "form"
    expect(findPrinciplesWithoutDsbCoverage(did, dsb)).toEqual([]);
  });

  it('returns principle id when no DSB rule matches its keywords', () => {
    const did = baseDid();
    const dsb = baseDsb({
      compliance: {
        coverage: { minimum: 85 },
        disallowHardcoded: [{ category: 'Unrelated', pattern: '\\bfoo\\b', message: 'bar baz' }],
      },
    });
    expect(findPrinciplesWithoutDsbCoverage(did, dsb)).toContain('approachable');
  });

  it('returns all principle ids when DSB is absent', () => {
    const did = baseDid();
    expect(findPrinciplesWithoutDsbCoverage(did, undefined)).toEqual(['approachable']);
  });
});

describe('createDesignIntentReconciler', () => {
  it('AC #4: returns a ReconcilerFn returning ReconcileResult', async () => {
    const { deps } = makeDeps({ dsb: baseDsb() });
    const reconcile = createDesignIntentReconciler(deps);
    const result = await reconcile(baseDid());
    expect(result.type).toBe('success');
  });

  it('saves a new snapshot when no previous exists and emits no change events', async () => {
    const { deps, events, saved } = makeDeps({ dsb: baseDsb() });
    const reconcile = createDesignIntentReconciler(deps);
    await reconcile(baseDid());
    expect(saved.has('acme-did')).toBe(true);
    const changeEvents = events.filter(
      (e) => e.type === 'CoreIdentityChanged' || e.type === 'EvolvingIdentityChanged',
    );
    expect(changeEvents).toEqual([]);
  });

  it('AC #1: core-field change emits CoreIdentityChanged with changedField path', async () => {
    const initial = baseDid();
    const mutated = baseDid();
    mutated.spec.soulPurpose.mission.value = 'Completely new mission statement.';

    // First run captures the baseline snapshot.
    const firstSnapshotCapture = new Map<string, DesignIntentSnapshot>();
    const captureDeps = makeDeps({ dsb: baseDsb() });
    captureDeps.deps.saveSnapshot = async (n, s) => {
      firstSnapshotCapture.set(n, s);
    };
    await createDesignIntentReconciler(captureDeps.deps)(initial);
    const snap = firstSnapshotCapture.get('acme-did');
    expect(snap).toBeDefined();

    const { deps: secondDeps, events } = makeDeps({ previous: snap, dsb: baseDsb() });
    const reconcile2 = createDesignIntentReconciler(secondDeps);
    await reconcile2(mutated);

    const coreEvents = events.filter((e) => e.type === 'CoreIdentityChanged');
    expect(coreEvents).toHaveLength(1);
    expect(coreEvents[0].details.changedFields as string[]).toContain(
      'spec.soulPurpose.mission.value',
    );
  });

  it('AC #2: evolving-field change emits EvolvingIdentityChanged only (no SoulGraphStale)', async () => {
    const initialEvolvingDid = baseDid();
    // Make mission evolving in baseline
    initialEvolvingDid.spec.soulPurpose.mission = {
      value: 'v1',
      identityClass: 'evolving',
    };
    initialEvolvingDid.spec.soulPurpose.designPrinciples[0].identityClass = 'evolving';

    const captureDeps = makeDeps({ dsb: baseDsb(), inFlight: 5 });
    let snap: DesignIntentSnapshot | undefined;
    captureDeps.deps.saveSnapshot = async (_n, s) => {
      snap = s;
    };
    await createDesignIntentReconciler(captureDeps.deps)(initialEvolvingDid);

    // Mutate mission value only
    const mutated: DesignIntentDocument = JSON.parse(JSON.stringify(initialEvolvingDid));
    mutated.spec.soulPurpose.mission.value = 'v2';

    const { deps, events } = makeDeps({ previous: snap, dsb: baseDsb(), inFlight: 5 });
    await createDesignIntentReconciler(deps)(mutated);

    const evolving = events.filter((e) => e.type === 'EvolvingIdentityChanged');
    const core = events.filter((e) => e.type === 'CoreIdentityChanged');
    const stale = events.filter((e) => e.type === 'SoulGraphStale');
    expect(evolving).toHaveLength(1);
    expect(core).toEqual([]);
    expect(stale).toEqual([]); // no SoulGraphStale on evolving change
  });

  it('AC #3: DID principle with no matching DSB rule emits DesignIntentDrift', async () => {
    const did = baseDid();
    const dsb = baseDsb({
      compliance: {
        coverage: { minimum: 85 },
        disallowHardcoded: [{ category: 'Unrelated', pattern: '\\bfoo\\b', message: 'bar baz' }],
      },
    });
    const { deps, events } = makeDeps({ dsb });
    await createDesignIntentReconciler(deps)(did);

    const drift = events.filter((e) => e.type === 'DesignIntentDrift');
    expect(drift).toHaveLength(1);
    expect(drift[0].details.uncoveredPrinciples as string[]).toContain('approachable');
  });

  it('emits ReviewOverdue when lastReviewed + cadence is in the past', async () => {
    const did = baseDid();
    did.status = { lastReviewed: '2025-01-01T00:00:00Z' };
    // quarterly cadence; now = 2026-04-24 → nextDue = 2025-04-01 → overdue.
    const frozen = () => Date.parse('2026-04-24T00:00:00Z');
    const { deps, events } = makeDeps({ dsb: baseDsb(), now: frozen });
    await createDesignIntentReconciler(deps)(did);

    const overdue = events.filter((e) => e.type === 'ReviewOverdue');
    expect(overdue).toHaveLength(1);
    expect(overdue[0].details.cadence).toBe('quarterly');
  });

  it('does NOT emit ReviewOverdue when still within cadence', async () => {
    const did = baseDid();
    did.status = { lastReviewed: '2026-04-01T00:00:00Z' };
    const frozen = () => Date.parse('2026-04-24T00:00:00Z');
    const { deps, events } = makeDeps({ dsb: baseDsb(), now: frozen });
    await createDesignIntentReconciler(deps)(did);

    const overdue = events.filter((e) => e.type === 'ReviewOverdue');
    expect(overdue).toEqual([]);
  });

  it('emits SoulGraphStale when core changes AND items are in-flight', async () => {
    // Baseline snapshot
    const initial = baseDid();
    const captureDeps = makeDeps({ dsb: baseDsb() });
    let snap: DesignIntentSnapshot | undefined;
    captureDeps.deps.saveSnapshot = async (_n, s) => {
      snap = s;
    };
    await createDesignIntentReconciler(captureDeps.deps)(initial);

    // Mutate core mission + in-flight items present
    const mutated = baseDid();
    mutated.spec.soulPurpose.mission.value = 'radically different mission';
    const { deps, events } = makeDeps({ previous: snap, dsb: baseDsb(), inFlight: 3 });
    await createDesignIntentReconciler(deps)(mutated);

    const stale = events.filter((e) => e.type === 'SoulGraphStale');
    expect(stale).toHaveLength(1);
    expect(stale[0].details.inFlightCount).toBe(3);
  });

  it('does NOT emit SoulGraphStale when in-flight count is zero', async () => {
    const initial = baseDid();
    const captureDeps = makeDeps({ dsb: baseDsb() });
    let snap: DesignIntentSnapshot | undefined;
    captureDeps.deps.saveSnapshot = async (_n, s) => {
      snap = s;
    };
    await createDesignIntentReconciler(captureDeps.deps)(initial);

    const mutated = baseDid();
    mutated.spec.soulPurpose.mission.value = 'v2';
    const { deps, events } = makeDeps({ previous: snap, dsb: baseDsb(), inFlight: 0 });
    await createDesignIntentReconciler(deps)(mutated);

    expect(events.filter((e) => e.type === 'SoulGraphStale')).toEqual([]);
    expect(events.filter((e) => e.type === 'CoreIdentityChanged')).toHaveLength(1);
  });

  it('reports errors via ReconcileResult instead of throwing', async () => {
    const { deps } = makeDeps({ dsb: baseDsb() });
    deps.saveSnapshot = async () => {
      throw new Error('disk full');
    };
    const result = await createDesignIntentReconciler(deps)(baseDid());
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.error.message).toBe('disk full');
    }
  });
});

// ── DesignChangePlanned ────────────────────────────────────────────────

describe('DesignChangePlanned event (AISDLC-52)', () => {
  type AnyPlannedChange = DesignIntentDocument['spec']['plannedChanges'] extends
    | (infer T)[]
    | undefined
    ? T
    : never;

  const plannedChange: AnyPlannedChange = {
    id: 'chg-001',
    changeType: 'token-restructure',
    status: 'planned',
    description: 'Restructure color tokens into semantic layer',
    estimatedTimeline: '2026-06-01',
    affectedTokenPaths: ['color.primary', 'color.secondary'],
    estimatedComponentImpact: 12,
    addedBy: 'design-lead',
  };

  async function runWithPlanned(
    initialPlanned: AnyPlannedChange[] | undefined,
    currentPlanned: AnyPlannedChange[] | undefined,
  ): Promise<{ events: DesignIntentEvent[]; snap: DesignIntentSnapshot | undefined }> {
    const initial = baseDid();
    if (initialPlanned) {
      initial.spec.plannedChanges = initialPlanned;
    }
    const captureDeps = makeDeps({ dsb: baseDsb() });
    const capturedSnap = new Map<string, DesignIntentSnapshot>();
    captureDeps.deps.saveSnapshot = async (n, s) => {
      capturedSnap.set(n, s);
    };
    await createDesignIntentReconciler(captureDeps.deps)(initial);
    const snap = capturedSnap.get('acme-did');

    const current = baseDid();
    if (currentPlanned) {
      current.spec.plannedChanges = currentPlanned;
    }
    const { deps, events } = makeDeps({ previous: snap, dsb: baseDsb() });
    await createDesignIntentReconciler(deps)(current);
    return { events, snap };
  }

  it('AC #1 + #3: adding a new planned change emits exactly one event with all 6 required fields', async () => {
    const { events } = await runWithPlanned(undefined, [plannedChange]);
    const planned = events.filter((e) => e.type === 'DesignChangePlanned');
    expect(planned).toHaveLength(1);
    const d = planned[0].details as Record<string, unknown>;
    expect(d.changeId).toBe('chg-001');
    expect(d.changeType).toBe('token-restructure');
    expect(d.description).toBe('Restructure color tokens into semantic layer');
    expect(d.estimatedTimeline).toBe('2026-06-01');
    expect(d.affectedTokenPaths).toEqual(['color.primary', 'color.secondary']);
    expect(d.estimatedComponentImpact).toBe(12);
    expect(d.plannedBy).toBe('design-lead');
    expect(Array.isArray(d.engineeringActions)).toBe(true);
    expect((d.engineeringActions as string[]).length).toBeGreaterThan(0);
  });

  it('AC #2: planned → in-progress transition does NOT re-emit', async () => {
    const inProgress: AnyPlannedChange = { ...plannedChange, status: 'in-progress' };
    const { events } = await runWithPlanned([plannedChange], [inProgress]);
    expect(events.filter((e) => e.type === 'DesignChangePlanned')).toEqual([]);
  });

  it('AC #5: planned → completed transition does NOT re-emit', async () => {
    const completed: AnyPlannedChange = { ...plannedChange, status: 'completed' };
    const { events } = await runWithPlanned([plannedChange], [completed]);
    expect(events.filter((e) => e.type === 'DesignChangePlanned')).toEqual([]);
  });

  it('AC #5: planned → cancelled transition does NOT re-emit', async () => {
    const cancelled: AnyPlannedChange = { ...plannedChange, status: 'cancelled' };
    const { events } = await runWithPlanned([plannedChange], [cancelled]);
    expect(events.filter((e) => e.type === 'DesignChangePlanned')).toEqual([]);
  });

  it('adding a change that starts at status=in-progress does NOT emit design-change.planned', async () => {
    const inProgressFromStart: AnyPlannedChange = {
      ...plannedChange,
      id: 'chg-002',
      status: 'in-progress',
    };
    const { events } = await runWithPlanned(undefined, [inProgressFromStart]);
    expect(events.filter((e) => e.type === 'DesignChangePlanned')).toEqual([]);
  });

  it('emits one event per newly-added planned entry when two are added at once', async () => {
    const change2: AnyPlannedChange = { ...plannedChange, id: 'chg-003' };
    const { events } = await runWithPlanned(undefined, [plannedChange, change2]);
    const planned = events.filter((e) => e.type === 'DesignChangePlanned');
    expect(planned).toHaveLength(2);
    const ids = planned.map((e) => (e.details as { changeId: string }).changeId).sort();
    expect(ids).toEqual(['chg-001', 'chg-003']);
  });

  it('engineeringActions includes visual-regression recommendation for token-restructure', async () => {
    const { events } = await runWithPlanned(undefined, [plannedChange]);
    const d = events[0].details as { engineeringActions: string[] };
    expect(d.engineeringActions.some((a) => a.includes('visual-regression'))).toBe(true);
  });

  it('engineeringActions omits visual-regression recommendation for token-addition', async () => {
    const addition: AnyPlannedChange = {
      ...plannedChange,
      id: 'chg-add',
      changeType: 'token-addition',
    };
    const { events } = await runWithPlanned(undefined, [addition]);
    const d = events[0].details as { engineeringActions: string[] };
    expect(d.engineeringActions.some((a) => a.includes('visual-regression'))).toBe(false);
  });

  it('snapshot persists plannedChangeIds so subsequent runs see the diff correctly', async () => {
    const { snap } = await runWithPlanned([plannedChange], [plannedChange]);
    expect(snap?.plannedChangeIds).toEqual(['chg-001']);
  });
});

// ── Identity-field flattening covers every optional DID surface ──────

describe('flattenIdentityFields — optional DID surfaces', () => {
  it('flattens constraints, scopeBoundaries, soul antiPatterns, nested principle anti-patterns, brand voice/visual, experientialTargets', () => {
    const did = baseDid({
      soulPurpose: {
        mission: { value: 'M', identityClass: 'core' },
        constraints: [
          {
            id: 'no-tech-expertise',
            concept: 'technical expertise',
            relationship: 'must-not-require',
            detectionPatterns: ['requires tech'],
            identityClass: 'core',
          },
          {
            id: 'bounded-cost',
            concept: 'budget',
            relationship: 'must-not-include',
            detectionPatterns: ['over budget'],
            // no identityClass → evolving default
          },
        ],
        scopeBoundaries: {
          inScope: [
            { label: 'customer onboarding', identityClass: 'core' },
            { label: 'post-purchase flows' }, // default evolving
          ],
          outOfScope: [
            { label: 'enterprise SSO', synonyms: ['SAML'] },
            { label: 'marketing CMS', identityClass: 'core' },
          ],
        },
        antiPatterns: [
          {
            id: 'wizard',
            label: 'multi-step wizard',
            detectionPatterns: ['step 1 of'],
            identityClass: 'core',
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Forms must be simple',
            identityClass: 'core',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
            antiPatterns: [
              {
                id: 'jargon',
                label: 'technical jargon',
                detectionPatterns: ['DSL', 'YAML'],
                identityClass: 'core',
              },
              {
                id: 'dense-copy',
                label: 'dense copy',
                detectionPatterns: ['paragraph'],
                // no identityClass → inherits from principle (core)
              },
            ],
          },
        ],
      },
      brandIdentity: {
        voiceAntiPatterns: [
          {
            id: 'corporate-speak',
            label: 'corporate-speak',
            detectionPatterns: ['synergy'],
            identityClass: 'core',
          },
        ],
        visualIdentity: {
          visualConstraints: [
            {
              id: 'color-palette',
              label: 'Palette size',
              description: 'Limit to 3 palette tokens',
              identityClass: 'evolving',
              rule: { metric: 'palette-count', threshold: 3, operator: 'lte' },
            },
          ],
          visualAntiPatterns: [
            {
              id: 'rainbow',
              label: 'rainbow gradients',
              detectionPatterns: ['gradient'],
              identityClass: 'core',
            },
          ],
        },
      },
      experientialTargets: {
        perceivedComplexity: { target: 'low', identityClass: 'core' },
        emotionalTone: { target: 'warm' }, // default evolving
      } as unknown as DesignIntentDocument['spec']['experientialTargets'],
    });

    const fields = flattenIdentityFields(did);
    const paths = fields.map((f) => f.path);

    expect(paths).toContain('spec.soulPurpose.constraints[no-tech-expertise]');
    expect(paths).toContain('spec.soulPurpose.constraints[bounded-cost]');
    expect(paths).toContain('spec.soulPurpose.scopeBoundaries.inScope[customer onboarding]');
    expect(paths).toContain('spec.soulPurpose.scopeBoundaries.inScope[post-purchase flows]');
    expect(paths).toContain('spec.soulPurpose.scopeBoundaries.outOfScope[enterprise SSO]');
    expect(paths).toContain('spec.soulPurpose.scopeBoundaries.outOfScope[marketing CMS]');
    expect(paths).toContain('spec.soulPurpose.antiPatterns[wizard]');
    expect(paths).toContain('spec.soulPurpose.designPrinciples[approachable].antiPatterns[jargon]');
    expect(paths).toContain(
      'spec.soulPurpose.designPrinciples[approachable].antiPatterns[dense-copy]',
    );
    expect(paths).toContain('spec.brandIdentity.voiceAntiPatterns[corporate-speak]');
    expect(paths).toContain('spec.brandIdentity.visualIdentity.visualConstraints[color-palette]');
    expect(paths).toContain('spec.brandIdentity.visualIdentity.visualAntiPatterns[rainbow]');
    expect(paths).toContain('spec.experientialTargets.perceivedComplexity');
    expect(paths).toContain('spec.experientialTargets.emotionalTone');

    // identityClass defaults wire correctly.
    const denseCopy = fields.find((f) => f.path.endsWith('antiPatterns[dense-copy]'))!;
    expect(denseCopy.identityClass).toBe('core'); // inherits from principle
    const boundedCost = fields.find((f) => f.path.endsWith('constraints[bounded-cost]'))!;
    expect(boundedCost.identityClass).toBe('evolving');
    const emotionalTone = fields.find((f) => f.path.endsWith('emotionalTone'))!;
    expect(emotionalTone.identityClass).toBe('evolving');
  });

  it('skips undefined experiential target entries', () => {
    const did = baseDid({
      experientialTargets: {
        perceivedComplexity: { target: 'low' },
        emotionalTone: undefined,
      } as unknown as DesignIntentDocument['spec']['experientialTargets'],
    });
    const fields = flattenIdentityFields(did);
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('spec.experientialTargets.perceivedComplexity');
    expect(paths).not.toContain('spec.experientialTargets.emotionalTone');
  });
});

// ── DSB rule corpus covers designReview.scope ────────────────────────

describe('findPrinciplesWithoutDsbCoverage — designReview.scope contribution', () => {
  it('designReview.scope keywords contribute to the corpus used for coverage', () => {
    const did = baseDid(); // principle description: "Forms must be simple..."
    // Ensure no compliance rules match. Coverage only possible via designReview.scope.
    const dsb = baseDsb({
      compliance: {
        coverage: { minimum: 85 },
        disallowHardcoded: [{ category: 'Unrelated', pattern: '\\bfoo\\b', message: 'bar baz' }],
      },
      designReview: { required: true, scope: ['forms'] },
    } as never);
    expect(findPrinciplesWithoutDsbCoverage(did, dsb)).toEqual([]);
  });
});

// ── Identity diff: removed-path branch ───────────────────────────────

describe('createDesignIntentReconciler — removed fields', () => {
  it('removing a core field emits CoreIdentityChanged with "(removed)" suffix', async () => {
    const initial = baseDid({
      soulPurpose: {
        mission: { value: 'M', identityClass: 'core' },
        antiPatterns: [
          {
            id: 'wizard',
            label: 'multi-step wizard',
            detectionPatterns: ['step 1 of'],
            identityClass: 'core',
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Forms must be simple',
            identityClass: 'core',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
          },
        ],
      },
    });
    const captureDeps = makeDeps({ dsb: baseDsb() });
    let snap: DesignIntentSnapshot | undefined;
    captureDeps.deps.saveSnapshot = async (_n, s) => {
      snap = s;
    };
    await createDesignIntentReconciler(captureDeps.deps)(initial);

    // Second run: remove the wizard anti-pattern.
    const mutated = baseDid({
      soulPurpose: {
        mission: { value: 'M', identityClass: 'core' },
        designPrinciples: initial.spec.soulPurpose.designPrinciples,
      },
    });
    const { deps, events } = makeDeps({ previous: snap, dsb: baseDsb() });
    await createDesignIntentReconciler(deps)(mutated);

    const core = events.filter((e) => e.type === 'CoreIdentityChanged');
    expect(core).toHaveLength(1);
    const changedFields = core[0].details.changedFields as string[];
    expect(changedFields.some((f) => f.includes('(removed)'))).toBe(true);
    expect(changedFields.some((f) => f.includes('antiPatterns[wizard]'))).toBe(true);
  });

  it('removing an evolving field emits EvolvingIdentityChanged with "(removed)" suffix', async () => {
    const initial = baseDid({
      soulPurpose: {
        mission: { value: 'M', identityClass: 'evolving' },
        constraints: [
          {
            id: 'legacy',
            concept: 'legacy system',
            relationship: 'must-not-require',
            detectionPatterns: ['deprecated'],
            // default evolving
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Forms must be simple',
            identityClass: 'evolving',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
          },
        ],
      },
    });
    const captureDeps = makeDeps({ dsb: baseDsb() });
    let snap: DesignIntentSnapshot | undefined;
    captureDeps.deps.saveSnapshot = async (_n, s) => {
      snap = s;
    };
    await createDesignIntentReconciler(captureDeps.deps)(initial);

    const mutated = baseDid({
      soulPurpose: {
        mission: { value: 'M', identityClass: 'evolving' },
        designPrinciples: initial.spec.soulPurpose.designPrinciples,
      },
    });
    const { deps, events } = makeDeps({ previous: snap, dsb: baseDsb() });
    await createDesignIntentReconciler(deps)(mutated);

    const evolving = events.filter((e) => e.type === 'EvolvingIdentityChanged');
    expect(evolving).toHaveLength(1);
    const changedFields = evolving[0].details.changedFields as string[];
    expect(changedFields.some((f) => f.includes('(removed)'))).toBe(true);
    expect(changedFields.some((f) => f.includes('constraints[legacy]'))).toBe(true);
  });
});
