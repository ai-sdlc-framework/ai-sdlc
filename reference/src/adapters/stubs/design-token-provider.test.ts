import { describe, it, expect } from 'vitest';
import { createStubDesignTokenProvider } from './design-token-provider.js';
import type { DesignTokenSet, TokenDiff } from '../interfaces.js';

const sampleTokens: DesignTokenSet = {
  color: {
    primary: { $type: 'color', $value: '#3B82F6', $description: 'Primary brand color' },
    secondary: { $type: 'color', $value: '#10B981' },
  },
  spacing: {
    sm: { $type: 'dimension', $value: '0.5rem' },
    md: { $type: 'dimension', $value: '1rem' },
  },
};

describe('createStubDesignTokenProvider', () => {
  it('returns preloaded tokens', async () => {
    const provider = createStubDesignTokenProvider({ tokens: sampleTokens });
    const tokens = await provider.getTokens();
    expect(tokens).toHaveProperty('color');
    expect(tokens).toHaveProperty('spacing');
  });

  it('filters tokens by category', async () => {
    const provider = createStubDesignTokenProvider({ tokens: sampleTokens });
    const tokens = await provider.getTokens({ categories: ['color'] });
    expect(tokens).toHaveProperty('color');
    expect(tokens).not.toHaveProperty('spacing');
  });

  it('diffs two token snapshots', async () => {
    const provider = createStubDesignTokenProvider();
    const baseline: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    };
    const current: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#2563EB' } },
    };
    const diff = await provider.diffTokens(baseline, current);
    expect(diff.modified).toBe(1);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.changes[0].type).toBe('modified');
  });

  it('detects added and removed tokens', async () => {
    const provider = createStubDesignTokenProvider();
    const baseline: DesignTokenSet = {
      old: { $type: 'color', $value: '#000' },
    };
    const current: DesignTokenSet = {
      new: { $type: 'color', $value: '#fff' },
    };
    const diff = await provider.diffTokens(baseline, current);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
  });

  it('detects deletions', async () => {
    const provider = createStubDesignTokenProvider();
    const baseline: DesignTokenSet = {
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    };
    const current: DesignTokenSet = {};
    const deletions = await provider.detectDeletions(baseline, current);
    expect(deletions).toHaveLength(1);
    expect(deletions[0].path).toBe('color.primary');
    expect(deletions[0].tokenType).toBe('color');
  });

  it('pushes tokens and increments count', async () => {
    const provider = createStubDesignTokenProvider();
    expect(provider.getPushCount()).toBe(0);
    const result = await provider.pushTokens(sampleTokens, { message: 'test push' });
    expect(result.success).toBe(true);
    expect(result.commitSha).toBeDefined();
    expect(provider.getPushCount()).toBe(1);
  });

  it('subscribes and unsubscribes to change events', () => {
    const provider = createStubDesignTokenProvider();
    let received: TokenDiff | null = null;
    const unsub = provider.onTokensChanged((diff) => {
      received = diff;
    });

    const fakeDiff: TokenDiff = { changes: [], added: 1, modified: 0, removed: 0 };
    provider.simulateChange(fakeDiff);
    expect(received).toBe(fakeDiff);

    unsub();
    provider.simulateChange({ changes: [], added: 99, modified: 0, removed: 0 });
    expect(received).toBe(fakeDiff); // unchanged after unsubscribe
  });

  it('detects breaking changes by major version', async () => {
    const provider = createStubDesignTokenProvider();
    const breaking = await provider.detectBreakingChange('1.0.0', '2.0.0');
    expect(breaking.isBreaking).toBe(true);
    expect(breaking.breakingChanges.length).toBeGreaterThan(0);

    const nonBreaking = await provider.detectBreakingChange('1.0.0', '1.1.0');
    expect(nonBreaking.isBreaking).toBe(false);
  });

  it('returns configured schema version', async () => {
    const provider = createStubDesignTokenProvider({ schemaVersion: '3.2.1' });
    expect(await provider.getSchemaVersion()).toBe('3.2.1');
  });
});
