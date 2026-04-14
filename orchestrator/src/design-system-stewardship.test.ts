import { describe, it, expect } from 'vitest';
import { enforceStewardship } from './design-system-stewardship.js';
import type { DesignSystemBinding } from '@ai-sdlc/reference';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeBinding(): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'test-ds' },
    spec: {
      stewardship: {
        designAuthority: {
          principals: ['design-lead', 'design-system-team'],
          scope: ['conflictResolution', 'visualBaselines', 'tokenSchema'],
        },
        engineeringAuthority: {
          principals: ['eng-lead', 'platform-team'],
          scope: ['catalog', 'visualRegression.config', 'sync.schedule'],
        },
        sharedAuthority: {
          principals: ['design-lead', 'eng-lead'],
          scope: ['sync.direction', 'compliance.coverage.minimum'],
        },
        changeApproval: {
          requireBothDisciplines: true,
          auditAllChanges: true,
        },
      },
      designToolAuthority: 'collaborative',
      tokens: {
        provider: 'tokens-studio',
        format: 'w3c-dtcg',
        source: { repository: 'org/tokens' },
        versionPolicy: 'minor',
      },
      catalog: { provider: 'storybook-mcp' },
      compliance: { coverage: { minimum: 85 } },
    },
  };
}

describe('enforceStewardship', () => {
  it('allows design authority to change design-scoped fields', () => {
    const result = enforceStewardship(['tokenSchema'], 'design-lead', makeBinding());
    expect(result.allowed).toBe(true);
  });

  it('allows engineering authority to change engineering-scoped fields', () => {
    const result = enforceStewardship(['catalog'], 'eng-lead', makeBinding());
    expect(result.allowed).toBe(true);
  });

  it('rejects engineering changing design-scoped fields', () => {
    const result = enforceStewardship(['tokenSchema'], 'eng-lead', makeBinding());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('eng-lead');
    expect(result.reason).toContain('tokenSchema');
  });

  it('rejects design changing engineering-scoped fields', () => {
    const result = enforceStewardship(['catalog'], 'design-lead', makeBinding());
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('design-lead');
  });

  it('rejects unknown principal on scoped fields', () => {
    const result = enforceStewardship(['tokenSchema'], 'random-dev', makeBinding());
    expect(result.allowed).toBe(false);
  });

  it('allows shared authority principals on shared fields', () => {
    const result = enforceStewardship(['sync.direction'], 'design-lead', makeBinding());
    expect(result.allowed).toBe(true);
  });

  it('requires both disciplines for shared fields when requireBothDisciplines=true', () => {
    // eng-lead is only engineering, not design — needs design approval too
    const result = enforceStewardship(
      ['compliance.coverage.minimum'],
      'platform-team',
      makeBinding(),
    );
    expect(result.allowed).toBe(false);
    expect(result.requiredApprovals).toBeDefined();
  });

  it('allows shared authority from a principal in both disciplines', () => {
    // design-lead is in shared principals AND design principals
    const result = enforceStewardship(['sync.direction'], 'design-lead', makeBinding());
    expect(result.allowed).toBe(true);
  });

  it('allows unscoped fields for anyone', () => {
    const result = enforceStewardship(['some.unscoped.field'], 'random-dev', makeBinding());
    expect(result.allowed).toBe(true);
  });

  it('validates multiple fields — fails on first unauthorized', () => {
    const result = enforceStewardship(['catalog', 'tokenSchema'], 'eng-lead', makeBinding());
    // catalog is OK for eng-lead, but tokenSchema is design-scoped
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('tokenSchema');
  });
});
