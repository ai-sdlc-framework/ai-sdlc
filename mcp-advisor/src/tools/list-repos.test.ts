import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleListRepos } from './list-repos.js';
import type { ServerDeps, WorkspaceContext } from '../types.js';

describe('handleListRepos', () => {
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

  it('returns single repo in non-workspace mode', () => {
    const result = handleListRepos(deps);
    expect(result.isWorkspace).toBe(false);
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].name).toBe('current');
    expect(result.repos[0].path).toBe('/test/repo');
    expect(result.repos[0].hasConfig).toBe(false);
  });

  it('returns single repo with hasConfig true when config exists', () => {
    deps.config = {
      autonomyPolicy: {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'AutonomyPolicy' as const,
        metadata: { name: 'test' },
        spec: { levels: [], promotion: { criteria: [] } },
      },
    } as ServerDeps['config'];

    const result = handleListRepos(deps);
    expect(result.repos[0].hasConfig).toBe(true);
  });

  it('returns workspace repos in workspace mode', () => {
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
          config: undefined,
        },
        {
          name: 'backend',
          path: '/workspace/backend',
          store: store2,
          costTracker: new CostTracker(store2),
          config: {
            autonomyPolicy: {
              apiVersion: 'ai-sdlc.io/v1alpha1',
              kind: 'AutonomyPolicy' as const,
              metadata: { name: 'test' },
              spec: { levels: [], promotion: { criteria: [] } },
            },
          } as ServerDeps['config'],
        },
      ],
      sharedStore: store2,
    };
    deps.workspace = workspace;

    const result = handleListRepos(deps);
    expect(result.isWorkspace).toBe(true);
    expect(result.repos).toHaveLength(2);
    expect(result.repos[0].name).toBe('frontend');
    expect(result.repos[0].hasConfig).toBe(false);
    expect(result.repos[1].name).toBe('backend');
    expect(result.repos[1].hasConfig).toBe(true);
  });
});
