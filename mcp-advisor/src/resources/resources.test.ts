import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { registerBudgetResource } from './budget.js';
import { registerCodebaseProfileResource } from './codebase-profile.js';
import { registerConventionsResource } from './conventions.js';
import { registerHistoryResource } from './history.js';
import { registerHotspotsResource } from './hotspots.js';
import { registerMyTasksResource } from './my-tasks.js';
import { registerUpdatesResource } from './updates.js';
import { registerAllResources } from './index.js';
import type { ServerDeps } from '../types.js';

// Mock version-check for the updates resource
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

/**
 * Helper to create an MCP server and capture registered resource handlers.
 * Returns a map of resource name → handler function.
 */
function captureResourceHandlers(
  registerFn: (server: McpServer, deps: ServerDeps) => void,
  deps: ServerDeps,
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const server = new McpServer({ name: 'test', version: '0.1.0' });

  // Spy on server.resource to capture the handler
  const origResource = server.resource.bind(server);
  server.resource = ((...args: unknown[]) => {
    // server.resource has multiple overloads; the handler is always the last arg
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...hargs: unknown[]) => unknown;
    handlers.set(name, handler);
    return origResource(...(args as Parameters<typeof origResource>));
  }) as typeof server.resource;

  registerFn(server, deps);
  return handlers;
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

describe('Resource handler registration', () => {
  let deps: ServerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
  });

  describe('registerBudgetResource', () => {
    it('returns budget data as JSON', async () => {
      const handlers = captureResourceHandlers(registerBudgetResource, deps);
      const handler = handlers.get('budget');
      expect(handler).toBeDefined();

      const result = (await handler!()) as {
        contents: Array<{ text: string; uri: string; mimeType: string }>;
      };
      const data = JSON.parse(result.contents[0].text);
      expect(data.budgetStatus).toBeDefined();
      expect(data.budgetStatus.overBudget).toBe(false);
      expect(data.costByAgent).toBeDefined();
      expect(result.contents[0].uri).toBe('ai-sdlc://context/budget');
      expect(result.contents[0].mimeType).toBe('application/json');
    });
  });

  describe('registerCodebaseProfileResource', () => {
    it('returns message when no profile exists', async () => {
      const handlers = captureResourceHandlers(registerCodebaseProfileResource, deps);
      const handler = handlers.get('codebase-profile');
      expect(handler).toBeDefined();

      const result = (await handler!()) as { contents: Array<{ text: string }> };
      const data = JSON.parse(result.contents[0].text);
      expect(data.message).toContain('No codebase profile');
    });

    it('returns profile data when profile exists', async () => {
      deps.store.saveComplexityProfile({
        repoPath: '/test/repo',
        score: 6,
        filesCount: 50,
        modulesCount: 3,
        dependencyCount: 10,
      });

      const handlers = captureResourceHandlers(registerCodebaseProfileResource, deps);
      const handler = handlers.get('codebase-profile');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      const data = JSON.parse(result.contents[0].text);
      expect(data.score).toBe(6);
    });
  });

  describe('registerConventionsResource', () => {
    it('returns conventions as JSON array', async () => {
      deps.store.saveConvention({ category: 'naming', pattern: 'camelCase' });

      const handlers = captureResourceHandlers(registerConventionsResource, deps);
      const handler = handlers.get('conventions');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      const data = JSON.parse(result.contents[0].text);
      expect(data.length).toBe(1);
      expect(data[0].category).toBe('naming');
    });
  });

  describe('registerHotspotsResource', () => {
    it('returns hotspots as JSON array', async () => {
      deps.store.saveHotspot({
        repoPath: '/test/repo',
        filePath: 'src/hot.ts',
        churnRate: 0.9,
        complexity: 8,
      });

      const handlers = captureResourceHandlers(registerHotspotsResource, deps);
      const handler = handlers.get('hotspots');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      const data = JSON.parse(result.contents[0].text);
      expect(data.length).toBe(1);
      expect(data[0].filePath).toBe('src/hot.ts');
    });
  });

  describe('registerMyTasksResource', () => {
    it('returns pipeline runs as JSON array', async () => {
      deps.store.savePipelineRun({
        runId: 'run-1',
        issueNumber: 10,
        pipelineType: 'execute',
        status: 'completed',
      });

      const handlers = captureResourceHandlers(registerMyTasksResource, deps);
      const handler = handlers.get('my-tasks');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      const data = JSON.parse(result.contents[0].text);
      expect(data.length).toBe(1);
      expect(data[0].runId).toBe('run-1');
    });
  });

  describe('registerHistoryResource', () => {
    it('returns episodic records', async () => {
      deps.store.saveEpisodicRecord({
        issueNumber: 5,
        pipelineType: 'interactive',
        outcome: 'completed',
        agentName: 'test-dev',
      });

      const handlers = captureResourceHandlers(registerHistoryResource, deps);
      const handler = handlers.get('history');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      const data = JSON.parse(result.contents[0].text);
      expect(Array.isArray(data)).toBe(true);
    });

    it('uses active session issue number for filtering', async () => {
      const session = deps.sessions.create({ developer: 'a', tool: 'claude-code' });
      deps.sessions.linkIssue(session.sessionId, 42, 'branch');

      const handlers = captureResourceHandlers(registerHistoryResource, deps);
      const handler = handlers.get('history');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      expect(result.contents[0].text).toBeDefined();
    });
  });

  describe('registerUpdatesResource', () => {
    it('returns up-to-date message when no updates', async () => {
      const handlers = captureResourceHandlers(registerUpdatesResource, deps);
      const handler = handlers.get('updates');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      expect(result.contents[0].text).toContain('up to date');
    });

    it('returns update details when server update is available', async () => {
      const { checkForUpdatesCached } = await import('../version-check.js');
      vi.mocked(checkForUpdatesCached).mockResolvedValueOnce({
        serverVersion: '0.1.0',
        serverLatest: '0.2.0',
        serverUpdateAvailable: true,
        projectUpdates: [],
        hasUpdates: true,
        autoUpdated: [],
      });

      const handlers = captureResourceHandlers(registerUpdatesResource, deps);
      const handler = handlers.get('updates');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      expect(result.contents[0].text).toContain('0.2.0');
    });

    it('returns update details for project dependencies', async () => {
      const { checkForUpdatesCached } = await import('../version-check.js');
      vi.mocked(checkForUpdatesCached).mockResolvedValueOnce({
        serverVersion: '0.1.0',
        serverLatest: null,
        serverUpdateAvailable: false,
        projectUpdates: [
          {
            package: '@ai-sdlc/orchestrator',
            current: '^1.0.0',
            latest: '2.0.0',
            updateAvailable: true,
            location: '/test/repo',
          },
        ],
        hasUpdates: true,
        autoUpdated: [],
      });

      const handlers = captureResourceHandlers(registerUpdatesResource, deps);
      const handler = handlers.get('updates');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      expect(result.contents[0].text).toContain('@ai-sdlc/orchestrator');
      expect(result.contents[0].text).toContain('2.0.0');
    });

    it('reports auto-updated packages', async () => {
      const { checkForUpdatesCached } = await import('../version-check.js');
      vi.mocked(checkForUpdatesCached).mockResolvedValueOnce({
        serverVersion: '0.1.0',
        serverLatest: null,
        serverUpdateAvailable: false,
        projectUpdates: [
          {
            package: '@ai-sdlc/orchestrator',
            current: '^1.0.0',
            latest: '2.0.0',
            updateAvailable: true,
            location: '/test/repo',
          },
        ],
        hasUpdates: true,
        autoUpdated: ['@ai-sdlc/orchestrator'],
      });

      const handlers = captureResourceHandlers(registerUpdatesResource, deps);
      const handler = handlers.get('updates');
      const result = (await handler!()) as { contents: Array<{ text: string }> };
      expect(result.contents[0].text).toContain('Auto-updated');
    });

    it('uses workspace repo paths when workspace is set', async () => {
      const { checkForUpdatesCached } = await import('../version-check.js');
      const db2 = new Database(':memory:');
      const store2 = StateStore.open(db2);
      deps.workspace = {
        workspacePath: '/workspace',
        repos: [
          {
            name: 'frontend',
            path: '/workspace/frontend',
            store: store2,
            costTracker: new CostTracker(store2),
          },
        ],
        sharedStore: store2,
      };

      const handlers = captureResourceHandlers(registerUpdatesResource, deps);
      const handler = handlers.get('updates');
      await handler!();

      expect(vi.mocked(checkForUpdatesCached)).toHaveBeenCalledWith({
        projectDirs: ['/workspace/frontend'],
      });
    });
  });

  describe('registerAllResources', () => {
    it('registers all resource handlers without error', () => {
      const server = new McpServer({ name: 'test', version: '0.1.0' });
      expect(() => registerAllResources(server, deps)).not.toThrow();
    });
  });
});
