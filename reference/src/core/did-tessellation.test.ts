/**
 * RFC-0009 Phase 1 — DID schema validation tests.
 *
 * Covers acceptance criteria:
 *   AC #2: triad / tessellation / parentTessellation field definitions in schema
 *   AC #3: triad required — missing-triad validation failure
 *   AC #6: mixed-fixture compatibility (Tessellated DID + Soul DIDs omitting optional fields)
 *   AC #8: happy path + missing-triad + invalid-tessellation
 *
 * Also covers:
 *   - AC #4: init scaffolding (see init-did.test.ts)
 *   - AC #5: existing fixtures auto-scaffolded via initDid (see init-did.test.ts)
 */

import { describe, it, expect } from 'vitest';
import { validate } from './validation.js';
import type { DesignIntentDocument, DesignIntentDocumentSpec, Tessellation } from './types.js';

// ── Test fixture builders ─────────────────────────────────────────────

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

/**
 * Minimal spec fields required by the schema for all DIDs.
 * Includes the triad block required by RFC-0009 OQ-1 resolution.
 */
function baseSpec(overrides: Partial<DesignIntentDocumentSpec> = {}): DesignIntentDocumentSpec {
  return {
    stewardship: {
      productAuthority: { owner: 'alex', approvalRequired: ['alex'], scope: ['mission'] },
      designAuthority: {
        owner: 'morgan',
        approvalRequired: ['morgan'],
        scope: ['designPrinciples'],
      },
    },
    soulPurpose: {
      mission: { value: 'Test soul purpose mission statement.', identityClass: 'core' },
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
    },
    designSystemRef: { name: 'test-design-system' },
    triad: {
      design: { authority: 'morgan' },
      engineering: { authority: 'dominique' },
      product: { authority: 'alex' },
    },
    ...overrides,
  };
}

function makeDid(
  spec: Partial<DesignIntentDocumentSpec> = {},
  name = 'test-did',
): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name },
    spec: baseSpec(spec),
  };
}

// ── AC #8 / AC #2: Happy path — single-product DID with triad ─────────

describe('RFC-0009 — single-product DID with triad (happy path)', () => {
  it('validates a minimal single-product DID with required triad block', () => {
    const did = makeDid();
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validates a single-product DID with full triad (all optional triad fields)', () => {
    const did = makeDid({
      triad: {
        design: {
          authority: 'morgan',
          imperatives: ['accessibility-floor: WCAG-AA'],
          overrides: { tokenSchemaVersion: 'v3' },
        },
        engineering: {
          authority: 'dominique',
          complianceRegimes: ['SOC2'],
          slaTier: 'enterprise',
          substrateInvariants: ['no-soul-conditionals-in-substrate'],
          performanceBudgets: { p95LatencyMs: 200 },
          dataRetention: { policy: '3-years' },
        },
        product: {
          authority: 'alex',
          targetAudience: 'enterprise ops teams',
          problemResonance: 'Teams need audit-ready workflows.',
          successMetrics: ['audit-pass-rate >= 100%'],
          monetizationModel: 'enterprise-seat',
          endgamePhase: 'scale',
        },
      },
    });
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(true);
  });

  it('validates when triad uses the default ${operator} authority placeholder', () => {
    const did = makeDid({
      triad: {
        design: { authority: '${operator}' },
        engineering: { authority: '${operator}' },
        product: { authority: '${operator}' },
      },
    });
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(true);
  });
});

// ── AC #3 / AC #8: missing triad fails validation ─────────────────────

describe('RFC-0009 — missing triad fails schema validation', () => {
  it('rejects a DID where spec.triad is absent', () => {
    const didWithoutTriad = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'missing-triad' },
      spec: {
        stewardship: {
          productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
          designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
        },
        soulPurpose: {
          mission: { value: 'Test.' },
          designPrinciples: [
            {
              id: 'p1',
              name: 'P1',
              description: 'description',
              measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
            },
          ],
        },
        designSystemRef: { name: 'ds' },
        // triad deliberately omitted — must fail
      },
    };
    const result = validate('DesignIntentDocument', didWithoutTriad);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    const errorPaths = result.errors!.map((e) => e.path);
    // Ajv required error appears at the spec level
    expect(errorPaths.some((p) => p === '/spec' || p.includes('triad'))).toBe(true);
  });

  it('rejects a DID where triad is present but missing the required design.authority', () => {
    const did = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'bad-triad' },
      spec: {
        ...baseSpec(),
        triad: {
          design: { imperatives: ['WCAG-AA'] }, // missing authority
          engineering: { authority: 'dominique' },
          product: { authority: 'alex' },
        },
      },
    };
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('rejects a DID where triad is missing the engineering vertex', () => {
    const did = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'bad-triad-2' },
      spec: {
        ...baseSpec(),
        triad: {
          design: { authority: 'morgan' },
          product: { authority: 'alex' },
          // engineering deliberately omitted
        },
      },
    };
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(false);
  });
});

// ── AC #2 / AC #8: Tessellated DID happy path ─────────────────────────

describe('RFC-0009 — Tessellated DID schema validation (happy path)', () => {
  const tessellation: Tessellation = {
    souls: [
      { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a', status: 'active' },
      { soulId: 'soul-b', didUri: 'did:platform-x:soul:soul-b', status: 'active' },
    ],
    crossSoulScoringRule: 'min',
    substrateInvariants: ['no-soul-conditionals-in-substrate'],
  };

  it('validates a minimal Tessellated DID with tessellation + triad', () => {
    const did = makeDid({ tessellation });
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validates a Tessellated DID with all crossSoulScoringRule options', () => {
    const rules: Tessellation['crossSoulScoringRule'][] = [
      'min',
      'max',
      'mean',
      'weighted-traffic',
      'weighted-revenue',
    ];
    for (const rule of rules) {
      const did = makeDid({ tessellation: { ...tessellation, crossSoulScoringRule: rule } });
      const result = validate('DesignIntentDocument', did);
      expect(result.valid).toBe(true);
    }
  });

  it('validates a Tessellated DID with tessellation soul entries omitting optional fields', () => {
    const did = makeDid({
      tessellation: {
        souls: [
          // Only required fields: soulId + didUri. status and inheritsSubstrate are optional.
          { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a' },
        ],
        // crossSoulScoringRule and substrateInvariants are optional
      },
    });
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(true);
  });
});

// ── AC #8: Invalid tessellation fails validation ───────────────────────

describe('RFC-0009 — invalid tessellation fails schema validation', () => {
  it('rejects a tessellation with an invalid crossSoulScoringRule value', () => {
    const did = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'bad-tessellation' },
      spec: {
        ...baseSpec(),
        tessellation: {
          souls: [{ soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a' }],
          crossSoulScoringRule: 'invalid-rule', // not in enum
        },
      },
    };
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('rejects a tessellation where soulId contains uppercase letters', () => {
    const did = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'bad-soul-id' },
      spec: {
        ...baseSpec(),
        tessellation: {
          souls: [{ soulId: 'Soul-A', didUri: 'did:platform-x:soul:soul-a' }], // uppercase invalid
        },
      },
    };
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(false);
  });

  it('rejects a tessellation with zero souls (minItems: 1)', () => {
    const did = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'empty-souls' },
      spec: {
        ...baseSpec(),
        tessellation: {
          souls: [], // empty array — minItems: 1 violation
        },
      },
    };
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(false);
  });

  it('rejects a tessellation soul entry missing the required didUri', () => {
    const did = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'missing-diduri' },
      spec: {
        ...baseSpec(),
        tessellation: {
          souls: [{ soulId: 'soul-a' }], // didUri missing — required
        },
      },
    };
    const result = validate('DesignIntentDocument', did);
    expect(result.valid).toBe(false);
  });
});

// ── AC #2: Soul DID with parentTessellation ───────────────────────────

describe('RFC-0009 — Soul DID with parentTessellation', () => {
  it('validates a Soul DID with parentTessellation + triad.inheritsFrom references', () => {
    const soulDid = makeDid(
      {
        parentTessellation: 'did:platform-x:platform',
        triad: {
          design: {
            authority: 'morgan',
            inheritsFrom: 'did:platform-x:platform/triad/design',
            imperatives: ['voice-register: alpha-specific'],
          },
          engineering: {
            authority: 'dominique',
            inheritsFrom: 'did:platform-x:platform/triad/engineering',
            complianceRegimes: ['HIPAA'],
          },
          product: {
            authority: 'alex',
            inheritsFrom: 'did:platform-x:platform/triad/product',
            targetAudience: 'alpha cohort',
            problemResonance: 'alpha cohort problem statement',
            successMetrics: ['HIPAA audit-pass rate >= 100%'],
          },
        },
      },
      'soul-a',
    );
    const result = validate('DesignIntentDocument', soulDid);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('validates a Soul DID with only parentTessellation (no tessellation)', () => {
    const soulDid = makeDid({ parentTessellation: 'did:platform-x:platform' }, 'soul-minimal');
    const result = validate('DesignIntentDocument', soulDid);
    expect(result.valid).toBe(true);
  });
});

// ── AC #6: Mixed-fixture compatibility ────────────────────────────────

describe('RFC-0009 — mixed-fixture compatibility (AC #6)', () => {
  /**
   * Tests the scenario where a Tessellated DID is present alongside Soul DIDs
   * that omit optional fields. Both must validate independently.
   * This guards the backward-compat contract per RFC-0009 §9.
   */
  it('Tessellated DID and Soul DID both validate with optional fields omitted on each', () => {
    // Tessellated DID: omits optional crossSoulScoringRule and substrateInvariants
    const tessellatedDid = makeDid(
      {
        tessellation: {
          souls: [
            { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a' },
            { soulId: 'soul-b', didUri: 'did:platform-x:soul:soul-b' },
          ],
          // no crossSoulScoringRule — optional
          // no substrateInvariants — optional
        },
        triad: {
          design: { authority: 'morgan' }, // no imperatives/overrides — optional
          engineering: { authority: 'dominique' }, // no complianceRegimes/slaTier — optional
          product: { authority: 'alex' }, // no targetAudience/problemResonance — optional
        },
      },
      'platform-x',
    );

    // Soul DID: omits optional inheritsFrom, imperatives, complianceRegimes
    const soulDid = makeDid(
      {
        parentTessellation: 'did:platform-x:platform',
        triad: {
          design: { authority: 'morgan' }, // no inheritsFrom/imperatives — optional
          engineering: { authority: 'dominique' }, // no inheritsFrom/complianceRegimes — optional
          product: { authority: 'alex' }, // no inheritsFrom/targetAudience — optional
        },
      },
      'soul-a',
    );

    const tResult = validate('DesignIntentDocument', tessellatedDid);
    const sResult = validate('DesignIntentDocument', soulDid);

    expect(tResult.valid).toBe(true);
    expect(sResult.valid).toBe(true);
  });

  it('single-product DID (no tessellation, no parentTessellation) is backward-compatible', () => {
    // A pre-RFC-0009 DID with only triad added — no tessellation fields.
    // This is the migration path for existing adopters (RFC-0009 §9 step 1).
    const singleProductDid = makeDid({
      // no tessellation
      // no parentTessellation
      // triad is the only RFC-0009 addition
    });
    const result = validate('DesignIntentDocument', singleProductDid);
    expect(result.valid).toBe(true);
  });

  it('all four production fixture shapes validate (Tessellated DID + 3 Soul DIDs)', () => {
    const tessellatedDid = makeDid(
      {
        tessellation: {
          souls: [
            { soulId: 'soul-a', didUri: 'did:platform-x:soul:soul-a', status: 'active' },
            { soulId: 'soul-b', didUri: 'did:platform-x:soul:soul-b', status: 'active' },
            { soulId: 'soul-c', didUri: 'did:platform-x:soul:soul-c', status: 'active' },
          ],
          crossSoulScoringRule: 'min',
          substrateInvariants: ['no-soul-conditionals-in-substrate', 'tenant-rls-required'],
        },
        triad: {
          design: { authority: 'morgan', imperatives: ['accessibility-floor: WCAG-AA'] },
          engineering: {
            authority: 'dominique',
            substrateInvariants: ['no-soul-conditionals-in-substrate', 'tenant-rls-required'],
            complianceRegimes: [],
          },
          product: {
            authority: 'alex',
            targetAudience: 'Platform-X serves multiple audiences via Soul DIDs.',
            successMetrics: ['per-soul success metrics aggregate; no platform-level metric'],
          },
        },
      },
      'platform-x',
    );

    const soulA = makeDid(
      {
        parentTessellation: 'did:platform-x:platform',
        triad: {
          design: {
            authority: 'morgan',
            inheritsFrom: 'did:platform-x:platform/triad/design',
            imperatives: ['voice-register: alpha-specific'],
          },
          engineering: {
            authority: 'dominique',
            inheritsFrom: 'did:platform-x:platform/triad/engineering',
            complianceRegimes: ['HIPAA'],
          },
          product: {
            authority: 'alex',
            inheritsFrom: 'did:platform-x:platform/triad/product',
            targetAudience: 'alpha cohort',
            problemResonance: 'alpha cohort problem statement',
          },
        },
      },
      'soul-a',
    );

    const soulB = makeDid(
      {
        parentTessellation: 'did:platform-x:platform',
        triad: {
          design: {
            authority: 'morgan',
            inheritsFrom: 'did:platform-x:platform/triad/design',
          },
          engineering: {
            authority: 'dominique',
            inheritsFrom: 'did:platform-x:platform/triad/engineering',
            complianceRegimes: ['SOC2'],
          },
          product: {
            authority: 'alex',
            inheritsFrom: 'did:platform-x:platform/triad/product',
            targetAudience: 'beta cohort',
          },
        },
      },
      'soul-b',
    );

    const soulC = makeDid(
      {
        parentTessellation: 'did:platform-x:platform',
        triad: {
          design: {
            authority: 'morgan',
            inheritsFrom: 'did:platform-x:platform/triad/design',
          },
          engineering: {
            authority: 'dominique',
            inheritsFrom: 'did:platform-x:platform/triad/engineering',
            complianceRegimes: ['PCI-DSS'],
          },
          product: {
            authority: 'alex',
            inheritsFrom: 'did:platform-x:platform/triad/product',
            targetAudience: 'gamma cohort',
          },
        },
      },
      'soul-c',
    );

    const fixtures = [tessellatedDid, soulA, soulB, soulC];
    for (const fixture of fixtures) {
      const result = validate('DesignIntentDocument', fixture);
      expect(result.valid, `Expected ${fixture.metadata.name} to validate cleanly`).toBe(true);
      expect(result.errors, `Expected no errors for ${fixture.metadata.name}`).toBeUndefined();
    }
  });
});
