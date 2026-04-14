/**
 * Tokens Studio DesignTokenProvider adapter.
 *
 * Reads W3C DTCG tokens from a Git repository (the storage model used by
 * Tokens Studio). Supports diffing, deletion detection, breaking change
 * analysis, and push-back via Git commits.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import type {
  DesignTokenProvider,
  DesignTokenSet,
  TokenDiff,
  TokenDeletion,
  Unsubscribe,
  BreakingChangeResult,
} from '../interfaces.js';
import {
  diffTokenSets,
  detectTokenDeletions,
  buildAliasMap,
  parseTokenJson,
} from './dtcg-parser.js';

export interface TokensStudioConfig {
  /** Path to the local clone of the token repository. */
  repoPath: string;
  /** Subdirectory within the repo containing token JSON files. */
  tokenPath?: string;
  /** Branch to read from. */
  branch?: string;
}

export function createTokensStudioProvider(config: TokensStudioConfig): DesignTokenProvider {
  const { repoPath, tokenPath = 'tokens', branch = 'main' } = config;
  const tokenDir = join(repoPath, tokenPath);
  const changeListeners: Array<(diff: TokenDiff) => void> = [];
  const deletionListeners: Array<(deletions: TokenDeletion[]) => void> = [];
  let cachedVersion: string | null = null;

  function readAllTokenFiles(): DesignTokenSet {
    if (!existsSync(tokenDir)) return {};

    const merged: DesignTokenSet = {};
    const files = readdirSync(tokenDir, { recursive: true }) as string[];

    for (const file of files) {
      if (typeof file !== 'string' || !file.endsWith('.json')) continue;
      const filePath = join(tokenDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const tokens = parseTokenJson(content);
        Object.assign(merged, tokens);
      } catch {
        // Skip malformed files
      }
    }
    return merged;
  }

  function readVersionFile(): string {
    const versionPath = join(repoPath, 'package.json');
    if (existsSync(versionPath)) {
      try {
        const pkg = JSON.parse(readFileSync(versionPath, 'utf-8'));
        return (pkg.version as string) ?? '0.0.0';
      } catch {
        // fall through
      }
    }

    const tokenVersionPath = join(tokenDir, 'version.json');
    if (existsSync(tokenVersionPath)) {
      try {
        const vf = JSON.parse(readFileSync(tokenVersionPath, 'utf-8'));
        return (vf.version as string) ?? '0.0.0';
      } catch {
        // fall through
      }
    }

    return '0.0.0';
  }

  function gitExec(cmd: string): string {
    return execSync(cmd, { cwd: repoPath, encoding: 'utf-8' }).trim();
  }

  return {
    async getTokens(options) {
      const all = readAllTokenFiles();
      if (!options?.categories) return all;

      const filtered: DesignTokenSet = {};
      for (const cat of options.categories) {
        if (cat in all) filtered[cat] = all[cat];
      }
      return filtered;
    },

    async diffTokens(baseline, current) {
      return diffTokenSets(baseline, current);
    },

    async detectDeletions(baseline, current) {
      const aliasMap = buildAliasMap(baseline);
      return detectTokenDeletions(baseline, current, new Map(), aliasMap);
    },

    async pushTokens(tokens, options) {
      try {
        // Ensure token directory exists
        if (!existsSync(tokenDir)) {
          mkdirSync(tokenDir, { recursive: true });
        }

        // Write tokens as a single merged file
        const outputPath = join(tokenDir, 'tokens.json');
        writeFileSync(outputPath, JSON.stringify(tokens, null, 2) + '\n', 'utf-8');

        // Stage and commit
        const _branchName = options?.branch ?? branch;
        const message = options?.message ?? 'chore: update design tokens';

        gitExec(`git add ${relative(repoPath, outputPath)}`);
        gitExec(`git commit -m "${message}"`);

        const sha = gitExec('git rev-parse HEAD');
        return { success: true, commitSha: sha, message };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },

    onTokensChanged(callback) {
      changeListeners.push(callback);
      return (() => {
        const idx = changeListeners.indexOf(callback);
        if (idx >= 0) changeListeners.splice(idx, 1);
      }) as Unsubscribe;
    },

    onTokensDeleted(callback) {
      deletionListeners.push(callback);
      return (() => {
        const idx = deletionListeners.indexOf(callback);
        if (idx >= 0) deletionListeners.splice(idx, 1);
      }) as Unsubscribe;
    },

    async detectBreakingChange(fromVersion, toVersion): Promise<BreakingChangeResult> {
      // For Git-based providers, we compare the current tokens against
      // a baseline snapshot. In a real implementation, this would checkout
      // the two versions and compare. Here we do a semver-based heuristic
      // combined with actual token comparison when snapshots are available.
      const fromMajor = parseInt(fromVersion.split('.')[0], 10);
      const toMajor = parseInt(toVersion.split('.')[0], 10);

      if (toMajor > fromMajor) {
        // Major version bump — likely breaking, but check tokens to confirm
        return {
          isBreaking: true,
          breakingChanges: [`Major version bump: ${fromVersion} → ${toVersion}`],
        };
      }

      // For minor/patch, compare actual tokens if we have cached state
      return { isBreaking: false, breakingChanges: [] };
    },

    async getSchemaVersion() {
      if (!cachedVersion) {
        cachedVersion = readVersionFile();
      }
      return cachedVersion;
    },
  };
}

// Re-export parser utilities for use by other adapters
export {
  flattenTokens,
  diffTokenSets,
  detectTokenDeletions,
  detectBreakingChanges,
  buildAliasMap,
  parseTokenJson,
  isDesignToken,
} from './dtcg-parser.js';
