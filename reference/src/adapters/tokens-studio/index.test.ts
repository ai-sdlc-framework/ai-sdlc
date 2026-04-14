import { describe, it, expect, afterEach } from 'vitest';
import {
  flattenTokens,
  diffTokenSets,
  detectTokenDeletions,
  detectBreakingChanges,
  buildAliasMap,
  isDesignToken,
  parseTokenJson,
} from './dtcg-parser.js';
import { createTokensStudioProvider } from './index.js';
import type { DesignTokenSet } from '../interfaces.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

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

// ── createTokensStudioProvider ──────────────────────────────────────

describe('createTokensStudioProvider', () => {
  let tmpDir: string;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'tokens-studio-'));

    // Initialize a git repo
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });

    // Create token directory with fixture files
    const tokenDir = join(tmpDir, 'tokens');
    mkdirSync(tokenDir, { recursive: true });

    // Write fixture token files
    writeFileSync(
      join(tokenDir, 'color.json'),
      JSON.stringify({
        color: {
          primary: { $type: 'color', $value: '#3B82F6', $description: 'Primary brand color' },
          secondary: { $type: 'color', $value: '#10B981' },
        },
      }),
    );

    writeFileSync(
      join(tokenDir, 'spacing.json'),
      JSON.stringify({
        spacing: {
          sm: { $type: 'dimension', $value: '0.5rem' },
          md: { $type: 'dimension', $value: '1rem' },
        },
      }),
    );

    // Write a package.json with version
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ version: '2.1.0' }));

    // Commit everything so git operations work
    execSync('git add -A', { cwd: tmpDir });
    execSync('git commit -m "initial"', { cwd: tmpDir });
  }

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('getTokens returns all tokens from JSON files', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const tokens = await provider.getTokens();

    expect(tokens).toHaveProperty('color');
    expect(tokens).toHaveProperty('spacing');
    const color = tokens.color as Record<string, unknown>;
    const primary = color.primary as { $type: string; $value: string };
    expect(primary.$type).toBe('color');
    expect(primary.$value).toBe('#3B82F6');
  });

  it('getTokens filters by categories', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const tokens = await provider.getTokens({ categories: ['color'] });

    expect(tokens).toHaveProperty('color');
    expect(tokens).not.toHaveProperty('spacing');
  });

  it('getTokens returns empty when category not found', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const tokens = await provider.getTokens({ categories: ['nonexistent'] });

    expect(Object.keys(tokens)).toHaveLength(0);
  });

  it('getTokens returns empty when token dir does not exist', async () => {
    setup();
    const provider = createTokensStudioProvider({
      repoPath: tmpDir,
      tokenPath: 'nonexistent',
    });
    const tokens = await provider.getTokens();
    expect(Object.keys(tokens)).toHaveLength(0);
  });

  it('getTokens skips malformed JSON files', async () => {
    setup();
    // Write an invalid JSON file
    writeFileSync(join(tmpDir, 'tokens', 'invalid.json'), '{ not valid json');
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    // Should not throw — just skips the invalid file
    const tokens = await provider.getTokens();
    expect(tokens).toHaveProperty('color');
    expect(tokens).toHaveProperty('spacing');
  });

  it('getTokens skips non-JSON files', async () => {
    setup();
    writeFileSync(join(tmpDir, 'tokens', 'readme.txt'), 'not a json file');
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const tokens = await provider.getTokens();
    expect(tokens).toHaveProperty('color');
  });

  it('diffTokens computes diffs', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const baseline: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    };
    const current: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#FF0000' } },
    };
    const diff = await provider.diffTokens(baseline, current);
    expect(diff.modified).toBe(1);
  });

  it('diffTokens returns empty diff for identical sets', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const tokens = await provider.getTokens();
    const diff = await provider.diffTokens(tokens, tokens);
    expect(diff.changes).toHaveLength(0);
  });

  it('detectDeletions finds removed tokens', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const baseline: DesignTokenSet = {
      color: {
        primary: { $type: 'color', $value: '#3B82F6' },
        secondary: { $type: 'color', $value: '#10B981' },
      },
    };
    const current: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    };
    const deletions = await provider.detectDeletions(baseline, current);
    expect(deletions.length).toBeGreaterThan(0);
    expect(deletions[0].path).toBe('color.secondary');
  });

  it('pushTokens writes tokens and commits (success path)', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });

    const newTokens: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#FF0000' } },
    };
    const result = await provider.pushTokens(newTokens, {
      message: 'test: update tokens',
    });

    expect(result.success).toBe(true);
    expect(result.commitSha).toBeDefined();
    expect(result.message).toBe('test: update tokens');

    // Verify file was written
    expect(existsSync(join(tmpDir, 'tokens', 'tokens.json'))).toBe(true);
  });

  it('pushTokens uses default message when none provided', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });

    const result = await provider.pushTokens({});
    expect(result.success).toBe(true);
    expect(result.message).toBe('chore: update design tokens');
  });

  it('pushTokens creates token dir if it does not exist', async () => {
    setup();
    const provider = createTokensStudioProvider({
      repoPath: tmpDir,
      tokenPath: 'new-tokens',
    });

    const result = await provider.pushTokens({
      color: { primary: { $type: 'color', $value: '#000' } },
    });
    expect(result.success).toBe(true);
    expect(existsSync(join(tmpDir, 'new-tokens', 'tokens.json'))).toBe(true);
  });

  it('pushTokens returns error on git failure', async () => {
    // Use a non-git directory to trigger git failure
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    try {
      const tokenDir = join(nonGitDir, 'tokens');
      mkdirSync(tokenDir, { recursive: true });
      const provider = createTokensStudioProvider({ repoPath: nonGitDir });

      const result = await provider.pushTokens({ test: { $type: 'color', $value: '#fff' } });
      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    } finally {
      rmSync(nonGitDir, { recursive: true });
    }
  });

  it('onTokensChanged subscribes and unsubscribes', () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    let called = false;
    const unsub = provider.onTokensChanged(() => {
      called = true;
    });
    expect(typeof unsub).toBe('function');
    unsub();
    expect(called).toBe(false);
  });

  it('onTokensDeleted subscribes and unsubscribes', () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    let called = false;
    const unsub = provider.onTokensDeleted(() => {
      called = true;
    });
    expect(typeof unsub).toBe('function');
    unsub();
    expect(called).toBe(false);
  });

  it('detectBreakingChange returns true for major version bumps', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const result = await provider.detectBreakingChange('1.0.0', '2.0.0');
    expect(result.isBreaking).toBe(true);
    expect(result.breakingChanges.length).toBeGreaterThan(0);
  });

  it('detectBreakingChange returns false for minor/patch bumps', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const result = await provider.detectBreakingChange('1.0.0', '1.1.0');
    expect(result.isBreaking).toBe(false);
    expect(result.breakingChanges).toHaveLength(0);
  });

  it('getSchemaVersion reads version from package.json', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const version = await provider.getSchemaVersion();
    expect(version).toBe('2.1.0');
  });

  it('getSchemaVersion caches the version', async () => {
    setup();
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const v1 = await provider.getSchemaVersion();
    // Update file after first call
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    const v2 = await provider.getSchemaVersion();
    // Should return cached value
    expect(v1).toBe(v2);
    expect(v2).toBe('2.1.0');
  });

  it('getSchemaVersion falls back to version.json in token dir', async () => {
    setup();
    // Remove package.json so it falls through
    rmSync(join(tmpDir, 'package.json'));
    // Write version.json in token dir
    writeFileSync(join(tmpDir, 'tokens', 'version.json'), JSON.stringify({ version: '1.5.0' }));
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const version = await provider.getSchemaVersion();
    expect(version).toBe('1.5.0');
  });

  it('getSchemaVersion returns 0.0.0 when no version files exist', async () => {
    setup();
    rmSync(join(tmpDir, 'package.json'));
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    const version = await provider.getSchemaVersion();
    expect(version).toBe('0.0.0');
  });

  it('getSchemaVersion returns 0.0.0 for malformed package.json', async () => {
    setup();
    writeFileSync(join(tmpDir, 'package.json'), '{ invalid json');
    const provider = createTokensStudioProvider({ repoPath: tmpDir });
    // Falls through to version.json or default
    const version = await provider.getSchemaVersion();
    expect(version).toBe('0.0.0');
  });
});
