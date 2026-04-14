import { describe, it, expect } from 'vitest';
import {
  flattenTokens,
  diffTokenSets,
  detectTokenDeletions,
  detectBreakingChanges,
  buildAliasMap,
  isDesignToken,
  parseTokenJson,
} from './dtcg-parser.js';
import type { DesignTokenSet } from '../interfaces.js';

const sampleTokens: DesignTokenSet = {
  color: {
    primary: { $type: 'color', $value: '#3B82F6', $description: 'Primary brand color' },
    text: {
      primary: { $type: 'color', $value: '{color.neutral.900}', $description: 'Default text' },
    },
  },
  spacing: {
    sm: { $type: 'dimension', $value: '0.5rem' },
    md: { $type: 'dimension', $value: '1rem' },
    lg: { $type: 'dimension', $value: '1.5rem' },
  },
};

describe('isDesignToken', () => {
  it('returns true for valid tokens', () => {
    expect(isDesignToken({ $type: 'color', $value: '#fff' })).toBe(true);
  });

  it('returns false for group nodes', () => {
    expect(isDesignToken({ primary: { $type: 'color', $value: '#fff' } })).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isDesignToken(null)).toBe(false);
    expect(isDesignToken(undefined)).toBe(false);
  });
});

describe('flattenTokens', () => {
  it('flattens nested tokens into dotted paths', () => {
    const flat = flattenTokens(sampleTokens);
    expect(flat.size).toBe(5);
    expect(flat.has('color.primary')).toBe(true);
    expect(flat.has('color.text.primary')).toBe(true);
    expect(flat.has('spacing.sm')).toBe(true);
    expect(flat.has('spacing.md')).toBe(true);
    expect(flat.has('spacing.lg')).toBe(true);
  });

  it('returns empty map for empty input', () => {
    expect(flattenTokens({}).size).toBe(0);
  });

  it('preserves token values', () => {
    const flat = flattenTokens(sampleTokens);
    expect(flat.get('color.primary')?.$value).toBe('#3B82F6');
    expect(flat.get('color.primary')?.$description).toBe('Primary brand color');
  });
});

describe('diffTokenSets', () => {
  it('detects added tokens', () => {
    const current: DesignTokenSet = {
      ...sampleTokens,
      newGroup: { token: { $type: 'color', $value: '#000' } },
    };
    const diff = diffTokenSets(sampleTokens, current);
    expect(diff.added).toBe(1);
    expect(diff.changes.find((c) => c.type === 'added')?.path).toBe('newGroup.token');
  });

  it('detects modified tokens', () => {
    const current: DesignTokenSet = {
      color: {
        primary: { $type: 'color', $value: '#2563EB', $description: 'Primary brand color' },
        text: {
          primary: { $type: 'color', $value: '{color.neutral.900}', $description: 'Default text' },
        },
      },
      spacing: sampleTokens.spacing as DesignTokenSet,
    };
    const diff = diffTokenSets(sampleTokens, current);
    expect(diff.modified).toBe(1);
    expect(diff.changes.find((c) => c.type === 'modified')?.path).toBe('color.primary');
  });

  it('detects removed tokens', () => {
    const current: DesignTokenSet = {
      color: {
        primary: { $type: 'color', $value: '#3B82F6', $description: 'Primary brand color' },
        text: {
          primary: { $type: 'color', $value: '{color.neutral.900}', $description: 'Default text' },
        },
      },
      spacing: {
        sm: { $type: 'dimension', $value: '0.5rem' },
        md: { $type: 'dimension', $value: '1rem' },
        // lg removed
      },
    };
    const diff = diffTokenSets(sampleTokens, current);
    expect(diff.removed).toBe(1);
    expect(diff.changes.find((c) => c.type === 'removed')?.path).toBe('spacing.lg');
  });

  it('returns empty diff for identical sets', () => {
    const diff = diffTokenSets(sampleTokens, sampleTokens);
    expect(diff.changes).toHaveLength(0);
    expect(diff.added).toBe(0);
    expect(diff.modified).toBe(0);
    expect(diff.removed).toBe(0);
  });
});

describe('detectTokenDeletions', () => {
  it('detects deleted tokens with metadata', () => {
    const current: DesignTokenSet = {
      color: {
        primary: { $type: 'color', $value: '#3B82F6', $description: 'Primary brand color' },
        // text.primary deleted
      },
      spacing: sampleTokens.spacing as DesignTokenSet,
    };
    const deletions = detectTokenDeletions(sampleTokens, current);
    expect(deletions).toHaveLength(1);
    expect(deletions[0].path).toBe('color.text.primary');
    expect(deletions[0].tokenType).toBe('color');
    expect(deletions[0].scope).toBe('semantic');
  });

  it('returns empty array when nothing deleted', () => {
    expect(detectTokenDeletions(sampleTokens, sampleTokens)).toHaveLength(0);
  });
});

describe('detectBreakingChanges', () => {
  it('flags token removal as breaking', () => {
    const current: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    };
    const result = detectBreakingChanges(sampleTokens, current);
    expect(result.isBreaking).toBe(true);
    expect(result.breakingChanges.some((c) => c.includes('Removed'))).toBe(true);
  });

  it('flags type change as breaking', () => {
    const current: DesignTokenSet = {
      ...sampleTokens,
      color: {
        ...(sampleTokens.color as DesignTokenSet),
        primary: { $type: 'dimension', $value: '16px' }, // was 'color'
      },
    };
    const result = detectBreakingChanges(sampleTokens, current);
    expect(result.isBreaking).toBe(true);
    expect(result.breakingChanges.some((c) => c.includes('Type changed'))).toBe(true);
  });

  it('flags alias restructuring as breaking', () => {
    const baseline: DesignTokenSet = {
      semantic: { bg: { $type: 'color', $value: '{color.primary}' } },
    };
    const current: DesignTokenSet = {
      semantic: { bg: { $type: 'color', $value: '{color.secondary}' } },
    };
    const result = detectBreakingChanges(baseline, current);
    expect(result.isBreaking).toBe(true);
    expect(result.breakingChanges.some((c) => c.includes('Alias restructured'))).toBe(true);
  });

  it('reports non-breaking for value-only changes', () => {
    const current: DesignTokenSet = {
      ...sampleTokens,
      color: {
        ...(sampleTokens.color as DesignTokenSet),
        primary: { $type: 'color', $value: '#2563EB', $description: 'Primary brand color' },
      },
    };
    const result = detectBreakingChanges(sampleTokens, current);
    expect(result.isBreaking).toBe(false);
  });
});

describe('buildAliasMap', () => {
  it('maps alias targets to their referencing paths', () => {
    const aliases = buildAliasMap(sampleTokens);
    expect(aliases.has('color.neutral.900')).toBe(true);
    expect(aliases.get('color.neutral.900')).toContain('color.text.primary');
  });

  it('returns empty map when no aliases', () => {
    const noAliases: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#fff' } },
    };
    expect(buildAliasMap(noAliases).size).toBe(0);
  });
});

describe('parseTokenJson', () => {
  it('parses valid JSON', () => {
    const result = parseTokenJson('{"color":{"primary":{"$type":"color","$value":"#fff"}}}');
    expect(result).toHaveProperty('color');
  });
});
