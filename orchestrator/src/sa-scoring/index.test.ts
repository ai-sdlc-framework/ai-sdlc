import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';
import { StateStore } from '../state/store.js';
import { FakeDepparseClient } from './depparse-client.js';
import { RecordedLLMClient } from './layer3-llm.js';
import { resolveSoulAlignmentOverride, scoreSoulAlignment } from './index.js';
import { createSoulAlignmentShadow } from './admission-shadow.js';
import { computeAdmissionComposite } from '../admission-composite.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDid(): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: {
          value: 'Help small businesses onboard in under 60 seconds.',
          identityClass: 'core',
        },
        scopeBoundaries: {
          outOfScope: [
            {
              label: 'enterprise SSO',
              identityClass: 'core',
              synonyms: ['SAML'],
            },
          ],
        },
        constraints: [
          {
            id: 'no-dev',
            identityClass: 'core',
            concept: 'developer integration',
            relationship: 'must-not-require',
            detectionPatterns: ['requires developer'],
          },
        ],
        antiPatterns: [
          {
            id: 'wizard',
            label: 'wizard',
            detectionPatterns: ['setup wizard'],
            identityClass: 'core',
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Simple, intuitive forms.',
            identityClass: 'core',
            measurableSignals: [
              { id: 'ttv', metric: 'secondsToFirstValue', threshold: 60, operator: 'lte' },
            ],
          },
        ],
      },
      designSystemRef: { name: 'acme-ds' },
      // RFC-0009 §5.1: triad is now required on every DID.
      triad: {
        design: { authority: '${operator}' },
        engineering: { authority: '${operator}' },
        product: { authority: '${operator}' },
      },
    },
  };
}

function makeDsb(status?: {
  tokenCompliance?: number;
  catalogHealth?: number;
}): DesignSystemBinding {
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
      compliance: { coverage: { minimum: 85 } },
    },
    status: {
      tokenCompliance:
        status?.tokenCompliance !== undefined
          ? { currentCoverage: status.tokenCompliance }
          : undefined,
      catalogHealth:
        status?.catalogHealth !== undefined ? { coveragePercent: status.catalogHealth } : undefined,
    },
  };
}

function makeLLMClient(opts?: {
  domainIntent?: number;
  principleAlignment?: number;
  confidence?: number;
}): RecordedLLMClient {
  const client = new RecordedLLMClient();
  client.setResponse(
    'SA-1',
    JSON.stringify({
      domainIntent: opts?.domainIntent ?? 0.8,
      confidence: opts?.confidence ?? 0.9,
      subtleConflicts: [],
    }),
  );
  client.setResponse(
    'SA-2',
    JSON.stringify({
      principleAlignment: opts?.principleAlignment ?? 0.7,
      confidence: opts?.confidence ?? 0.9,
      subtleDesignConflicts: [],
    }),
  );
  return client;
}

describe('scoreSoulAlignment — integration', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('AC #1: Phase 2a shadow mode returns shadowMode=true and persists events', async () => {
    const result = await scoreSoulAlignment(
      {
        issueText: 'Add inventory sync via webhook for internal analytics.',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2a',
        issueNumber: 42,
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
        stateStore: store,
      },
    );
    expect(result.shadowMode).toBe(true);
    expect(result.phase).toBe('2a');
    expect(result.weights).toEqual({ wStructural: 0, wLlm: 0 });

    // AC #4: did_scoring_events rows written — one per dimension
    const sa1Events = store.getDidScoringEvents({ issueNumber: 42, saDimension: 'SA-1' });
    const sa2Events = store.getDidScoringEvents({ issueNumber: 42, saDimension: 'SA-2' });
    expect(sa1Events).toHaveLength(1);
    expect(sa2Events).toHaveLength(1);
    expect(sa1Events[0].phase).toBe('2a');
    expect(sa1Events[0].phaseWeightsJson).toBeDefined();
    expect(sa1Events[0].layer1ResultJson).toBeDefined();
  });

  it('Phase 2b: sa1 and sa2 are non-zero when clean text', async () => {
    const result = await scoreSoulAlignment(
      {
        issueText: 'Simplify small business onboarding to under 60 seconds.',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2b',
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient({ domainIntent: 0.8, principleAlignment: 0.7 }),
      },
    );
    expect(result.shadowMode).toBe(false);
    expect(result.sa1).toBeGreaterThan(0);
    expect(result.sa2).toBeGreaterThan(0);
    expect(result.weights).toEqual({ wStructural: 0.2, wLlm: 0.8 });
  });

  it('Phase 2b: hard-gated text forces SA-1 = 0 and skips Layer 3', async () => {
    const llm = makeLLMClient();
    const result = await scoreSoulAlignment(
      {
        issueText: 'Add SAML federation for enterprise customers',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2b',
      },
      {
        depparse: new FakeDepparseClient(),
        llm,
      },
    );
    expect(result.layer1.hardGated).toBe(true);
    expect(result.sa1).toBe(0);
    // Layer 3 skipped on hard gate
    expect(result.layer3).toBeUndefined();
    // LLM was not called
    expect(llm.promptLog).toHaveLength(0);
  });

  it('AC #3: Phase 3 clamps w_structural below 0.20 to the floor', async () => {
    const result = await scoreSoulAlignment(
      {
        issueText: 'Simple onboarding tweak',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '3',
        calibratedWeights: { wStructural: 0.05, wLlm: 0.95 },
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
      },
    );
    expect(result.weights.wStructural).toBe(0.2);
    expect(result.weights.wLlm).toBeCloseTo(0.8, 6);
  });

  it('persists compositeScore for each dimension', async () => {
    await scoreSoulAlignment(
      {
        issueText: 'Simple onboarding work',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2c',
        issueNumber: 7,
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
        stateStore: store,
      },
    );
    const sa1Events = store.getDidScoringEvents({ issueNumber: 7, saDimension: 'SA-1' });
    const sa2Events = store.getDidScoringEvents({ issueNumber: 7, saDimension: 'SA-2' });
    expect(sa1Events[0].compositeScore).toBeGreaterThanOrEqual(0);
    expect(sa2Events[0].compositeScore).toBeGreaterThanOrEqual(0);
  });

  it('does not persist when stateStore is absent', async () => {
    // Simply make sure no throw.
    const result = await scoreSoulAlignment(
      {
        issueText: 'hello',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2c',
        issueNumber: 1,
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
      },
    );
    expect(result.sa1).toBeGreaterThanOrEqual(0);
  });

  it('Layer 2 corpora are always computed, including in shadow mode (precision tracking)', async () => {
    const result = await scoreSoulAlignment(
      {
        issueText: 'Simple onboarding for small business',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2a',
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
      },
    );
    expect(result.layer2.domainRelevance.score).toBeGreaterThan(0);
    expect(result.layer2.principleCoverage.principles.length).toBeGreaterThan(0);
  });

  it('Layer 3 is called and returns in non-shadow modes', async () => {
    const llm = makeLLMClient();
    const result = await scoreSoulAlignment(
      {
        issueText: 'Simple onboarding tweak',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2b',
      },
      {
        depparse: new FakeDepparseClient(),
        llm,
      },
    );
    expect(result.layer3).toBeDefined();
    expect(llm.promptLog.length).toBe(2);
  });
});

describe('resolveSoulAlignmentOverride', () => {
  it('returns undefined in shadow mode (callers use label-based heuristic)', async () => {
    const result = await scoreSoulAlignment(
      {
        issueText: 'x',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2a',
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
      },
    );
    expect(resolveSoulAlignmentOverride(result)).toBeUndefined();
  });

  it('returns sa1 in non-shadow modes', async () => {
    const result = await scoreSoulAlignment(
      {
        issueText: 'Simple onboarding for small business',
        did: makeDid(),
        dsb: makeDsb({ tokenCompliance: 88, catalogHealth: 95 }),
        phase: '2c',
      },
      {
        depparse: new FakeDepparseClient(),
        llm: makeLLMClient(),
      },
    );
    expect(resolveSoulAlignmentOverride(result)).toBe(result.sa1);
  });
});

describe('admission shadow wiring (AISDLC-1211)', () => {
  const input = {
    issueNumber: 77,
    title: 'Add inventory sync',
    body: 'Sync inventory via webhook.',
    labels: ['enhancement'],
    reactionCount: 0,
    commentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('writes (0,0)-weight rows for every SA dimension, rank null, score unchanged', async () => {
    const db = new Database(':memory:');
    const store = StateStore.open(db);
    const errors: unknown[] = [];
    const shadow = createSoulAlignmentShadow({
      did: makeDid(),
      deps: { depparse: new FakeDepparseClient(), llm: makeLLMClient(), stateStore: store },
      issueText: () => `${input.title}\n${input.body}`,
      onError: (e) => errors.push(e),
    });
    const baseline = computeAdmissionComposite(input);
    const withShadow = computeAdmissionComposite(input, undefined, {
      soulAlignmentShadow: shadow,
    });
    expect(withShadow.score.composite).toBe(baseline.score.composite);
    expect(withShadow.score.dimensions.soulAlignment).toBe(baseline.score.dimensions.soulAlignment);

    await vi.waitFor(() => {
      expect(store.getDidScoringEvents({ issueNumber: 77 })).toHaveLength(2);
    });
    for (const dim of ['SA-1', 'SA-2'] as const) {
      const rows = store.getDidScoringEvents({ issueNumber: 77, saDimension: dim });
      expect(rows).toHaveLength(1);
      expect(rows[0].phase).toBe('2a');
      expect(typeof rows[0].compositeScore).toBe('number');
      expect(JSON.parse(rows[0].phaseWeightsJson!)).toEqual({
        wStructural: 0,
        wLlm: 0,
        rank: null,
      });
    }
    expect(errors).toEqual([]);
    store.close();
  });

  it('records a numeric claim rank when supplied and reports engine errors', async () => {
    const db = new Database(':memory:');
    const store = StateStore.open(db);
    createSoulAlignmentShadow({
      did: makeDid(),
      deps: { depparse: new FakeDepparseClient(), stateStore: store },
      issueText: () => 'x',
      claimRank: () => 3,
    })({ workItemId: '#78', issueNumber: 78, labelSoulAlignment: 0.5 });
    await vi.waitFor(() => {
      expect(store.getDidScoringEvents({ issueNumber: 78 })).toHaveLength(2);
    });
    const row = store.getDidScoringEvents({ issueNumber: 78, saDimension: 'SA-1' })[0];
    expect(JSON.parse(row.phaseWeightsJson!).rank).toBe(3);

    const errs: unknown[] = [];
    createSoulAlignmentShadow({
      did: {} as DesignIntentDocument,
      deps: { depparse: new FakeDepparseClient() },
      issueText: () => 'x',
      onError: (e) => errs.push(e),
    })({ workItemId: '#79', issueNumber: 79, labelSoulAlignment: 0.5 });
    await vi.waitFor(() => expect(errs).toHaveLength(1));
    store.close();
  });

  it('swallows a throwing shadow hook without altering admission', () => {
    const r = computeAdmissionComposite(input, undefined, {
      soulAlignmentShadow: () => {
        throw new Error('boom');
      },
    });
    expect(r.score.composite).toBe(computeAdmissionComposite(input).score.composite);
  });
});
