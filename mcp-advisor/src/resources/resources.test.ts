import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import type { ServerDeps } from '../types.js';

/**
 * Resource handlers are thin wrappers around store calls.
 * We test the data extraction logic directly rather than through MCP transport.
 */

function createDeps(): ServerDeps {
  const db = new Database(':memory:');
  const store = StateStore.open(db);
  return {
    store,
    costTracker: new CostTracker(store),
    sessions: new SessionManager(),
    repoPath: '/test/repo',
  };
}

describe('Resource data extraction', () => {
  let deps: ServerDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  describe('codebase-profile', () => {
    it('returns empty when no profile exists', () => {
      const profile = deps.store.getLatestComplexityProfile(deps.repoPath);
      expect(profile).toBeUndefined();
    });

    it('returns profile when it exists', () => {
      deps.store.saveComplexityProfile({
        repoPath: '/test/repo',
        score: 6,
        filesCount: 50,
        modulesCount: 3,
        dependencyCount: 10,
      });
      const profile = deps.store.getLatestComplexityProfile(deps.repoPath);
      expect(profile).toBeDefined();
      expect(profile!.score).toBe(6);
      expect(JSON.stringify(profile)).toBeTruthy();
    });
  });

  describe('conventions', () => {
    it('returns empty array when no conventions', () => {
      const conventions = deps.store.getConventions();
      expect(conventions).toEqual([]);
      expect(JSON.stringify(conventions)).toBe('[]');
    });

    it('returns saved conventions as valid JSON', () => {
      deps.store.saveConvention({ category: 'naming', pattern: 'camelCase' });
      const conventions = deps.store.getConventions();
      expect(conventions.length).toBe(1);
      const json = JSON.parse(JSON.stringify(conventions));
      expect(json[0].category).toBe('naming');
    });
  });

  describe('hotspots', () => {
    it('returns empty array when no hotspots', () => {
      const hotspots = deps.store.getHotspots(deps.repoPath, 20);
      expect(hotspots).toEqual([]);
    });

    it('returns saved hotspots', () => {
      deps.store.saveHotspot({
        repoPath: '/test/repo',
        filePath: 'src/hot.ts',
        churnRate: 0.9,
        complexity: 8,
      });
      const hotspots = deps.store.getHotspots(deps.repoPath, 20);
      expect(hotspots.length).toBe(1);
      expect(JSON.parse(JSON.stringify(hotspots))[0].filePath).toBe('src/hot.ts');
    });
  });

  describe('my-tasks', () => {
    it('returns empty array when no pipeline runs', () => {
      const runs = deps.store.getPipelineRuns(undefined, 50);
      expect(runs).toEqual([]);
    });

    it('returns pipeline runs as valid JSON', () => {
      deps.store.savePipelineRun({
        runId: 'run-1',
        issueNumber: 10,
        pipelineType: 'execute',
        status: 'completed',
      });
      const runs = deps.store.getPipelineRuns(undefined, 50);
      expect(runs.length).toBe(1);
      expect(JSON.parse(JSON.stringify(runs))[0].runId).toBe('run-1');
    });
  });

  describe('budget', () => {
    it('returns budget status with zero spend', () => {
      const status = deps.costTracker.getBudgetStatus();
      expect(status.spentUsd).toBe(0);
      expect(status.overBudget).toBe(false);
      expect(JSON.stringify(status)).toBeTruthy();
    });

    it('reflects recorded costs', () => {
      deps.costTracker.recordCost({
        runId: 'r1',
        agentName: 'alice',
        pipelineType: 'interactive',
        model: 'claude-opus-4-6',
        inputTokens: 10000,
        outputTokens: 5000,
      });
      const status = deps.costTracker.getBudgetStatus();
      expect(status.spentUsd).toBeGreaterThan(0);
    });
  });

  describe('history', () => {
    it('returns empty array when no episodic records', () => {
      const records = deps.store.getEpisodicRecords(undefined, 10);
      expect(records).toEqual([]);
    });

    it('returns episodic records', () => {
      deps.store.saveEpisodicRecord({
        issueNumber: 5,
        pipelineType: 'interactive',
        outcome: 'completed',
        agentName: 'test-dev',
      });
      const records = deps.store.getEpisodicRecords(undefined, 10);
      expect(records.length).toBe(1);
      expect(JSON.parse(JSON.stringify(records))[0].pipelineType).toBe('interactive');
    });
  });
});
