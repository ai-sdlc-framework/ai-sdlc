import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleSessionStart } from './session-start.js';
import type { ServerDeps } from '../types.js';

// Mock issue-linker to avoid real git calls
vi.mock('../issue-linker.js', () => ({
  resolveIssue: vi.fn().mockResolvedValue({ issueNumber: 42, method: 'branch', confidence: 1.0 }),
}));

describe('handleSessionStart', () => {
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

  it('creates a session and returns session info', async () => {
    const result = await handleSessionStart(deps, { developer: 'alice', tool: 'claude-code' });
    expect(result.sessionId).toBeTruthy();
    expect(result.linkedIssue).toBe(42);
    expect(result.linkMethod).toBe('branch');
  });

  it('records an audit entry', async () => {
    const result = await handleSessionStart(deps, { developer: 'bob', tool: 'copilot' });
    const entries = deps.store.queryAuditEntries({ action: 'session.start' });
    expect(entries.length).toBe(1);
    expect(entries[0].actor).toBe('bob');
    expect(entries[0].resourceId).toBe(result.sessionId);
  });

  it('session is retrievable after creation', async () => {
    const result = await handleSessionStart(deps, { developer: 'carol', tool: 'cursor' });
    const session = deps.sessions.get(result.sessionId);
    expect(session).toBeDefined();
    expect(session?.developer).toBe('carol');
    expect(session?.active).toBe(true);
  });
});
