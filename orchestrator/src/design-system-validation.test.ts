import { describe, it, expect } from 'vitest';
import type { DesignSystemBinding } from '@ai-sdlc/reference';
import {
  validateDesignSystemInheritance,
  validateAllInheritance,
  resolveParent,
} from './design-system-validation.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeBinding(
  name: string,
  overrides: Partial<{
    extends: string;
    minimum: number;
    target: number;
    categories: string[];
  }> = {},
): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name },
    spec: {
      extends: overrides.extends,
      stewardship: {
        designAuthority: { principals: ['design-lead'], scope: ['tokenSchema'] },
        engineeringAuthority: { principals: ['eng-lead'], scope: ['catalog'] },
      },
      designToolAuthority: 'collaborative',
      tokens: {
        provider: 'tokens-studio',
        format: 'w3c-dtcg',
        source: { repository: 'org/tokens' },
        versionPolicy: 'minor',
      },
      catalog: { provider: 'storybook-mcp' },
      compliance: {
        disallowHardcoded: (overrides.categories ?? ['color', 'spacing']).map((c) => ({
          category: c,
          pattern: '.*',
          message: `Use a ${c} token`,
        })),
        coverage: {
          minimum: overrides.minimum ?? 85,
          target: overrides.target ?? 95,
        },
      },
    },
  };
}

describe('resolveParent', () => {
  it('returns undefined when binding has no extends', () => {
    const binding = makeBinding('base');
    expect(resolveParent(binding, [binding])).toBeUndefined();
  });

  it('resolves parent by name', () => {
    const parent = makeBinding('base');
    const child = makeBinding('child', { extends: 'base' });
    expect(resolveParent(child, [parent, child])).toBe(parent);
  });

  it('returns undefined when parent not found', () => {
    const child = makeBinding('child', { extends: 'nonexistent' });
    expect(resolveParent(child, [child])).toBeUndefined();
  });
});

describe('validateDesignSystemInheritance', () => {
  it('passes when child tightens minimum coverage', () => {
    const parent = makeBinding('base', { minimum: 85 });
    const child = makeBinding('child', { extends: 'base', minimum: 92 });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when child has equal thresholds to parent', () => {
    const parent = makeBinding('base', { minimum: 85, target: 95 });
    const child = makeBinding('child', { extends: 'base', minimum: 85, target: 95 });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(true);
  });

  it('rejects when child loosens minimum coverage', () => {
    const parent = makeBinding('base', { minimum: 85 });
    const child = makeBinding('child', { extends: 'base', minimum: 70 });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('compliance.coverage.minimum');
    expect(result.errors[0].message).toContain('70');
    expect(result.errors[0].message).toContain('85');
  });

  it('rejects when child loosens target coverage', () => {
    const parent = makeBinding('base', { minimum: 85, target: 95 });
    const child = makeBinding('child', { extends: 'base', minimum: 85, target: 90 });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('compliance.coverage.target');
  });

  it('passes when child adds new disallowHardcoded categories', () => {
    const parent = makeBinding('base', { categories: ['color', 'spacing'] });
    const child = makeBinding('child', {
      extends: 'base',
      categories: ['color', 'spacing', 'typography'],
    });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(true);
  });

  it('rejects when child removes parent disallowHardcoded category', () => {
    const parent = makeBinding('base', { categories: ['color', 'spacing'] });
    const child = makeBinding('child', { extends: 'base', categories: ['color'] });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('compliance.disallowHardcoded');
    expect(result.errors[0].message).toContain('spacing');
  });

  it('rejects three-level inheritance (grandchild)', () => {
    const grandparent = makeBinding('grandparent');
    const parent = makeBinding('parent', { extends: 'grandparent' });
    const child = makeBinding('child', { extends: 'parent' });
    // When validating child against parent, parent has extends → depth exceeded
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'extends')).toBe(true);
    expect(result.errors[0].message).toContain('two levels');
    // grandparent reference to suppress unused var lint
    expect(grandparent.metadata.name).toBe('grandparent');
  });

  it('reports multiple errors simultaneously', () => {
    const parent = makeBinding('base', {
      minimum: 85,
      target: 95,
      categories: ['color', 'spacing'],
    });
    const child = makeBinding('child', {
      extends: 'base',
      minimum: 70,
      target: 80,
      categories: ['color'],
    });
    const result = validateDesignSystemInheritance(child, parent);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateAllInheritance', () => {
  it('passes when no bindings have extends', () => {
    const bindings = [makeBinding('a'), makeBinding('b')];
    const result = validateAllInheritance(bindings);
    expect(result.valid).toBe(true);
  });

  it('reports missing parent', () => {
    const child = makeBinding('child', { extends: 'nonexistent' });
    const result = validateAllInheritance([child]);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('nonexistent');
  });

  it('validates all inheritance relationships', () => {
    const parent = makeBinding('base', { minimum: 85 });
    const validChild = makeBinding('good-child', { extends: 'base', minimum: 90 });
    const invalidChild = makeBinding('bad-child', { extends: 'base', minimum: 70 });
    const result = validateAllInheritance([parent, validChild, invalidChild]);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('70');
  });
});
