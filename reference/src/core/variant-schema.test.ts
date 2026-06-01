/**
 * RFC-0017 Phase 1 — JSON schema validation tests for variants[] on Soul DID.
 *
 * Covers AISDLC-435 acceptance criteria:
 *   AC #1: Soul DID schema has variants[] array per §5.1.
 *   AC #1a: designOverrides closed enum accepts ONLY v0.4 field set;
 *           voiceRegister rejected; vendor-prefixed keys accepted;
 *           non-prefixed unknown keys rejected.
 *   AC #2: Work Item schema has optional targetedVariants[] field with path-style URI per OQ-6.
 *   AC #6: Nested variants[] rejected at schema validation (OQ-2 schema-enforced flat).
 */

import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { SCHEMAS, designIntentDocumentSchema, workItemSchema } from './generated-schemas.js';
import { validate } from './validation.js';

// Handle CJS default export interop
const _Ajv2020 = Ajv2020 as unknown as typeof Ajv2020.default;
const _addFormats = addFormats as unknown as typeof addFormats.default;

// ── AJV instance with variant schema loaded ──────────────────────────────────

function makeAjv() {
  const ajv = new _Ajv2020({ allErrors: true, strict: false });
  _addFormats(ajv);
  // Register all schemas so cross-schema $ref resolution works
  // (e.g. design-intent-document references journey.v1.schema.json).
  for (const schema of Object.values(SCHEMAS)) {
    ajv.addSchema(schema);
  }
  return ajv;
}

// ── Minimal valid Soul DID fixture (non-tessellated) ─────────────────────────

const MINIMAL_SOUL_DID = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'DesignIntentDocument',
  metadata: { name: 'spry-engage' },
  spec: {
    stewardship: {
      productAuthority: {
        owner: 'alex',
        approvalRequired: ['alex'],
        scope: ['mission'],
      },
      designAuthority: {
        owner: 'morgan',
        approvalRequired: ['morgan'],
        scope: ['designPrinciples'],
      },
    },
    soulPurpose: {
      mission: { value: 'Serve municipal government with clear, efficient tools.' },
      designPrinciples: [
        {
          id: 'clarity',
          name: 'Clarity',
          description: 'Every screen communicates one primary task.',
          measurableSignals: [
            {
              id: 'task-completion',
              metric: 'task-completion-rate',
              threshold: 0.9,
              operator: 'gte',
            },
          ],
        },
      ],
    },
    designSystemRef: { name: 'spry-design-system' },
    triad: {
      design: { authority: 'morgan' },
      engineering: { authority: 'dom' },
      product: { authority: 'alex' },
    },
  },
};

// ── AC #1: variants[] accepted on Soul DID ───────────────────────────────────

describe('Soul DID schema — variants[] additions (AC #1)', () => {
  it('accepts a Soul DID without variants[] (backward-compat)', () => {
    const result = validate('DesignIntentDocument', MINIMAL_SOUL_DID);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('accepts a Soul DID with a single valid variant', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'small-utility',
            targetAudience: { segments: ['municipal-small'] },
            complianceFloor: 'inherit',
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(true);
  });

  it('accepts a Soul DID with multiple valid variants (all optional fields)', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'small-utility',
            targetAudience: {
              segments: ['municipal-small'],
              sizeRange: { minStaff: 1, maxStaff: 50 },
            },
            designOverrides: {
              colorPaletteOverlay: 'small-utility-warm',
              densityProfile: 'comfortable',
              typographyScale: 'large-print',
              motionProfile: 'reduced',
              radiusProfile: 'rounded',
            },
            complianceFloor: 'inherit',
            designImperatives: ['low-tech-fluency-tolerance', 'single-task-focus-per-screen'],
            cardinality: 'primary',
          },
          {
            id: 'enterprise',
            targetAudience: {
              segments: ['municipal-large'],
              sizeRange: { minStaff: 51, maxStaff: 5000 },
            },
            designOverrides: {
              densityProfile: 'compact',
              motionProfile: 'full',
              radiusProfile: 'sharp',
            },
            complianceFloor: 'inherit',
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(true);
  });

  it('rejects a variant missing required field "id"', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            // missing id
            targetAudience: { segments: ['municipal-small'] },
            complianceFloor: 'inherit',
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects a variant missing required field "targetAudience"', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [{ id: 'small-utility', complianceFloor: 'inherit' }],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects a variant missing required field "complianceFloor"', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [{ id: 'small-utility', targetAudience: { segments: [] } }],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects a variant with complianceFloor !== "inherit"', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'bad-variant',
            targetAudience: { segments: [] },
            complianceFloor: 'HIPAA', // MUST be 'inherit'
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects a variant id that is not kebab-case', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'SmallUtility', // PascalCase — not allowed
            targetAudience: { segments: [] },
            complianceFloor: 'inherit',
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });
});

// ── AC #1a: designOverrides closed enum ─────────────────────────────────────

describe('Soul DID schema — designOverrides closed enum (AC #1a)', () => {
  it('accepts all five framework-owned fields', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: {
              colorPaletteOverlay: 'my-palette',
              densityProfile: 'compact',
              typographyScale: 'large-print',
              motionProfile: 'none',
              radiusProfile: 'rounded',
            },
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(true);
  });

  it('rejects densityProfile with an invalid enum value', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: { densityProfile: 'airy' }, // not in enum
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects typographyScale with an invalid enum value', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: { typographyScale: 'extra-large' }, // not in enum
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects motionProfile with an invalid enum value', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: { motionProfile: 'minimal' }, // not in enum
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects radiusProfile with an invalid enum value', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: { radiusProfile: 'pill' }, // not in enum
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects non-prefixed unknown key in designOverrides (additionalProperties: false)', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: { voiceRegister: 'informal' }, // cut in v0.4 editorial
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects another non-prefixed unknown key ("layout") in designOverrides', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: { layout: 'grid' }, // not a framework field, no vendor prefix
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });

  it('accepts vendor-prefixed extension keys via patternProperties', () => {
    // AJV 2020-12 patternProperties validation
    const ajv = makeAjv();
    const validator = ajv.compile(designIntentDocumentSchema);
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'v1',
            targetAudience: { segments: ['test'] },
            complianceFloor: 'inherit',
            designOverrides: {
              'acme.com/accessibilityProfile': 'wcag-aa-plus',
              'beta.org/animationBudget': '100ms',
            },
          },
        ],
      },
    };
    const valid = validator(doc);
    expect(valid).toBe(true);
  });
});

// ── AC #2: targetedVariants[] on Work Item schema ────────────────────────────

describe('Work Item schema — targetedVariants[] (AC #2)', () => {
  it('accepts a work item with no targetedVariants (backward-compat)', () => {
    const ajv = makeAjv();
    const validator = ajv.compile(workItemSchema);
    const workItem = { id: 'AISDLC-313', title: 'Add onboarding flow' };
    expect(validator(workItem)).toBe(true);
  });

  it('accepts a work item with valid path-style URI targetedVariants', () => {
    const ajv = makeAjv();
    const validator = ajv.compile(workItemSchema);
    const workItem = {
      id: 'AISDLC-313',
      title: 'Small-utility onboarding improvement',
      targetedSouls: ['spry-engage'],
      targetedVariants: [
        'did:platform-x:soul:spry-engage/variant:small-utility',
        'did:ai-sdlc:prod:soul:acme-engage/variant:enterprise',
      ],
    };
    expect(validator(workItem)).toBe(true);
  });

  it('rejects targetedVariants entry without path-style URI format', () => {
    const ajv = makeAjv();
    const validator = ajv.compile(workItemSchema);
    const workItem = {
      id: 'AISDLC-313',
      title: 'Test',
      targetedVariants: ['spry-engage/small-utility'], // slug-pair not a valid URI
    };
    const valid = validator(workItem);
    expect(valid).toBe(false);
  });

  it('rejects targetedVariants entry that omits the "variant:" keyword', () => {
    const ajv = makeAjv();
    const validator = ajv.compile(workItemSchema);
    const workItem = {
      id: 'AISDLC-313',
      title: 'Test',
      targetedVariants: ['did:platform-x:soul:spry-engage/small-utility'], // missing "variant:"
    };
    const valid = validator(workItem);
    expect(valid).toBe(false);
  });

  it('accepts an empty targetedVariants array', () => {
    const ajv = makeAjv();
    const validator = ajv.compile(workItemSchema);
    const workItem = { id: 'AISDLC-313', title: 'Test', targetedVariants: [] };
    expect(validator(workItem)).toBe(true);
  });
});

// ── AC #6: Nested variants[] rejected at schema validation ───────────────────

describe('Soul DID schema — nested variants rejection (AC #6)', () => {
  it('rejects a variant declaration that contains a nested variants field', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'small-utility',
            targetAudience: { segments: ['municipal-small'] },
            complianceFloor: 'inherit',
            variants: [{ id: 'sub-variant' }], // additionalProperties: false rejects this
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it('rejects an empty nested variants array too', () => {
    const doc = {
      ...MINIMAL_SOUL_DID,
      spec: {
        ...MINIMAL_SOUL_DID.spec,
        variants: [
          {
            id: 'small-utility',
            targetAudience: { segments: ['municipal-small'] },
            complianceFloor: 'inherit',
            variants: [], // still forbidden — any key is rejected by additionalProperties: false
          },
        ],
      },
    };
    const result = validate('DesignIntentDocument', doc);
    expect(result.valid).toBe(false);
  });
});

// ── Schema export verification ───────────────────────────────────────────────

describe('generated-schemas.ts — variant schema included', () => {
  it('includes design-intent-document.schema.json in the SCHEMAS map', () => {
    expect(SCHEMAS['design-intent-document.schema.json']).toBeDefined();
  });

  it('includes work-item.schema.json in the SCHEMAS map', () => {
    expect(SCHEMAS['work-item.schema.json']).toBeDefined();
  });

  it('includes variant-config.schema.json in the SCHEMAS map', () => {
    expect(SCHEMAS['variant-config.schema.json']).toBeDefined();
  });
});
