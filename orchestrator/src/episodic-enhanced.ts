/**
 * Enhanced episodic memory — records enriched pipeline history to SQLite,
 * detects regressions, and extracts failure patterns.
 *
 * RFC reference: Phase 2 episodic memory enrichment.
 */

import type { StateStore } from './state/store.js';
import type { EpisodicRecord } from './state/types.js';

export interface EnhancedEpisodicInput {
  issueNumber?: number;
  prNumber?: number;
  pipelineType: string;
  outcome: 'success' | 'failure' | 'partial';
  durationMs?: number;
  filesChanged?: number;
  errorMessage?: string;
  metadata?: string;
  agentName?: string;
  complexityScore?: number;
  routingStrategy?: string;
  gatePassCount?: number;
  gateFailCount?: number;
  costUsd?: number;
}

export interface RegressionInfo {
  isRegression: boolean;
  relatedEpisodeIds: number[];
  reason?: string;
}

export interface FailurePattern {
  pattern: string;
  count: number;
  lastSeen: string;
  affectedFiles: string[];
  agentName?: string;
}

export interface EpisodicSummary {
  totalEpisodes: number;
  successRate: number;
  avgDurationMs: number;
  avgCostUsd: number;
  regressionCount: number;
  topFailurePatterns: FailurePattern[];
}

/**
 * Create an enhanced episodic memory manager backed by the state store.
 */
export function createEnhancedEpisodicMemory(store: StateStore) {
  return {
    /**
     * Record an enhanced episodic memory entry, auto-detecting regressions.
     */
    record(input: EnhancedEpisodicInput): { id: number; regression: RegressionInfo } {
      const regression = detectRegressions(store, input);

      const id = store.saveEpisodicRecord({
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        pipelineType: input.pipelineType,
        outcome: input.outcome,
        durationMs: input.durationMs,
        filesChanged: input.filesChanged,
        errorMessage: input.errorMessage,
        metadata: input.metadata,
        agentName: input.agentName,
        complexityScore: input.complexityScore,
        routingStrategy: input.routingStrategy,
        gatePassCount: input.gatePassCount,
        gateFailCount: input.gateFailCount,
        costUsd: input.costUsd,
        isRegression: regression.isRegression ? 1 : 0,
        relatedEpisodes: regression.relatedEpisodeIds.length > 0
          ? JSON.stringify(regression.relatedEpisodeIds)
          : undefined,
      });

      return { id, regression };
    },

    /**
     * Get recent episodes with optional filtering.
     */
    getRecent(limit = 50): EpisodicRecord[] {
      return store.getEpisodicRecords(undefined, limit);
    },

    /**
     * Search episodes by criteria.
     */
    search(opts: {
      agentName?: string;
      outcome?: string;
      since?: string;
      files?: string;
      limit?: number;
    }): EpisodicRecord[] {
      return store.searchEpisodicRecords(opts);
    },

    /**
     * Extract failure patterns from recent history.
     */
    extractPatterns(limit = 100): FailurePattern[] {
      return extractEpisodicPatterns(store, limit);
    },

    /**
     * Get a summary of episodic history.
     */
    summarize(since?: string): EpisodicSummary {
      return summarizeEpisodes(store, since);
    },
  };
}

/**
 * Detect if a new record represents a regression:
 * Same files failed before with the same error pattern within 7 days.
 */
export function detectRegressions(
  store: StateStore,
  input: EnhancedEpisodicInput,
): RegressionInfo {
  if (input.outcome === 'success') {
    return { isRegression: false, relatedEpisodeIds: [] };
  }

  // Look for failures in the last 7 days with overlapping metadata (files)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentFailures = store.searchEpisodicRecords({
    outcome: 'failure',
    since: sevenDaysAgo,
    limit: 200,
  });

  const relatedIds: number[] = [];
  let reason: string | undefined;

  for (const episode of recentFailures) {
    // Check for overlapping error patterns
    if (input.errorMessage && episode.errorMessage) {
      const similarity = computeErrorSimilarity(input.errorMessage, episode.errorMessage);
      if (similarity > 0.5) {
        if (episode.id) relatedIds.push(episode.id);
        reason = `Similar error pattern to episode #${episode.id}: ${episode.errorMessage?.slice(0, 80)}`;
      }
    }

    // Check for same files (via metadata)
    if (input.metadata && episode.metadata) {
      try {
        const inputFiles = extractFilesFromMetadata(input.metadata);
        const episodeFiles = extractFilesFromMetadata(episode.metadata);
        const overlap = inputFiles.filter((f) => episodeFiles.includes(f));
        if (overlap.length > 0 && episode.id && !relatedIds.includes(episode.id)) {
          relatedIds.push(episode.id);
          reason = reason ?? `Same files affected: ${overlap.join(', ')}`;
        }
      } catch {
        // metadata not JSON or doesn't contain files
      }
    }
  }

  return {
    isRegression: relatedIds.length > 0,
    relatedEpisodeIds: relatedIds,
    reason,
  };
}

/**
 * Compute a simple similarity score between two error messages.
 * Uses word-level Jaccard similarity.
 */
function computeErrorSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Extract file paths from JSON metadata.
 */
function extractFilesFromMetadata(metadata: string): string[] {
  try {
    const parsed = JSON.parse(metadata);
    if (Array.isArray(parsed.filesChanged)) return parsed.filesChanged;
    if (Array.isArray(parsed.files)) return parsed.files;
    return [];
  } catch {
    return [];
  }
}

/**
 * Extract failure patterns from recent episodes.
 */
export function extractEpisodicPatterns(store: StateStore, limit = 100): FailurePattern[] {
  const failures = store.searchEpisodicRecords({ outcome: 'failure', limit });
  const patternMap = new Map<string, FailurePattern>();

  for (const ep of failures) {
    const key = ep.errorMessage?.slice(0, 100) ?? 'unknown';
    const existing = patternMap.get(key);
    const files = ep.metadata ? extractFilesFromMetadata(ep.metadata) : [];

    if (existing) {
      existing.count++;
      if (ep.createdAt && ep.createdAt > existing.lastSeen) {
        existing.lastSeen = ep.createdAt;
      }
      for (const f of files) {
        if (!existing.affectedFiles.includes(f)) {
          existing.affectedFiles.push(f);
        }
      }
    } else {
      patternMap.set(key, {
        pattern: key,
        count: 1,
        lastSeen: ep.createdAt ?? new Date().toISOString(),
        affectedFiles: files,
        agentName: ep.agentName,
      });
    }
  }

  return [...patternMap.values()]
    .sort((a, b) => b.count - a.count);
}

/**
 * Summarize episodic history.
 */
function summarizeEpisodes(store: StateStore, since?: string): EpisodicSummary {
  const episodes = store.searchEpisodicRecords({ since, limit: 500 });
  const total = episodes.length;

  if (total === 0) {
    return {
      totalEpisodes: 0,
      successRate: 0,
      avgDurationMs: 0,
      avgCostUsd: 0,
      regressionCount: 0,
      topFailurePatterns: [],
    };
  }

  const successes = episodes.filter((e) => e.outcome === 'success').length;
  const durations = episodes.filter((e) => e.durationMs != null).map((e) => e.durationMs!);
  const costs = episodes.filter((e) => e.costUsd != null).map((e) => e.costUsd!);
  const regressions = episodes.filter((e) => e.isRegression === 1).length;

  const patterns = extractEpisodicPatterns(store);

  return {
    totalEpisodes: total,
    successRate: total > 0 ? successes / total : 0,
    avgDurationMs: durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0,
    avgCostUsd: costs.length > 0
      ? costs.reduce((a, b) => a + b, 0) / costs.length
      : 0,
    regressionCount: regressions,
    topFailurePatterns: patterns.slice(0, 5),
  };
}
