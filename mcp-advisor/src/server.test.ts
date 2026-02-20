/**
 * Integration test — full session lifecycle using in-memory store.
 * Tests tools directly via exported handle* functions (no MCP transport needed).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from './session.js';
import { handleSessionStart } from './tools/session-start.js';
import { handleGetContext } from './tools/get-context.js';
import { handleCheckTask } from './tools/check-task.js';
import { handleTrackUsage } from './tools/track-usage.js';
import { handleCheckFile } from './tools/check-file.js';
import { handleSessionEnd } from './tools/session-end.js';
import type { ServerDeps } from './types.js';

// Mock issue-linker for deterministic branch resolution
vi.mock('./issue-linker.js', () => ({
  resolveIssue: vi.fn().mockResolvedValue({ issueNumber: 42, method: 'branch', confidence: 1.0 }),
}));

describe('Full session lifecycle integration', () => {
  let deps: ServerDeps;

  beforeEach(() => {
    const db = new Database(':memory:');
    const store = StateStore.open(db);
    deps = {
      store,
      costTracker: new CostTracker(store),
      sessions: new SessionManager(),
      repoPath: '/test/repo',
    };

    // Seed store with test data
    store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 7,
      filesCount: 120,
      modulesCount: 8,
      dependencyCount: 25,
      architecturalPatterns: JSON.stringify([
        {
          name: 'Modular Monolith',
          confidence: 0.9,
          description: 'Module boundaries',
          evidence: [],
        },
      ]),
      hotspots: JSON.stringify([
        { filePath: 'src/core/engine.ts', churnRate: 0.85, complexity: 9, commitCount: 50 },
      ]),
      conventionsData: JSON.stringify([
        { category: 'naming', pattern: 'camelCase variables', confidence: 0.95, examples: [] },
      ]),
    });

    store.saveConvention({ category: 'naming', pattern: 'camelCase for variables' });
    store.saveConvention({ category: 'testing', pattern: 'co-located test files' });

    store.saveHotspot({
      repoPath: '/test/repo',
      filePath: 'src/core/engine.ts',
      churnRate: 0.85,
      complexity: 9,
    });

    store.savePipelineRun({
      runId: 'run-prev',
      issueNumber: 42,
      pipelineType: 'execute',
      status: 'completed',
      result: 'success',
    });
  });

  it('session_start → get_context → check_task → track_usage ×2 → check_file → session_end', async () => {
    // 1. session_start
    const startResult = await handleSessionStart(deps, {
      developer: 'integration-tester',
      tool: 'claude-code',
    });
    expect(startResult.sessionId).toBeTruthy();
    expect(startResult.linkedIssue).toBe(42);
    expect(startResult.linkMethod).toBe('branch');

    const sessionId = startResult.sessionId;

    // 2. get_context
    const contextResult = handleGetContext(deps, { sessionId });
    expect(contextResult.markdown).toContain('Codebase Context');
    expect(contextResult.markdown).toContain('Modular Monolith');
    expect(contextResult.markdown).toContain('camelCase');

    // 3. check_task
    const taskResult = handleCheckTask(deps, { sessionId });
    expect(taskResult.issueNumber).toBe(42);
    expect(taskResult.pipelineRuns).toBe(1);

    // 4. track_usage ×2
    const usage1 = handleTrackUsage(deps, {
      sessionId,
      model: 'claude-opus-4-6',
      inputTokens: 5000,
      outputTokens: 2000,
    });
    expect(usage1.entryCostUsd).toBeGreaterThan(0);
    expect(usage1.cumulativeInputTokens).toBe(5000);

    const usage2 = handleTrackUsage(deps, {
      sessionId,
      model: 'claude-haiku-4-5-20251001',
      inputTokens: 3000,
      outputTokens: 1000,
    });
    expect(usage2.cumulativeInputTokens).toBe(8000);
    expect(usage2.cumulativeOutputTokens).toBe(3000);
    expect(usage2.cumulativeCostUsd).toBeGreaterThan(usage1.cumulativeCostUsd);

    // 5. check_file — hotspot
    const fileResult = handleCheckFile(deps, { sessionId, filePath: 'src/core/engine.ts' });
    expect(fileResult.isHotspot).toBe(true);
    expect(fileResult.warnings.length).toBeGreaterThan(0);

    // 5b. check_file — normal file
    const normalFile = handleCheckFile(deps, { sessionId, filePath: 'src/utils/helpers.ts' });
    expect(normalFile.isHotspot).toBe(false);
    expect(normalFile.warnings).toHaveLength(0);

    // 6. session_end
    const endResult = handleSessionEnd(deps, { sessionId, summary: 'Integration test session' });
    expect(endResult).not.toBeNull();
    expect(endResult!.sessionId).toBe(sessionId);
    expect(endResult!.linkedIssue).toBe(42);
    expect(endResult!.totalInputTokens).toBe(8000);
    expect(endResult!.totalOutputTokens).toBe(3000);
    expect(endResult!.totalCostUsd).toBeGreaterThan(0);
    expect(endResult!.durationMs).toBeGreaterThanOrEqual(0);
    expect(endResult!.byModel['claude-opus-4-6']).toBeDefined();
    expect(endResult!.byModel['claude-haiku-4-5-20251001']).toBeDefined();

    // Verify persistence: cost entries
    const costEntries = deps.store.getCostEntries({ runId: sessionId });
    expect(costEntries.length).toBe(2);
    expect(costEntries.every((e) => e.pipelineType === 'interactive')).toBe(true);

    // Verify persistence: episodic record
    const episodes = deps.store.getEpisodicRecords(42, 10);
    expect(episodes.length).toBe(1);
    expect(episodes[0].pipelineType).toBe('interactive');
    expect(episodes[0].outcome).toBe('completed');
    expect(episodes[0].agentName).toBe('integration-tester');

    // Verify persistence: audit entries
    const auditStart = deps.store.queryAuditEntries({ action: 'session.start' });
    const auditEnd = deps.store.queryAuditEntries({ action: 'session.end' });
    expect(auditStart.length).toBe(1);
    expect(auditEnd.length).toBe(1);

    // Session should be inactive now
    expect(deps.sessions.getActive()).toBeUndefined();
  });
});
