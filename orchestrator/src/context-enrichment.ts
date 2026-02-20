/**
 * Context enrichment — finds relevant episodic memory and formats
 * it into a structured prompt section for agent context injection.
 *
 * RFC reference: Phase 2 context enrichment.
 */

import type { StateStore } from './state/store.js';
import type { EpisodicRecord } from './state/types.js';

export interface EpisodeSearchCriteria {
  files?: string[];
  module?: string;
  labels?: string[];
  issueNumber?: number;
  agentName?: string;
}

export interface ScoredEpisode {
  episode: EpisodicRecord;
  relevanceScore: number;
}

/**
 * Find relevant episodes from the state store based on given criteria.
 * Returns episodes sorted by relevance score (highest first).
 */
export function findRelevantEpisodes(
  store: StateStore,
  criteria: EpisodeSearchCriteria,
  limit = 10,
): ScoredEpisode[] {
  // Pull recent episodes (broad search)
  const candidates = store.searchEpisodicRecords({ limit: 200 });

  // Score each candidate
  const scored: ScoredEpisode[] = [];

  for (const ep of candidates) {
    let score = 0;

    // Score by issue number match
    if (criteria.issueNumber && ep.issueNumber === criteria.issueNumber) {
      score += 5;
    }

    // Score by agent name match
    if (criteria.agentName && ep.agentName === criteria.agentName) {
      score += 2;
    }

    // Score by file overlap
    if (criteria.files && criteria.files.length > 0 && ep.metadata) {
      try {
        const parsed = JSON.parse(ep.metadata);
        const epFiles: string[] = parsed.filesChanged ?? parsed.files ?? [];
        const overlap = criteria.files.filter((f) =>
          epFiles.some((ef: string) => ef.includes(f) || f.includes(ef)),
        );
        score += overlap.length * 3;
      } catch {
        // metadata not JSON
      }
    }

    // Score by module match (check metadata or routing strategy)
    if (criteria.module && ep.metadata) {
      if (ep.metadata.includes(criteria.module)) {
        score += 2;
      }
    }

    // Score by labels
    if (criteria.labels && criteria.labels.length > 0 && ep.metadata) {
      for (const label of criteria.labels) {
        if (ep.metadata.includes(label)) {
          score += 1;
        }
      }
    }

    // Bonus for regressions (more important context)
    if (ep.isRegression === 1) {
      score += 2;
    }

    // Bonus for failures (cautionary context)
    if (ep.outcome === 'failure') {
      score += 1;
    }

    // Time decay: reduce score for older episodes
    if (ep.createdAt) {
      const ageMs = Date.now() - new Date(ep.createdAt).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      if (ageDays > 30) score *= 0.5;
      else if (ageDays > 7) score *= 0.8;
    }

    if (score > 0) {
      scored.push({ episode: ep, relevanceScore: score });
    }
  }

  return scored.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
}

/**
 * Format episodic memory entries into a structured prompt section.
 */
export function formatEpisodicContext(episodes: ScoredEpisode[]): string {
  if (episodes.length === 0) {
    return '';
  }

  const lines = ['## Episodic Memory (relevant history)', ''];

  for (const { episode } of episodes.slice(0, 5)) {
    const outcome = episode.outcome === 'success' ? 'SUCCESS' : 'FAILURE';
    const date = episode.createdAt?.split('T')[0] ?? 'unknown';
    const agent = episode.agentName ? ` (${episode.agentName})` : '';
    const regression = episode.isRegression === 1 ? ' [REGRESSION]' : '';

    lines.push(`### ${outcome}${regression} — ${episode.pipelineType}${agent} (${date})`);

    if (episode.errorMessage) {
      lines.push(`Error: ${episode.errorMessage.slice(0, 200)}`);
    }

    if (episode.routingStrategy) {
      lines.push(`Strategy: ${episode.routingStrategy}`);
    }

    if (episode.gatePassCount != null || episode.gateFailCount != null) {
      lines.push(
        `Gates: ${episode.gatePassCount ?? 0} passed, ${episode.gateFailCount ?? 0} failed`,
      );
    }

    if (episode.costUsd != null) {
      lines.push(`Cost: $${episode.costUsd.toFixed(4)}`);
    }

    // Extract files from metadata
    if (episode.metadata) {
      try {
        const parsed = JSON.parse(episode.metadata);
        const files: string[] = parsed.filesChanged ?? parsed.files ?? [];
        if (files.length > 0) {
          lines.push(
            `Files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`,
          );
        }
      } catch {
        // not JSON
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Top-level enrichment: find relevant episodes and format them.
 */
export function enrichAgentContext(store: StateStore, criteria: EpisodeSearchCriteria): string {
  const episodes = findRelevantEpisodes(store, criteria);
  return formatEpisodicContext(episodes);
}
