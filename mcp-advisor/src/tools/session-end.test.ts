import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleSessionEnd } from './session-end.js';
import { handleTrackUsage } from './track-usage.js';
import type { ServerDeps } from '../types.js';

describe('handleSessionEnd', () => {
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

  it('returns null when no active session', () => {
    const result = handleSessionEnd(deps, {});
    expect(result).toBeNull();
  });

  it('ends session and returns cost receipt', () => {
    const session = deps.sessions.create({ developer: 'alice', tool: 'claude-code' });
    deps.sessions.linkIssue(session.sessionId, 42, 'branch');

    handleTrackUsage(deps, {
      sessionId: session.sessionId,
      model: 'claude-opus-4-6',
      inputTokens: 1000,
      outputTokens: 500,
    });

    const result = handleSessionEnd(deps, { sessionId: session.sessionId, summary: 'Fixed bug' });
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(session.sessionId);
    expect(result!.linkedIssue).toBe(42);
    expect(result!.totalCostUsd).toBeGreaterThan(0);
    expect(result!.totalInputTokens).toBe(1000);
    expect(result!.totalOutputTokens).toBe(500);
    expect(result!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result!.byModel['claude-opus-4-6']).toBeDefined();
  });

  it('saves episodic record', () => {
    const session = deps.sessions.create({ developer: 'bob', tool: 'copilot' });
    handleSessionEnd(deps, { sessionId: session.sessionId, summary: 'Refactored module' });

    const records = deps.store.getEpisodicRecords(undefined, 10);
    expect(records.length).toBe(1);
    expect(records[0].pipelineType).toBe('interactive');
    expect(records[0].outcome).toBe('completed');
    expect(records[0].agentName).toBe('bob');
  });

  it('saves audit entry', () => {
    const session = deps.sessions.create({ developer: 'carol', tool: 'cursor' });
    handleSessionEnd(deps, { sessionId: session.sessionId });

    const entries = deps.store.queryAuditEntries({ action: 'session.end' });
    expect(entries.length).toBe(1);
    expect(entries[0].actor).toBe('carol');
  });

  it('marks session as inactive', () => {
    const session = deps.sessions.create({ developer: 'dave', tool: 'other' });
    handleSessionEnd(deps, { sessionId: session.sessionId });
    expect(deps.sessions.getActive()).toBeUndefined();
  });
});
