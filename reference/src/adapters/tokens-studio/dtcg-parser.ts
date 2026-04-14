/**
 * W3C Design Tokens Community Group (DTCG) format parser.
 * Handles token traversal, flattening, diffing, and breaking change detection.
 */

import type {
  DesignToken,
  DesignTokenSet,
  TokenChange,
  TokenDiff,
  TokenDeletion,
} from '../interfaces.js';

/**
 * Check if a value is a leaf token (has $type and $value).
 */
export function isDesignToken(value: unknown): value is DesignToken {
  return typeof value === 'object' && value !== null && '$type' in value && '$value' in value;
}

/**
 * Flatten a nested DesignTokenSet into a Map of dotted paths to tokens.
 */
export function flattenTokens(tokens: DesignTokenSet, prefix = ''): Map<string, DesignToken> {
  const result = new Map<string, DesignToken>();
  for (const [key, value] of Object.entries(tokens)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isDesignToken(value)) {
      result.set(path, value);
    } else if (typeof value === 'object' && value !== null) {
      const nested = flattenTokens(value as DesignTokenSet, path);
      for (const [p, v] of nested) result.set(p, v);
    }
  }
  return result;
}

/**
 * Diff two token snapshots and produce a structured TokenDiff.
 */
export function diffTokenSets(baseline: DesignTokenSet, current: DesignTokenSet): TokenDiff {
  const baseFlat = flattenTokens(baseline);
  const currFlat = flattenTokens(current);
  const changes: TokenChange[] = [];

  for (const [path, token] of currFlat) {
    const baseToken = baseFlat.get(path);
    if (!baseToken) {
      changes.push({ path, type: 'added', newValue: token });
    } else if (JSON.stringify(baseToken) !== JSON.stringify(token)) {
      changes.push({ path, type: 'modified', oldValue: baseToken, newValue: token });
    }
  }

  for (const [path, token] of baseFlat) {
    if (!currFlat.has(path)) {
      changes.push({ path, type: 'removed', oldValue: token });
    }
  }

  return {
    changes,
    added: changes.filter((c) => c.type === 'added').length,
    modified: changes.filter((c) => c.type === 'modified').length,
    removed: changes.filter((c) => c.type === 'removed').length,
  };
}

/**
 * Detect deleted tokens between two snapshots.
 */
export function detectTokenDeletions(
  baseline: DesignTokenSet,
  current: DesignTokenSet,
  componentRefs: Map<string, string[]> = new Map(),
  aliasMap: Map<string, string[]> = new Map(),
): TokenDeletion[] {
  const baseFlat = flattenTokens(baseline);
  const currFlat = flattenTokens(current);
  const deletions: TokenDeletion[] = [];

  for (const [path, token] of baseFlat) {
    if (!currFlat.has(path)) {
      const scope = inferTokenScope(path);
      deletions.push({
        path,
        tokenType: token.$type,
        lastValue: token,
        scope,
        referencedBy: componentRefs.get(path) ?? [],
        aliasedBy: aliasMap.get(path) ?? [],
      });
    }
  }

  return deletions;
}

/**
 * Infer token scope from its path prefix.
 */
function inferTokenScope(path: string): 'primitive' | 'semantic' | 'component' {
  const first = path.split('.')[0];
  if (first === 'component' || first === 'comp') return 'component';
  if (first === 'primitive' || first === 'base' || first === 'global') return 'primitive';
  return 'semantic';
}

/**
 * Detect whether a version change is breaking.
 * Breaking = any token removal, rename, type change, or alias restructuring.
 * Value-only changes are non-breaking.
 */
export function detectBreakingChanges(
  baseline: DesignTokenSet,
  current: DesignTokenSet,
): { isBreaking: boolean; breakingChanges: string[] } {
  const diff = diffTokenSets(baseline, current);
  const breakingChanges: string[] = [];

  for (const change of diff.changes) {
    if (change.type === 'removed') {
      breakingChanges.push(`Removed: ${change.path}`);
    } else if (change.type === 'modified' && change.oldValue && change.newValue) {
      // Type change is breaking
      if (change.oldValue.$type !== change.newValue.$type) {
        breakingChanges.push(
          `Type changed: ${change.path} (${change.oldValue.$type} → ${change.newValue.$type})`,
        );
      }
      // Alias restructuring: $value was a reference and changed structure
      if (
        typeof change.oldValue.$value === 'string' &&
        change.oldValue.$value.startsWith('{') &&
        typeof change.newValue.$value === 'string' &&
        change.newValue.$value.startsWith('{') &&
        change.oldValue.$value !== change.newValue.$value
      ) {
        breakingChanges.push(
          `Alias restructured: ${change.path} (${change.oldValue.$value} → ${change.newValue.$value})`,
        );
      }
    }
  }

  return { isBreaking: breakingChanges.length > 0, breakingChanges };
}

/**
 * Build an alias map: for each token path, which other tokens alias it.
 */
export function buildAliasMap(tokens: DesignTokenSet): Map<string, string[]> {
  const flat = flattenTokens(tokens);
  const aliases = new Map<string, string[]>();

  for (const [path, token] of flat) {
    if (
      typeof token.$value === 'string' &&
      token.$value.startsWith('{') &&
      token.$value.endsWith('}')
    ) {
      const target = token.$value.slice(1, -1);
      const existing = aliases.get(target) ?? [];
      existing.push(path);
      aliases.set(target, existing);
    }
  }

  return aliases;
}

/**
 * Parse a JSON string as a DesignTokenSet.
 */
export function parseTokenJson(json: string): DesignTokenSet {
  return JSON.parse(json) as DesignTokenSet;
}
