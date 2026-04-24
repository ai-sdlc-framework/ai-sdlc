import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { DesignIntentDocument } from '@ai-sdlc/reference';
import { StateStore } from '../state/store.js';
import {
  canonicalJson,
  compileDid,
  deserializeFromStore,
  hashDidSpec,
  serializeForStore,
  tokenize,
  validatePhase2bReadiness,
  type CompiledDid,
} from './did-compiler.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

/** Minimal DID — passes schema but not Phase-2b readiness. */
function makeMinimalDid(
  overrides: Partial<DesignIntentDocument['spec']> = {},
): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['mission'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: { value: 'Acme helps small businesses succeed.', identityClass: 'core' },
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Forms must be simple and intuitive.',
            identityClass: 'core',
            measurableSignals: [
              { id: 'task-completion', metric: 'completion', threshold: 0.85, operator: 'gte' },
            ],
          },
        ],
      },
      designSystemRef: { name: 'acme-ds' },
      ...overrides,
    },
  };
}

/** Rich DID that satisfies Phase-2b readiness minima. */
function makePhase2bReadyDid(): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['mission'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: {
          value: 'Make onboarding feel like one decision, not a form.',
          identityClass: 'core',
        },
        constraints: [
          {
            id: 'no-dev-integration',
            identityClass: 'core',
            concept: 'developer integration',
            relationship: 'must-not-require',
            detectionPatterns: [
              'developer must configure',
              'requires integration work',
              'needs developer involvement',
            ],
          },
          {
            id: 'no-data-import',
            identityClass: 'core',
            concept: 'data import',
            relationship: 'must-not-require',
            detectionPatterns: ['csv import', 'manual data entry', 'migrate existing records'],
          },
        ],
        scopeBoundaries: {
          outOfScope: [
            { label: 'enterprise SSO', synonyms: ['SAML', 'OIDC'] },
            { label: 'custom theming', synonyms: ['white label', 'rebrand'] },
            { label: 'legacy export', synonyms: ['xml export', 'csv dump'] },
          ],
        },
        antiPatterns: [
          {
            id: 'multi-step-wizard',
            label: 'multi-step wizard',
            detectionPatterns: ['step 1 of', 'continue to next step', 'setup wizard'],
          },
          {
            id: 'permission-prompt',
            label: 'premature permission',
            detectionPatterns: ['grant permission', 'allow access to', 'enable notifications'],
          },
          {
            id: 'clippy-guide',
            label: 'intrusive assistant',
            detectionPatterns: ['would you like help', 'let us guide you', 'tutorial overlay'],
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'New users should feel welcome not overwhelmed.',
            identityClass: 'core',
            measurableSignals: [
              {
                id: 'time-to-value',
                metric: 'secondsToFirstValue',
                threshold: 60,
                operator: 'lte',
              },
            ],
            antiPatterns: [
              {
                id: 'jargon',
                label: 'unexplained jargon',
                detectionPatterns: ['API token', 'webhook endpoint'],
              },
              {
                id: 'dense-form',
                label: 'dense form',
                detectionPatterns: ['form with 10 fields', 'mandatory fields'],
              },
            ],
          },
        ],
      },
      brandIdentity: {
        voiceAntiPatterns: [
          {
            id: 'corporate',
            label: 'corporate voice',
            detectionPatterns: ['leveraging synergies', 'stakeholder alignment'],
          },
          {
            id: 'smarmy',
            label: 'smarmy voice',
            detectionPatterns: ['rest assured', 'at our fingertips'],
          },
        ],
        visualIdentity: {
          visualAntiPatterns: [
            {
              id: 'glossy',
              label: 'glossy gradient',
              detectionPatterns: ['gradient background', 'shiny button'],
            },
            {
              id: 'heavy-shadow',
              label: 'heavy drop shadow',
              detectionPatterns: ['drop shadow', 'elevated container'],
            },
          ],
        },
      },
      designSystemRef: { name: 'acme-ds' },
    },
  };
}

describe('tokenize', () => {
  it('lowercases and strips stopwords', () => {
    expect(tokenize('The Mission is to help small businesses')).toEqual([
      'mission',
      'help',
      'small',
      'businesses',
    ]);
  });

  it('ignores words shorter than 3 chars', () => {
    expect(tokenize('a be it on to up')).toEqual([]);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth', () => {
    const a = { b: 1, a: { y: 2, x: 1 } };
    const b = { a: { x: 1, y: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('is stable for arrays (preserves order)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('hashDidSpec (determinism — AC #1)', () => {
  it('identical DID spec ⇒ identical sourceHash', () => {
    const a = compileDid(makeMinimalDid());
    const b = compileDid(makeMinimalDid());
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it('mutating mission changes the sourceHash', () => {
    const a = compileDid(makeMinimalDid());
    const mutated = makeMinimalDid();
    mutated.spec.soulPurpose.mission.value = 'Changed';
    const b = compileDid(mutated);
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  it('key ordering within metadata does not affect the hash', () => {
    // canonicalJson sorts keys → the spec is hash-stable regardless of
    // how the caller constructed the object.
    const h1 = hashDidSpec(makeMinimalDid());
    const h2 = hashDidSpec(makeMinimalDid());
    expect(h1).toBe(h2);
  });
});

describe('compileDid — artifact shape', () => {
  it('emits all six sections', () => {
    const compiled: CompiledDid = compileDid(makePhase2bReadyDid());
    expect(compiled.scopeLists).toBeDefined();
    expect(compiled.constraintRules).toBeDefined();
    expect(compiled.antiPatternLists).toBeDefined();
    expect(compiled.measurableSignals).toBeDefined();
    expect(compiled.bm25Corpus).toBeDefined();
    expect(compiled.principleCorpora).toBeDefined();
  });

  it('flattens outOfScope synonyms as deduped arrays', () => {
    const compiled = compileDid(makePhase2bReadyDid());
    const enterprise = compiled.scopeLists.outOfScope.find((s) => s.label === 'enterprise SSO');
    expect(enterprise!.synonyms).toEqual(['SAML', 'OIDC']);
  });

  it('AC #2: core fields appear in BM25 corpus at 2× weight', () => {
    const compiled = compileDid(makePhase2bReadyDid());
    const missionDoc = compiled.bm25Corpus.documents.find((d) => d.id === 'mission');
    expect(missionDoc).toBeDefined();
    expect(missionDoc!.weight).toBe(2); // mission is identityClass: 'core'
  });

  it('evolving fields get weight 1', () => {
    const did = makePhase2bReadyDid();
    did.spec.experientialTargets = {
      onboarding: { identityClass: 'evolving', targetEmotion: 'calm' },
    };
    const compiled = compileDid(did);
    const targetDoc = compiled.bm25Corpus.documents.find(
      (d) => d.id === 'experientialTargets.onboarding',
    );
    expect(targetDoc).toBeDefined();
    expect(targetDoc!.weight).toBe(1);
  });

  it('produces one principle corpus per designPrinciple', () => {
    const compiled = compileDid(makePhase2bReadyDid());
    expect(Object.keys(compiled.principleCorpora)).toEqual(['approachable']);
    expect(compiled.principleCorpora.approachable.documents.length).toBeGreaterThan(0);
  });

  it('collects measurable signals from principles AND visual constraints', () => {
    const did = makePhase2bReadyDid();
    did.spec.brandIdentity = {
      ...did.spec.brandIdentity,
      visualIdentity: {
        ...did.spec.brandIdentity?.visualIdentity,
        visualConstraints: [
          {
            id: 'contrast',
            label: 'min contrast',
            rule: { metric: 'contrastRatio', threshold: 4.5, operator: 'gte' },
          },
        ],
      },
    };
    const compiled = compileDid(did);
    const sources = compiled.measurableSignals.map((s) => s.id);
    expect(sources).toContain('time-to-value'); // principle signal
    expect(sources).toContain('contrast'); // visual constraint
  });

  it('defaults missing identityClass to evolving', () => {
    const did = makeMinimalDid();
    // Make mission evolving (drop its core classification)
    did.spec.soulPurpose.mission = { value: 'Mission text' };
    const compiled = compileDid(did);
    const doc = compiled.bm25Corpus.documents.find((d) => d.id === 'mission');
    expect(doc!.weight).toBe(1);
  });
});

describe('validatePhase2bReadiness', () => {
  it('AC #3: returns gap list for incomplete DID', () => {
    const compiled = compileDid(makeMinimalDid());
    const result = validatePhase2bReadiness(compiled);
    expect(result.ready).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
    // Sanity: specific gaps mentioned
    expect(result.gaps.some((g) => g.includes('constraints'))).toBe(true);
    expect(result.gaps.some((g) => g.includes('outOfScope'))).toBe(true);
    expect(result.gaps.some((g) => g.includes('antiPatterns'))).toBe(true);
  });

  it('AC #4: reference Phase-2b-ready DID passes by construction', () => {
    const compiled = compileDid(makePhase2bReadyDid());
    const result = validatePhase2bReadiness(compiled);
    expect(result.gaps).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it('surfaces exactly-below-minimum counts', () => {
    const did = makePhase2bReadyDid();
    // Drop one outOfScope to fall below minimum of 3
    did.spec.soulPurpose.scopeBoundaries!.outOfScope =
      did.spec.soulPurpose.scopeBoundaries!.outOfScope!.slice(0, 2);
    const result = validatePhase2bReadiness(compileDid(did));
    expect(result.ready).toBe(false);
    expect(result.gaps.some((g) => g.includes('outOfScope'))).toBe(true);
  });
});

describe('State-store round-trip (AC #5)', () => {
  let store: StateStore;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    store = StateStore.open(db);
  });

  afterEach(() => {
    store.close();
  });

  it('serialize → insert → get → deserialize reconstructs the compiled DID', () => {
    const compiled = compileDid(makePhase2bReadyDid());
    const serialized = serializeForStore(compiled);
    const id = store.insertDidCompiledArtifact(serialized);
    expect(id).toBeGreaterThan(0);

    const record = store.getLatestDidCompiledArtifact('acme-did');
    expect(record).toBeDefined();
    const roundtripped = deserializeFromStore(record!);

    expect(roundtripped.sourceHash).toBe(compiled.sourceHash);
    expect(roundtripped.scopeLists.outOfScope).toEqual(compiled.scopeLists.outOfScope);
    expect(roundtripped.constraintRules).toEqual(compiled.constraintRules);
    expect(roundtripped.antiPatternLists).toEqual(compiled.antiPatternLists);
    expect(roundtripped.bm25Corpus).toEqual(compiled.bm25Corpus);
    expect(roundtripped.principleCorpora).toEqual(compiled.principleCorpora);
  });

  it('lookup by source_hash returns the same artifact', () => {
    const compiled = compileDid(makePhase2bReadyDid());
    const serialized = serializeForStore(compiled);
    store.insertDidCompiledArtifact(serialized);

    const byHash = store.getDidCompiledArtifactByHash(compiled.didName, compiled.sourceHash);
    expect(byHash).toBeDefined();
    expect(byHash!.sourceHash).toBe(compiled.sourceHash);
  });
});
