import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleTrackUsage } from './track-usage.js';
import type { ServerDeps } from '../types.js';

describe('handleTrackUsage', () => {
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
  });

  it('computes and records cost', () => {
    const session = deps.sessions.create({ developer: 'alice', tool: 'claude-code' });
    const result = handleTrackUsage(deps, {
      sessionId: session.sessionId,
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result.entryCostUsd).toBeGreaterThan(0);
    expect(result.cumulativeCostUsd).toBe(result.entryCostUsd);
    expect(result.cumulativeInputTokens).toBe(1000);
    expect(result.cumulativeOutputTokens).toBe(500);
  });

  it('accumulates across multiple calls', () => {
    const session = deps.sessions.create({ developer: 'alice', tool: 'claude-code' });
    handleTrackUsage(deps, {
      sessionId: session.sessionId,
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const result2 = handleTrackUsage(deps, {
      sessionId: session.sessionId,
      model: 'claude-opus-4-6',
      inputTokens: 2000,
      outputTokens: 1000,
    });
    expect(result2.cumulativeInputTokens).toBe(3000);
    expect(result2.cumulativeOutputTokens).toBe(1500);
    expect(result2.cumulativeCostUsd).toBeGreaterThan(result2.entryCostUsd);
  });

  it('persists cost entry in store', () => {
    const session = deps.sessions.create({ developer: 'alice', tool: 'claude-code' });
    handleTrackUsage(deps, {
      sessionId: session.sessionId,
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const entries = deps.store.getCostEntries({ runId: session.sessionId });
    expect(entries.length).toBe(1);
    expect(entries[0].pipelineType).toBe('interactive');
  });

  it('works without active session (unattributed)', () => {
    const result = handleTrackUsage(deps, {
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(result.entryCostUsd).toBeGreaterThan(0);
    const entries = deps.store.getCostEntries({ runId: 'unattributed' });
    expect(entries.length).toBe(1);
  });
});
