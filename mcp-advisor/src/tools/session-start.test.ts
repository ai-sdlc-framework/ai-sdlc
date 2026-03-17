import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleSessionStart } from './session-start.js';
import type { ServerDeps, WorkspaceContext } from '../types.js';

// Mock issue-linker to avoid real git calls
vi.mock('../issue-linker.js', () => ({
  resolveIssue: vi.fn().mockResolvedValue({ issueNumber: 42, method: 'branch', confidence: 1.0 }),
}));

// Mock version-check to control update notices
vi.mock('../version-check.js', () => ({
  checkForUpdatesCached: vi.fn().mockResolvedValue({
    serverVersion: '0.1.0',
    serverLatest: null,
    serverUpdateAvailable: false,
    projectUpdates: [],
    hasUpdates: false,
    autoUpdated: [],
  }),
}));

describe('handleSessionStart', () => {
  let deps: ServerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('includes updateNotice when auto-updated packages exist', async () => {
    const { checkForUpdatesCached } = await import('../version-check.js');
    vi.mocked(checkForUpdatesCached).mockResolvedValueOnce({
      serverVersion: '0.1.0',
      serverLatest: null,
      serverUpdateAvailable: false,
      projectUpdates: [],
      hasUpdates: true,
      autoUpdated: ['@ai-sdlc/orchestrator'],
    });

    const result = await handleSessionStart(deps, { developer: 'alice', tool: 'claude-code' });
    expect(result.updateNotice).toContain('Auto-updated');
    expect(result.updateNotice).toContain('@ai-sdlc/orchestrator');
  });

  it('includes updateNotice when server update is available', async () => {
    const { checkForUpdatesCached } = await import('../version-check.js');
    vi.mocked(checkForUpdatesCached).mockResolvedValueOnce({
      serverVersion: '0.1.0',
      serverLatest: '0.2.0',
      serverUpdateAvailable: true,
      projectUpdates: [],
      hasUpdates: true,
      autoUpdated: [],
    });

    const result = await handleSessionStart(deps, { developer: 'alice', tool: 'claude-code' });
    expect(result.updateNotice).toContain('MCP server update');
    expect(result.updateNotice).toContain('0.2.0');
  });

  it('no updateNotice when no updates available', async () => {
    const result = await handleSessionStart(deps, { developer: 'alice', tool: 'claude-code' });
    expect(result.updateNotice).toBeUndefined();
  });

  it('handles version check failure gracefully', async () => {
    const { checkForUpdatesCached } = await import('../version-check.js');
    vi.mocked(checkForUpdatesCached).mockRejectedValueOnce(new Error('network error'));

    const result = await handleSessionStart(deps, { developer: 'alice', tool: 'claude-code' });
    // Should still succeed — version check is best-effort
    expect(result.sessionId).toBeTruthy();
    expect(result.updateNotice).toBeUndefined();
  });

  it('passes workspace repo paths to version check', async () => {
    const { checkForUpdatesCached } = await import('../version-check.js');
    const db2 = new Database(':memory:');
    const store2 = StateStore.open(db2);
    const workspace: WorkspaceContext = {
      workspacePath: '/workspace',
      repos: [
        {
          name: 'frontend',
          path: '/workspace/frontend',
          store: store2,
          costTracker: new CostTracker(store2),
        },
        {
          name: 'backend',
          path: '/workspace/backend',
          store: store2,
          costTracker: new CostTracker(store2),
        },
      ],
      sharedStore: store2,
    };
    deps.workspace = workspace;

    await handleSessionStart(deps, { developer: 'alice', tool: 'claude-code' });

    expect(vi.mocked(checkForUpdatesCached)).toHaveBeenCalledWith({
      projectDirs: ['/workspace/frontend', '/workspace/backend'],
    });
  });
});
