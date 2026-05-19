/**
 * RFC-0009 Phase 1 — init scaffolding tests.
 *
 * Covers acceptance criteria:
 *   AC #4: `init` scaffolding ships for the required-with-defaults pattern
 *   AC #5: existing fixtures auto-scaffolded with `triad` blocks via `init` re-run;
 *           backward-compat preserved (idempotent on already-migrated DIDs)
 */

import { describe, it, expect } from 'vitest';
import { initDid, initDids, buildDefaultTriad } from './init-did.js';
import { validate } from './validation.js';
import type { DesignIntentDocument } from './types.js';

// ── Fixture builders ──────────────────────────────────────────────────

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

/** A pre-RFC-0009 DID without a triad block — simulates an existing fixture. */
function legacyDid(name = 'legacy-acme'): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name },
    spec: {
      stewardship: {
        productAuthority: { owner: 'alex', approvalRequired: ['alex'], scope: ['mission'] },
        designAuthority: {
          owner: 'morgan',
          approvalRequired: ['morgan'],
          scope: ['designPrinciples'],
        },
      },
      soulPurpose: {
        mission: { value: 'Legacy mission statement.', identityClass: 'core' },
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
      designSystemRef: { name: 'acme-design-system' },
      // No triad — pre-RFC-0009 fixture
      triad: undefined as never, // cast to bypass TS requirement; simulates legacy YAML
    },
  };
}

// ── buildDefaultTriad ────────────────────────────────────────────────

describe('buildDefaultTriad', () => {
  it('defaults all three authorities to the ${operator} placeholder when no options given', () => {
    const triad = buildDefaultTriad();
    expect(triad.design.authority).toBe('${operator}');
    expect(triad.engineering.authority).toBe('${operator}');
    expect(triad.product.authority).toBe('${operator}');
  });

  it('uses the provided operator string when options.operator is set', () => {
    const triad = buildDefaultTriad({ operator: 'dominique' });
    expect(triad.design.authority).toBe('dominique');
    expect(triad.engineering.authority).toBe('dominique');
    expect(triad.product.authority).toBe('dominique');
  });

  it('overrides individual vertices via options.roles', () => {
    const triad = buildDefaultTriad({
      operator: 'dominique',
      roles: {
        design: 'morgan',
        product: 'alex',
        // engineering falls through to operator
      },
    });
    expect(triad.design.authority).toBe('morgan');
    expect(triad.product.authority).toBe('alex');
    expect(triad.engineering.authority).toBe('dominique'); // operator default
  });

  it('only overrides the design pillar when only design role is provided', () => {
    const triad = buildDefaultTriad({
      operator: 'dominique',
      roles: { design: 'morgan' },
    });
    expect(triad.design.authority).toBe('morgan');
    expect(triad.engineering.authority).toBe('dominique');
    expect(triad.product.authority).toBe('dominique');
  });

  it('produces a triad with no extra keys (minimal default)', () => {
    const triad = buildDefaultTriad({ operator: 'dominique' });
    // Each vertex should have only the authority key (no undefined optional fields)
    expect(Object.keys(triad.design)).toEqual(['authority']);
    expect(Object.keys(triad.engineering)).toEqual(['authority']);
    expect(Object.keys(triad.product)).toEqual(['authority']);
  });
});

// ── initDid — AC #4: init scaffolding ─────────────────────────────────

describe('initDid', () => {
  it('AC #4: adds a triad block to a DID that lacks one', () => {
    const legacy = legacyDid();
    const migrated = initDid(legacy, { operator: 'dominique' });
    expect(migrated.spec.triad).toBeDefined();
    expect(migrated.spec.triad.design.authority).toBe('dominique');
    expect(migrated.spec.triad.engineering.authority).toBe('dominique');
    expect(migrated.spec.triad.product.authority).toBe('dominique');
  });

  it('AC #5: is idempotent — does not mutate a DID that already has a triad block', () => {
    const alreadyMigrated: DesignIntentDocument = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'already-migrated' },
      spec: {
        stewardship: {
          productAuthority: { owner: 'alex', approvalRequired: ['alex'], scope: ['m'] },
          designAuthority: { owner: 'morgan', approvalRequired: ['morgan'], scope: ['dp'] },
        },
        soulPurpose: {
          mission: { value: 'Already migrated.' },
          designPrinciples: [
            {
              id: 'p1',
              name: 'P1',
              description: 'd',
              identityClass: 'core',
              measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
            },
          ],
        },
        designSystemRef: { name: 'ds' },
        triad: {
          design: { authority: 'specific-design-authority' },
          engineering: { authority: 'specific-engineering-authority' },
          product: { authority: 'specific-product-authority' },
        },
      },
    };

    const result = initDid(alreadyMigrated, { operator: 'dominique' });
    // The existing triad is preserved — initDid is idempotent.
    expect(result.spec.triad.design.authority).toBe('specific-design-authority');
    expect(result.spec.triad.engineering.authority).toBe('specific-engineering-authority');
    expect(result.spec.triad.product.authority).toBe('specific-product-authority');
  });

  it('AC #5: idempotent — returns the same reference when triad already present', () => {
    const already = legacyDid();
    already.spec.triad = {
      design: { authority: 'morgan' },
      engineering: { authority: 'dominique' },
      product: { authority: 'alex' },
    };
    const result = initDid(already, { operator: 'dominique' });
    // Same object returned (no cloning when triad already exists)
    expect(result).toBe(already);
  });

  it('does not mutate the input document', () => {
    const legacy = legacyDid();
    const originalSpec = { ...legacy.spec };
    initDid(legacy, { operator: 'dominique' });
    // Input is unchanged
    expect(legacy.spec.triad).toEqual(originalSpec.triad);
  });

  it('uses the ${operator} placeholder when no operator option is provided', () => {
    const legacy = legacyDid();
    const migrated = initDid(legacy);
    expect(migrated.spec.triad.design.authority).toBe('${operator}');
    expect(migrated.spec.triad.engineering.authority).toBe('${operator}');
    expect(migrated.spec.triad.product.authority).toBe('${operator}');
  });

  it('applies role overrides correctly', () => {
    const legacy = legacyDid();
    const migrated = initDid(legacy, {
      operator: 'dominique',
      roles: { design: 'morgan', product: 'alex' },
    });
    expect(migrated.spec.triad.design.authority).toBe('morgan');
    expect(migrated.spec.triad.product.authority).toBe('alex');
    expect(migrated.spec.triad.engineering.authority).toBe('dominique');
  });

  it('AC #5: output DID validates against schema after init scaffolding', () => {
    const legacy = legacyDid();
    const migrated = initDid(legacy, { operator: 'dominique' });
    const result = validate('DesignIntentDocument', migrated);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('AC #5: DID without triad fails schema validation before init; passes after', () => {
    const legacy = legacyDid();
    const beforeResult = validate('DesignIntentDocument', legacy);
    expect(beforeResult.valid).toBe(false); // missing triad → invalid

    const migrated = initDid(legacy, { operator: 'dominique' });
    const afterResult = validate('DesignIntentDocument', migrated);
    expect(afterResult.valid).toBe(true); // triad scaffolded → valid
  });
});

// ── initDids — batch scaffolding ──────────────────────────────────────

describe('initDids', () => {
  it('scaffolds triad blocks on all DIDs in a batch', () => {
    const docs = [legacyDid('did-1'), legacyDid('did-2'), legacyDid('did-3')];
    const migrated = initDids(docs, { operator: 'dominique' });
    expect(migrated).toHaveLength(3);
    for (const doc of migrated) {
      expect(doc.spec.triad).toBeDefined();
      expect(doc.spec.triad.design.authority).toBe('dominique');
    }
  });

  it('is idempotent on a batch with mixed legacy + already-migrated DIDs', () => {
    const alreadyMigrated: DesignIntentDocument = {
      ...legacyDid('already-migrated'),
      spec: {
        ...legacyDid('already-migrated').spec,
        triad: {
          design: { authority: 'preserved-design' },
          engineering: { authority: 'preserved-engineering' },
          product: { authority: 'preserved-product' },
        },
      },
    };
    const legacy = legacyDid('legacy-in-batch');
    const migrated = initDids([alreadyMigrated, legacy], { operator: 'dominique' });

    expect(migrated[0].spec.triad.design.authority).toBe('preserved-design');
    expect(migrated[1].spec.triad.design.authority).toBe('dominique');
  });

  it('all outputs validate against schema', () => {
    const docs = [legacyDid('a'), legacyDid('b')];
    const migrated = initDids(docs, { operator: 'dominique' });
    for (const doc of migrated) {
      const result = validate('DesignIntentDocument', doc);
      expect(result.valid).toBe(true);
    }
  });
});
