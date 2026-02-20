import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from './state/store.js';
import {
  createEnhancedEpisodicMemory,
  detectRegressions,
  extractEpisodicPatterns,
} from './episodic-enhanced.js';

describe('episodic-enhanced', () => {
  let store: StateStore;

  beforeEach(() => {
    const db = new Database(':memory:');
    store = StateStore.open(db);
  });

  describe('createEnhancedEpisodicMemory', () => {
    it('records a successful episode', () => {
      const mem = createEnhancedEpisodicMemory(store);
      const { id, regression } = mem.record({
        pipelineType: 'execute',
        outcome: 'success',
        agentName: 'code-agent',
        complexityScore: 5,
        routingStrategy: 'ai-with-review',
        costUsd: 0.15,
      });
      expect(id).toBeGreaterThan(0);
      expect(regression.isRegression).toBe(false);
    });

    it('records a failure episode and detects non-regression', () => {
      const mem = createEnhancedEpisodicMemory(store);
      const { regression } = mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'TypeScript compilation error',
        agentName: 'code-agent',
      });
      // First failure — no previous to compare against
      expect(regression.isRegression).toBe(false);
    });

    it('detects regression when same error occurs again', () => {
      const mem = createEnhancedEpisodicMemory(store);

      // First failure
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'Cannot read properties of undefined reading foo',
        agentName: 'code-agent',
      });

      // Same error again — regression
      const { regression } = mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'Cannot read properties of undefined reading foo',
        agentName: 'code-agent',
      });
      expect(regression.isRegression).toBe(true);
      expect(regression.relatedEpisodeIds.length).toBeGreaterThan(0);
    });

    it('detects regression via overlapping files', () => {
      const mem = createEnhancedEpisodicMemory(store);

      // First failure with file metadata
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'test failed',
        metadata: JSON.stringify({ filesChanged: ['src/api.ts', 'src/db.ts'] }),
      });

      // Second failure with overlapping files and different error
      const { regression } = mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'completely different error',
        metadata: JSON.stringify({ filesChanged: ['src/api.ts', 'src/util.ts'] }),
      });
      expect(regression.isRegression).toBe(true);
      expect(regression.reason).toContain('src/api.ts');
    });

    it('getRecent returns recent episodes', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success' });
      mem.record({ pipelineType: 'fix-ci', outcome: 'failure' });

      const recent = mem.getRecent(10);
      expect(recent).toHaveLength(2);
    });

    it('search filters by outcome', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success', agentName: 'agent-a' });
      mem.record({ pipelineType: 'execute', outcome: 'failure', agentName: 'agent-a' });
      mem.record({ pipelineType: 'execute', outcome: 'success', agentName: 'agent-b' });

      const failures = mem.search({ outcome: 'failure' });
      expect(failures).toHaveLength(1);
      expect(failures[0].agentName).toBe('agent-a');
    });

    it('search filters by agentName', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success', agentName: 'agent-a' });
      mem.record({ pipelineType: 'execute', outcome: 'success', agentName: 'agent-b' });

      const results = mem.search({ agentName: 'agent-a' });
      expect(results).toHaveLength(1);
      expect(results[0].agentName).toBe('agent-a');
    });

    it('summarize returns meaningful summary', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success', durationMs: 1000, costUsd: 0.1 });
      mem.record({ pipelineType: 'execute', outcome: 'success', durationMs: 2000, costUsd: 0.2 });
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        durationMs: 500,
        costUsd: 0.05,
        errorMessage: 'test failed',
      });

      const summary = mem.summarize();
      expect(summary.totalEpisodes).toBe(3);
      expect(summary.successRate).toBeCloseTo(2 / 3, 2);
      expect(summary.avgDurationMs).toBeCloseTo(1166.67, 0);
      expect(summary.avgCostUsd).toBeCloseTo(0.1167, 2);
    });

    it('summarize handles empty state', () => {
      const mem = createEnhancedEpisodicMemory(store);
      const summary = mem.summarize();
      expect(summary.totalEpisodes).toBe(0);
      expect(summary.successRate).toBe(0);
    });
  });

  describe('detectRegressions', () => {
    it('returns no regression for successful outcomes', () => {
      const result = detectRegressions(store, {
        pipelineType: 'execute',
        outcome: 'success',
      });
      expect(result.isRegression).toBe(false);
      expect(result.relatedEpisodeIds).toHaveLength(0);
    });

    it('returns no regression for first-ever failure', () => {
      const result = detectRegressions(store, {
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'Some new error',
      });
      expect(result.isRegression).toBe(false);
    });
  });

  describe('extractEpisodicPatterns', () => {
    it('groups failures by error pattern', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'lint error: no-unused-vars',
      });
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'lint error: no-unused-vars',
      });
      mem.record({ pipelineType: 'execute', outcome: 'failure', errorMessage: 'test timeout' });

      const patterns = extractEpisodicPatterns(store);
      expect(patterns.length).toBeGreaterThanOrEqual(2);
      expect(patterns[0].count).toBe(2);
      expect(patterns[0].pattern).toContain('lint error');
    });

    it('returns empty array when no failures', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({ pipelineType: 'execute', outcome: 'success' });

      const patterns = extractEpisodicPatterns(store);
      expect(patterns).toHaveLength(0);
    });

    it('extracts affected files from metadata', () => {
      const mem = createEnhancedEpisodicMemory(store);
      mem.record({
        pipelineType: 'execute',
        outcome: 'failure',
        errorMessage: 'build failed',
        metadata: JSON.stringify({ filesChanged: ['src/app.ts'] }),
      });

      const patterns = extractEpisodicPatterns(store);
      expect(patterns[0].affectedFiles).toContain('src/app.ts');
    });
  });
});
