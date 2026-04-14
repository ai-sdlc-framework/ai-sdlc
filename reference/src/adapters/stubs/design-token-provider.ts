/**
 * Stub DesignTokenProvider adapter for testing.
 * In-memory token storage with preloadable data and event simulation.
 */

import type {
  DesignTokenProvider,
  DesignTokenSet,
  TokenDiff,
  TokenDeletion,
} from '../interfaces.js';

export interface StubDesignTokenProviderConfig {
  tokens?: DesignTokenSet;
  schemaVersion?: string;
}

export interface StubDesignTokenProviderAdapter extends DesignTokenProvider {
  /** Get the number of push operations performed. */
  getPushCount(): number;
  /** Get the stored tokens. */
  getStoredTokens(): DesignTokenSet;
  /** Simulate a token change event. */
  simulateChange(diff: TokenDiff): void;
  /** Simulate a token deletion event. */
  simulateDeletion(deletions: TokenDeletion[]): void;
}

function flattenTokenPaths(
  tokens: DesignTokenSet,
  prefix = '',
): Map<string, { $type: string; $value: unknown }> {
  const result = new Map<string, { $type: string; $value: unknown }>();
  for (const [key, value] of Object.entries(tokens)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if ('$type' in value && '$value' in value) {
      result.set(path, value as { $type: string; $value: unknown });
    } else {
      const nested = flattenTokenPaths(value as DesignTokenSet, path);
      for (const [p, v] of nested) result.set(p, v);
    }
  }
  return result;
}

export function createStubDesignTokenProvider(
  config: StubDesignTokenProviderConfig = {},
): StubDesignTokenProviderAdapter {
  let tokens: DesignTokenSet = config.tokens ?? {};
  const schemaVersion = config.schemaVersion ?? '1.0.0';
  let pushCount = 0;
  const changeListeners: Array<(diff: TokenDiff) => void> = [];
  const deletionListeners: Array<(deletions: TokenDeletion[]) => void> = [];

  return {
    async getTokens(options) {
      if (!options?.categories) return { ...tokens };
      const filtered: DesignTokenSet = {};
      for (const cat of options.categories) {
        if (cat in tokens) filtered[cat] = tokens[cat];
      }
      return filtered;
    },

    async diffTokens(baseline, current) {
      const baseFlat = flattenTokenPaths(baseline);
      const currFlat = flattenTokenPaths(current);
      const changes: TokenDiff['changes'] = [];

      for (const [path, val] of currFlat) {
        if (!baseFlat.has(path)) {
          changes.push({ path, type: 'added', newValue: val as never });
        } else if (JSON.stringify(baseFlat.get(path)) !== JSON.stringify(val)) {
          changes.push({
            path,
            type: 'modified',
            oldValue: baseFlat.get(path) as never,
            newValue: val as never,
          });
        }
      }
      for (const [path, val] of baseFlat) {
        if (!currFlat.has(path)) {
          changes.push({ path, type: 'removed', oldValue: val as never });
        }
      }

      return {
        changes,
        added: changes.filter((c) => c.type === 'added').length,
        modified: changes.filter((c) => c.type === 'modified').length,
        removed: changes.filter((c) => c.type === 'removed').length,
      };
    },

    async detectDeletions(baseline, current) {
      const baseFlat = flattenTokenPaths(baseline);
      const currFlat = flattenTokenPaths(current);
      const deletions: TokenDeletion[] = [];

      for (const [path, val] of baseFlat) {
        if (!currFlat.has(path)) {
          deletions.push({
            path,
            tokenType: val.$type,
            lastValue: val as never,
            scope: 'semantic',
            referencedBy: [],
            aliasedBy: [],
          });
        }
      }
      return deletions;
    },

    async pushTokens(newTokens, options) {
      tokens = { ...tokens, ...newTokens };
      pushCount++;
      return {
        success: true,
        commitSha: `stub-${pushCount}`,
        message: options?.message ?? 'Stub push',
      };
    },

    onTokensChanged(callback) {
      changeListeners.push(callback);
      return () => {
        const idx = changeListeners.indexOf(callback);
        if (idx >= 0) changeListeners.splice(idx, 1);
      };
    },

    onTokensDeleted(callback) {
      deletionListeners.push(callback);
      return () => {
        const idx = deletionListeners.indexOf(callback);
        if (idx >= 0) deletionListeners.splice(idx, 1);
      };
    },

    async detectBreakingChange(_fromVersion, _toVersion) {
      // Stub: compare major versions
      const fromMajor = parseInt(_fromVersion.split('.')[0], 10);
      const toMajor = parseInt(_toVersion.split('.')[0], 10);
      const isBreaking = toMajor > fromMajor;
      return {
        isBreaking,
        breakingChanges: isBreaking ? [`Major version bump: ${_fromVersion} → ${_toVersion}`] : [],
      };
    },

    async getSchemaVersion() {
      return schemaVersion;
    },

    // Test helpers
    getPushCount() {
      return pushCount;
    },

    getStoredTokens() {
      return { ...tokens };
    },

    simulateChange(diff) {
      for (const listener of changeListeners) listener(diff);
    },

    simulateDeletion(deletions) {
      for (const listener of deletionListeners) listener(deletions);
    },
  };
}
