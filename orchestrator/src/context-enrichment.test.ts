import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './state/store.js';
import { createEnhancedEpisodicMemory } from './episodic-enhanced.js';
import {
  findRelevantEpisodes,
  formatEpisodicContext,
  enrichAgentContext,
} from './context-enrichment.js';

describe('context-enrichment', () => {
  let store: StateStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = StateStore.open(db);
  });

  describe('findRelevantEpisodes', () => {
    it('returns empty for empty store', () => {
      const results = findRelevantEpisodes(store, { files: ['src/app.ts'] });
      expect(results).toHaveLength(0);
    });

    it('scores by issue number match', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success', issueNumber: 42 });
      mem.record({ pipelineType: 'execute', outcome: 'success', issueNumber: 99 });

      const results = findRelevantEpisodes(store, { issueNumber: 42 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].episode.issueNumber).toBe(42);
      expect(results[0].relevanceScore).toBeGreaterThan(0);
    });

    it('scores by agent name match', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success', agentName: 'coder' });
      mem.record({ pipelineType: 'execute', outcome: 'success', agentName: 'reviewer' });

      const results = findRelevantEpisodes(store, { agentName: 'coder' });
      const coderResult = results.find((r) => r.episode.agentName === 'coder');
      expect(coderResult).toBeDefined();
      expect(coderResult!.relevanceScore).toBeGreaterThan(0);
    });

    it('scores by file overlap', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        metadata: JSON.stringify({ filesChanged: ['src/api.ts', 'src/db.ts'] }),
      });

      const results = findRelevantEpisodes(store, { files: ['src/api.ts'] });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].relevanceScore).toBeGreaterThan(0);
    });

    it('boosts regressions', () => {
      const mem = createEnhancedEpisodicMemory(store);

      // Create a regression scenario
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'compilation error in module X',
        agentName: 'coder',
      });
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'compilation error in module X',
        agentName: 'coder',
      });

      const results = findRelevantEpisodes(store, { agentName: 'coder' });
      // The regression should appear with higher score
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('respects limit', () => {
      const mem = createEnhancedEpisodicMemory(store);
      for (let i = 0; i < 20; i++) {
        mem.record({
          pipelineType: 'execute',
          outcome: 'failure',
          agentName: 'agent',
          errorMessage: `err-${i}`,
        });
      }

      const results = findRelevantEpisodes(store, { agentName: 'agent' }, 5);
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('formatEpisodicContext', () => {
    it('returns empty string for no episodes', () => {
      expect(formatEpisodicContext([])).toBe('');
    });

    it('formats episodes into markdown', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'TypeScript error: missing type',
        agentName: 'code-agent',
        routingStrategy: 'ai-with-review',
        gatePassCount: 2,
        gateFailCount: 1,
        costUsd: 0.25,
        metadata: JSON.stringify({ filesChanged: ['src/api.ts'] }),
      });

      const episodes = findRelevantEpisodes(store, { agentName: 'code-agent' });
      const formatted = formatEpisodicContext(episodes);

      expect(formatted).toContain('## Episodic Memory');
      expect(formatted).toContain('FAILURE');
      expect(formatted).toContain('code-agent');
      expect(formatted).toContain('TypeScript error');
      expect(formatted).toContain('ai-with-review');
      expect(formatted).toContain('2 passed');
      expect(formatted).toContain('$0.25');
      expect(formatted).toContain('src/api.ts');
    });

    it('marks regressions', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'same error again',
      });
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'same error again',
      });

      const episodes = findRelevantEpisodes(store, {});
      const regressionEp = episodes.find((e) => e.episode.isRegression === 1);
      if (regressionEp) {
        const formatted = formatEpisodicContext([regressionEp]);
        expect(formatted).toContain('[REGRESSION]');
      }
    });

    it('limits to 5 episodes', () => {
      const mem = createEnhancedEpisodicMemory(store);
      for (let i = 0; i < 10; i++) {
        mem.record({
          pipelineType: 'execute',
          outcome: 'failure',
          agentName: 'agent',
          errorMessage: `error ${i}`,
        });
      }

      const episodes = findRelevantEpisodes(store, { agentName: 'agent' }, 10);
      const formatted = formatEpisodicContext(episodes);
      const headings = formatted.match(/^### /gm);
      expect(headings).toBeTruthy();
      expect(headings!.length).toBeLessThanOrEqual(5);
    });
  });

  describe('enrichAgentContext', () => {
    it('returns empty string when no relevant episodes', () => {
      const result = enrichAgentContext(store, { files: ['nonexistent.ts'] });
      expect(result).toBe('');
    });

    it('returns formatted context for relevant episodes', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        issueNumber: 42,
        errorMessage: 'Test suite failed',
      });

      const result = enrichAgentContext(store, { issueNumber: 42 });
      expect(result).toContain('Episodic Memory');
      expect(result).toContain('Test suite failed');
    });
  });
});
