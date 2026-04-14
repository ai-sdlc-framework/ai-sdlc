/**
 * Figma Variables DesignTokenProvider adapter.
 *
 * Scoped exclusively to token extraction (RFC-0006 §9.5 boundary).
 * No design file reading or Figma Make integration — those belong to RFC-0007.
 */

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
} from '../tokens-studio/dtcg-parser.js';
import { figmaVariablesToDtcg, type FigmaVariablesResponse } from './figma-to-dtcg.js';

/** Injectable HTTP client for Figma API calls (testable). */
export interface FigmaHttpClient {
  get(url: string, headers: Record<string, string>): Promise<{ status: number; data: unknown }>;
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; data: unknown }>;
}

export interface FigmaVariablesConfig {
  /** Figma file key. */
  fileKey: string;
  /** Figma API personal access token. */
  apiToken: string;
  /** Optional mode name to extract (defaults to first mode). */
  mode?: string;
  /** Polling interval in ms for change detection. */
  pollIntervalMs?: number;
  /** Injectable HTTP client (defaults to fetch-based). */
  httpClient?: FigmaHttpClient;
}

const FIGMA_API_BASE = 'https://api.figma.com';

function createDefaultHttpClient(): FigmaHttpClient {
  return {
    async get(url, headers) {
      const res = await fetch(url, { headers });
      return { status: res.status, data: await res.json() };
    },
    async post(url, body, headers) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    },
  };
}

export function createFigmaVariablesProvider(config: FigmaVariablesConfig): DesignTokenProvider {
  const { fileKey, apiToken, mode } = config;
  const http = config.httpClient ?? createDefaultHttpClient();
  const authHeaders = { 'X-Figma-Token': apiToken };
  const changeListeners: Array<(diff: TokenDiff) => void> = [];
  const deletionListeners: Array<(deletions: TokenDeletion[]) => void> = [];
  let lastSnapshot: DesignTokenSet | null = null;

  async function fetchVariables(): Promise<FigmaVariablesResponse> {
    const url = `${FIGMA_API_BASE}/v1/files/${fileKey}/variables/local`;
    const res = await http.get(url, authHeaders);
    return res.data as FigmaVariablesResponse;
  }

  return {
    async getTokens(options) {
      const response = await fetchVariables();
      const tokens = figmaVariablesToDtcg(response, { mode });
      lastSnapshot = tokens;

      if (!options?.categories) return tokens;
      const filtered: DesignTokenSet = {};
      for (const cat of options.categories) {
        if (cat in tokens) filtered[cat] = tokens[cat];
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

    async pushTokens(_tokens, _options) {
      // Figma Variables API push is limited — POST /v1/files/:key/variables
      // This is a best-effort implementation; full push requires Figma Plugin API
      return {
        success: false,
        message:
          'Figma Variables push requires the Figma Plugin API. Use Tokens Studio for bidirectional sync.',
      };
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
      const fromMajor = parseInt(fromVersion.split('.')[0], 10);
      const toMajor = parseInt(toVersion.split('.')[0], 10);
      if (toMajor > fromMajor) {
        return {
          isBreaking: true,
          breakingChanges: [`Major version bump: ${fromVersion} → ${toVersion}`],
        };
      }
      return { isBreaking: false, breakingChanges: [] };
    },

    async getSchemaVersion() {
      // Figma doesn't have a built-in version for variable collections.
      // Return a hash-based version from the current snapshot.
      if (lastSnapshot) {
        const json = JSON.stringify(lastSnapshot);
        let hash = 0;
        for (let i = 0; i < json.length; i++) {
          const chr = json.charCodeAt(i);
          hash = ((hash << 5) - hash + chr) | 0;
        }
        return `0.0.${Math.abs(hash) % 10000}`;
      }
      return '0.0.0';
    },
  };
}

export { figmaVariablesToDtcg, type FigmaVariablesResponse } from './figma-to-dtcg.js';
