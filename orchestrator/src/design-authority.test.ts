import { describe, it, expect } from 'vitest';
import type { DesignSystemBinding } from '@ai-sdlc/reference';
import { checkDesignAuthority, parseDesignSignalType } from './design-authority.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDsb(principals: string[]): DesignSystemBinding {
  return {
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
  };
}

describe('parseDesignSignalType', () => {
  it.each([
    [['design/advances-coherence'], 'advances-design-coherence'],
    [['design/fills-gap'], 'fills-catalog-gap'],
    [['design/fragments-catalog'], 'fragments-component-catalog'],
    [['design/misaligned-brand'], 'misaligned-with-brand'],
    [[], 'unspecified'],
    [['enhancement', 'security'], 'unspecified'],
  ])('%j → %s', (labels, expected) => {
    expect(parseDesignSignalType(labels)).toBe(expected);
  });

  it('prefers positive signals when both are present', () => {
    expect(parseDesignSignalType(['design/fragments-catalog', 'design/advances-coherence'])).toBe(
      'advances-design-coherence',
    );
  });

  it('is case-insensitive on labels', () => {
    expect(parseDesignSignalType(['Design/Advances-Coherence'])).toBe('advances-design-coherence');
  });
});

describe('checkDesignAuthority', () => {
  it('returns non-authority when no DSB is resolved', () => {
    const result = checkDesignAuthority({ authorLogin: 'anyone', labels: [] }, undefined);
    expect(result.isDesignAuthority).toBe(false);
    expect(result.signalType).toBe('unspecified');
  });

  it('returns authority=true when author is a design-authority principal', () => {
    const dsb = makeDsb(['alice', 'bob']);
    const result = checkDesignAuthority({ authorLogin: 'alice', labels: [] }, dsb);
    expect(result.isDesignAuthority).toBe(true);
    expect(result.signalType).toBe('unspecified');
  });

  it('returns authority=true when a commenter is a design-authority principal', () => {
    const dsb = makeDsb(['alice']);
    const result = checkDesignAuthority(
      { authorLogin: 'non-authority', commenterLogins: ['bob', 'alice'], labels: [] },
      dsb,
    );
    expect(result.isDesignAuthority).toBe(true);
  });

  it('returns false when neither author nor commenters are principals', () => {
    const dsb = makeDsb(['alice']);
    const result = checkDesignAuthority(
      { authorLogin: 'mallory', commenterLogins: ['bob'], labels: [] },
      dsb,
    );
    expect(result.isDesignAuthority).toBe(false);
  });

  it('is case-insensitive on principal matching', () => {
    const dsb = makeDsb(['Alice']);
    const result = checkDesignAuthority({ authorLogin: 'alice', labels: [] }, dsb);
    expect(result.isDesignAuthority).toBe(true);
  });

  it('resolves signalType from labels regardless of authority status', () => {
    const dsb = makeDsb(['alice']);
    const result = checkDesignAuthority(
      { authorLogin: 'alice', labels: ['design/advances-coherence'] },
      dsb,
    );
    expect(result.signalType).toBe('advances-design-coherence');
  });
});
