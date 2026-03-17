/**
 * Unit tests for the Orchestrator class.
 * Covers constructor, run(), start(), fixCI(), status(), health(),
 * analyze(), agents(), routing(), complexity(), cost(), dashboard(),
 * close(), and property getters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineResult } from './execute.js';
import type { OrchestratorPlugin } from './plugin.js';
import type { Logger } from './logger.js';
import type { CodebaseProfile, CodebaseContext } from './analysis/types.js';
import type { CostSummary, BudgetStatus } from './cost-tracker.js';
import type { AutonomyLedgerEntry, RoutingDecision, PipelineRun } from './state/types.js';
import type { SecurityContext } from './security.js';

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock executePipeline
vi.mock('./execute.js', () => ({
  executePipeline: vi.fn(),
}));

// Mock startWatch
vi.mock('./watch.js', () => ({
  startWatch: vi.fn(),
}));

// Mock executeFixCI
vi.mock('./fix-ci.js', () => ({
  executeFixCI: vi.fn(),
}));

// Mock loadConfig
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => ({
    version: '0.1.0',
    pipeline: null,
  })),
}));

// Mock StateStore
vi.mock('./state/index.js', () => ({
  StateStore: {
    open: vi.fn(),
  },
}));

// Mock createLogger
vi.mock('./logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    stage: vi.fn(),
    stageEnd: vi.fn(),
    summary: vi.fn(),
  })),
}));

// Mock AutonomyTracker
vi.mock('./autonomy-tracker.js', () => ({
  AutonomyTracker: vi.fn().mockImplementation(() => ({
    getLevel: vi.fn(),
    promote: vi.fn(),
    demote: vi.fn(),
  })),
}));

// Mock CostTracker
vi.mock('./cost-tracker.js', () => ({
  CostTracker: vi.fn().mockImplementation(() => ({
    getCostSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    recordCost: vi.fn(),
  })),
}));

// Mock CostGovernancePlugin
vi.mock('./cost-governance.js', () => ({
  CostGovernancePlugin: vi.fn().mockImplementation(() => ({
    name: 'cost-governance',
    initialize: vi.fn(),
    beforeRun: vi.fn(),
    afterRun: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

// Mock analyzeCodebase
vi.mock('./analysis/analyzer.js', () => ({
  analyzeCodebase: vi.fn(),
}));

// Mock buildCodebaseContext
vi.mock('./analysis/context-builder.js', () => ({
  buildCodebaseContext: vi.fn(),
}));

import { executePipeline } from './execute.js';
import { startWatch } from './watch.js';
import { executeFixCI } from './fix-ci.js';
import { loadConfig } from './config.js';
import { StateStore } from './state/index.js';
import { CostGovernancePlugin } from './cost-governance.js';
import { analyzeCodebase } from './analysis/analyzer.js';
import { buildCodebaseContext } from './analysis/context-builder.js';
import { Orchestrator } from './orchestrator.js';

const mockExecute = vi.mocked(executePipeline);
const mockStartWatch = vi.mocked(startWatch);
const mockFixCI = vi.mocked(executeFixCI);
const mockLoadConfig = vi.mocked(loadConfig);
const mockStateStoreOpen = vi.mocked(StateStore.open);
const mockAnalyzeCodebase = vi.mocked(analyzeCodebase);
const mockBuildCodebaseContext = vi.mocked(buildCodebaseContext);

// ── Helpers ────────────────────────────────────────────────────────────

function makeSilentLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    stage: vi.fn(),
    stageEnd: vi.fn(),
    summary: vi.fn(),
  };
}

function makeResult(overrides?: Partial<PipelineResult>): PipelineResult {
  return {
    prUrl: 'https://github.com/org/repo/pull/1',
    filesChanged: ['src/index.ts'],
    promotionEligible: true,
    ...overrides,
  };
}

function makeMockStateStore() {
  return {
    savePipelineRun: vi.fn(),
    updatePipelineRunStatus: vi.fn(),
    saveEpisodicRecord: vi.fn(),
    getPipelineRuns: vi.fn().mockReturnValue([]),
    getLatestComplexityProfile: vi.fn().mockReturnValue(null),
    saveCodebaseProfile: vi.fn(),
    saveHotspot: vi.fn(),
    getAllAutonomyLedgerEntries: vi.fn().mockReturnValue([]),
    getRoutingHistory: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
}

function makeProfile(overrides?: Partial<CodebaseProfile>): CodebaseProfile {
  return {
    repoPath: '/tmp/repo',
    score: 42,
    filesCount: 100,
    modulesCount: 5,
    dependencyCount: 10,
    modules: [],
    moduleGraph: { modules: [], edges: [], externalDependencies: [], cycles: [] },
    architecturalPatterns: [
      { name: 'layered', confidence: 0.8, description: 'Layered architecture', evidence: ['src/'] },
    ],
    hotspots: [{ filePath: 'src/hot.ts', churnRate: 5, complexity: 10, commitCount: 20 }],
    conventions: [{ category: 'naming', pattern: 'camelCase', confidence: 0.9, examples: ['foo'] }],
    analyzedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCodebaseContext(): CodebaseContext {
  return {
    score: 42,
    filesCount: 100,
    modulesCount: 5,
    dependencyCount: 10,
    architectureSummary: 'Layered architecture',
    conventionsSummary: 'camelCase naming',
    hotspotsSummary: 'src/hot.ts',
  };
}

function makeCostSummary(overrides?: Partial<CostSummary>): CostSummary {
  return {
    totalCostUsd: 10,
    totalTokens: 5000,
    totalInputTokens: 3000,
    totalOutputTokens: 2000,
    entryCount: 5,
    avgCostPerRun: 2,
    avgTokensPerRun: 1000,
    costByAgent: { 'claude-code': 10 },
    costByModel: { 'claude-3': 10 },
    ...overrides,
  };
}

function makeBudgetStatus(overrides?: Partial<BudgetStatus>): BudgetStatus {
  return {
    budgetUsd: 100,
    spentUsd: 10,
    remainingUsd: 90,
    utilizationPercent: 10,
    overBudget: false,
    projectedMonthlyUsd: 30,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(makeResult());
    mockLoadConfig.mockReturnValue({ version: '0.1.0' } as unknown as ReturnType<
      typeof loadConfig
    >);
  });

  // ── Constructor ────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates without statePath — no state store', () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      expect(orch.state).toBeUndefined();
      expect(orch.autonomyTracker).toBeUndefined();
      expect(orch.costTracker).toBeUndefined();
    });

    it('creates with statePath — opens state store and creates trackers', () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/state.db', logger: makeSilentLogger() });

      expect(mockStateStoreOpen).toHaveBeenCalledWith('/tmp/state.db');
      expect(orch.state).toBe(mockStore);
      expect(orch.autonomyTracker).toBeDefined();
      expect(orch.costTracker).toBeDefined();
    });

    it('uses default logger when none provided', () => {
      const orch = new Orchestrator({});
      // Should not throw — createLogger mock returns a logger
      expect(orch).toBeDefined();
    });

    it('uses provided plugins array', async () => {
      const initFn = vi.fn();
      const plugin: OrchestratorPlugin = { name: 'test', initialize: initFn };
      const orch = new Orchestrator({ plugins: [plugin], logger: makeSilentLogger() });

      // Trigger plugin init by running
      await orch.run('1');
      expect(initFn).toHaveBeenCalledOnce();
      await orch.close();
    });
  });

  // ── run() ──────────────────────────────────────────────────────────

  describe('run()', () => {
    it('calls executePipeline with correct options', async () => {
      const logger = makeSilentLogger();
      const orch = new Orchestrator({ configDir: '/cfg', workDir: '/work', logger });
      const result = await orch.run('42');

      expect(mockExecute).toHaveBeenCalledWith(
        '42',
        expect.objectContaining({
          configDir: '/cfg',
          workDir: '/work',
          logger,
        }),
      );
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
      await orch.close();
    });

    it('passes overrides to executePipeline', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await orch.run('42', { workDir: '/override' });

      expect(mockExecute).toHaveBeenCalledWith(
        '42',
        expect.objectContaining({
          workDir: '/override',
        }),
      );
      await orch.close();
    });

    it('records pipeline run in state store on start', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await orch.run('42');

      expect(mockStore.savePipelineRun).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: '42',
          issueNumber: 42,
          pipelineType: 'execute',
          status: 'running',
          currentStage: 'init',
        }),
      );
      await orch.close();
    });

    it('records success in state store on completion', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      mockExecute.mockResolvedValue(
        makeResult({ prUrl: 'pr-url', filesChanged: ['a.ts', 'b.ts'] }),
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await orch.run('42');

      expect(mockStore.updatePipelineRunStatus).toHaveBeenCalledWith(
        expect.stringMatching(/^run-/),
        'completed',
        expect.objectContaining({
          result: expect.stringContaining('pr-url'),
        }),
      );
      expect(mockStore.saveEpisodicRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: '42',
          pipelineType: 'execute',
          outcome: 'success',
          filesChanged: 2,
        }),
      );
      await orch.close();
    });

    it('records failure in state store on error', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      mockExecute.mockRejectedValue(new Error('pipeline boom'));

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await expect(orch.run('42')).rejects.toThrow('pipeline boom');

      expect(mockStore.updatePipelineRunStatus).toHaveBeenCalledWith(
        expect.stringMatching(/^run-/),
        'failed',
        expect.objectContaining({
          result: expect.stringContaining('pipeline boom'),
        }),
      );
      expect(mockStore.saveEpisodicRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: '42',
          pipelineType: 'execute',
          outcome: 'failure',
          errorMessage: 'pipeline boom',
        }),
      );
      await orch.close();
    });

    it('records failure for non-Error thrown values', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      mockExecute.mockRejectedValue('string error');

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await expect(orch.run('42')).rejects.toBe('string error');

      expect(mockStore.saveEpisodicRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failure',
          errorMessage: 'string error',
        }),
      );
      await orch.close();
    });

    it('handles non-numeric issueId gracefully', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await orch.run('AISDLC-3');

      expect(mockStore.savePipelineRun).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: 'AISDLC-3',
          issueNumber: undefined,
        }),
      );
      await orch.close();
    });

    it('auto-registers cost governance plugin when costPolicy is present', async () => {
      mockLoadConfig.mockReturnValue({
        pipeline: {
          spec: {
            costPolicy: { budget: { period: 'month', amount: 100, currency: 'USD' } },
          },
        },
      } as unknown as ReturnType<typeof loadConfig>);

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await orch.run('1');

      expect(CostGovernancePlugin).toHaveBeenCalled();
      await orch.close();
    });

    it('does not auto-register cost governance if already registered', async () => {
      mockLoadConfig.mockReturnValue({
        pipeline: {
          spec: {
            costPolicy: { budget: { period: 'month', amount: 100, currency: 'USD' } },
          },
        },
      } as unknown as ReturnType<typeof loadConfig>);

      const existingPlugin: OrchestratorPlugin = { name: 'cost-governance' };
      const orch = new Orchestrator({ plugins: [existingPlugin], logger: makeSilentLogger() });
      await orch.run('1');

      // The mock CostGovernancePlugin should NOT be called since one already exists
      expect(CostGovernancePlugin).not.toHaveBeenCalled();
      await orch.close();
    });

    it('handles config load failure gracefully during cost plugin registration', async () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error('config not found');
      });

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      // Should not throw — config error is caught, executePipeline will report it
      await orch.run('1');
      expect(mockExecute).toHaveBeenCalled();
      await orch.close();
    });

    it('notifies plugins before run', async () => {
      const beforeFn = vi.fn();
      const plugin: OrchestratorPlugin = { name: 'test', beforeRun: beforeFn };
      const orch = new Orchestrator({ plugins: [plugin], logger: makeSilentLogger() });
      await orch.run('42');

      expect(beforeFn).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: '42',
          issueNumber: 42,
        }),
      );
      await orch.close();
    });

    it('notifies plugins after successful run', async () => {
      const result = makeResult();
      mockExecute.mockResolvedValue(result);
      const afterFn = vi.fn();
      const plugin: OrchestratorPlugin = { name: 'test', afterRun: afterFn };
      const orch = new Orchestrator({ plugins: [plugin], logger: makeSilentLogger() });
      await orch.run('42');

      expect(afterFn).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: '42',
          result,
          durationMs: expect.any(Number),
        }),
      );
      await orch.close();
    });

    it('notifies plugins on error', async () => {
      mockExecute.mockRejectedValue(new Error('boom'));
      const errorFn = vi.fn();
      const plugin: OrchestratorPlugin = { name: 'test', onError: errorFn };
      const orch = new Orchestrator({ plugins: [plugin], logger: makeSilentLogger() });

      await expect(orch.run('42')).rejects.toThrow('boom');

      expect(errorFn).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: '42',
          error: expect.any(Error),
          durationMs: expect.any(Number),
        }),
      );
      await orch.close();
    });

    it('wraps non-Error in Error for plugin onError', async () => {
      mockExecute.mockRejectedValue('string error');
      const errorFn = vi.fn();
      const plugin: OrchestratorPlugin = { name: 'test', onError: errorFn };
      const orch = new Orchestrator({ plugins: [plugin], logger: makeSilentLogger() });

      await expect(orch.run('42')).rejects.toBe('string error');

      const event = errorFn.mock.calls[0][0];
      expect(event.error).toBeInstanceOf(Error);
      expect(event.error.message).toBe('string error');
      await orch.close();
    });

    it('passes runner and security through to executePipeline', async () => {
      const runner = { run: vi.fn() };
      const security = {} as SecurityContext;
      const orch = new Orchestrator({ runner, security, logger: makeSilentLogger() });
      await orch.run('1');

      expect(mockExecute).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({
          runner,
          security,
        }),
      );
      await orch.close();
    });
  });

  // ── start() ────────────────────────────────────────────────────────

  describe('start()', () => {
    it('calls startWatch with runner and security from config', async () => {
      const mockHandle = { stop: vi.fn(), enqueue: vi.fn(), queueSize: 0, activeCount: 0 };
      mockStartWatch.mockReturnValue(mockHandle as unknown as ReturnType<typeof startWatch>);

      const runner = { run: vi.fn() };
      const security = {} as SecurityContext;
      const logger = makeSilentLogger();
      const orch = new Orchestrator({ runner, security, logger });
      const handle = await orch.start();

      expect(mockStartWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          executeOptions: expect.objectContaining({
            runner,
            security,
            logger,
          }),
        }),
      );
      expect(handle).toBe(mockHandle);
      await orch.close();
    });

    it('passes additional options through', async () => {
      const mockHandle = { stop: vi.fn(), enqueue: vi.fn(), queueSize: 0, activeCount: 0 };
      mockStartWatch.mockReturnValue(mockHandle as unknown as ReturnType<typeof startWatch>);

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await orch.start({ reconcilerConfig: { periodicIntervalMs: 30000 } });

      expect(mockStartWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          reconcilerConfig: { periodicIntervalMs: 30000 },
        }),
      );
      await orch.close();
    });
  });

  // ── fixCI() ────────────────────────────────────────────────────────

  describe('fixCI()', () => {
    it('calls executeFixCI with correct arguments', async () => {
      mockFixCI.mockResolvedValue(undefined);
      const logger = makeSilentLogger();
      const orch = new Orchestrator({ configDir: '/cfg', workDir: '/work', logger });
      await orch.fixCI(100, 200);

      expect(mockFixCI).toHaveBeenCalledWith(
        100,
        200,
        expect.objectContaining({
          configDir: '/cfg',
          workDir: '/work',
          logger,
        }),
      );
      await orch.close();
    });

    it('passes overrides to executeFixCI', async () => {
      mockFixCI.mockResolvedValue(undefined);
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await orch.fixCI(100, 200, { workDir: '/override' });

      expect(mockFixCI).toHaveBeenCalledWith(
        100,
        200,
        expect.objectContaining({
          workDir: '/override',
        }),
      );
      await orch.close();
    });

    it('passes runner and security to executeFixCI', async () => {
      mockFixCI.mockResolvedValue(undefined);
      const runner = { run: vi.fn() };
      const security = {} as SecurityContext;
      const orch = new Orchestrator({ runner, security, logger: makeSilentLogger() });
      await orch.fixCI(1, 2);

      expect(mockFixCI).toHaveBeenCalledWith(
        1,
        2,
        expect.objectContaining({
          runner,
          security,
        }),
      );
      await orch.close();
    });
  });

  // ── status() ───────────────────────────────────────────────────────

  describe('status()', () => {
    it('returns config and empty runs when no state store', async () => {
      const config = { version: '0.1.0', pipeline: {} };
      mockLoadConfig.mockReturnValue(config as unknown as ReturnType<typeof loadConfig>);

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const status = await orch.status();

      expect(status.config).toBe(config);
      expect(status.recentRuns).toEqual([]);
      await orch.close();
    });

    it('returns recent runs from state store', async () => {
      const mockStore = makeMockStateStore();
      const runs: PipelineRun[] = [
        {
          runId: 'run-1',
          issueNumber: 42,
          status: 'completed',
          startedAt: '2024-01-01',
          pipelineType: 'execute',
        },
        {
          runId: 'run-2',
          issueNumber: 43,
          status: 'failed',
          startedAt: '2024-01-02',
          pipelineType: 'execute',
        },
      ];
      mockStore.getPipelineRuns.mockReturnValue(runs);
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      const status = await orch.status();

      expect(status.recentRuns).toHaveLength(2);
      expect(status.recentRuns[0]).toEqual({
        runId: 'run-1',
        issueNumber: 42,
        status: 'completed',
        startedAt: '2024-01-01',
      });
      await orch.close();
    });

    it('filters by issue number', async () => {
      const mockStore = makeMockStateStore();
      mockStore.getPipelineRuns.mockReturnValue([]);
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await orch.status(42);

      expect(mockStore.getPipelineRuns).toHaveBeenCalledWith(42, 10);
      await orch.close();
    });

    it('uses configDir from orchestrator config', async () => {
      const orch = new Orchestrator({ configDir: '/custom/cfg', logger: makeSilentLogger() });
      await orch.status();

      expect(mockLoadConfig).toHaveBeenCalledWith('/custom/cfg');
      await orch.close();
    });

    it('falls back to workDir/.ai-sdlc for config dir', async () => {
      const orch = new Orchestrator({ workDir: '/myproject', logger: makeSilentLogger() });
      await orch.status();

      expect(mockLoadConfig).toHaveBeenCalledWith('/myproject/.ai-sdlc');
      await orch.close();
    });

    it('falls back to ./.ai-sdlc when no workDir', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await orch.status();

      expect(mockLoadConfig).toHaveBeenCalledWith('./.ai-sdlc');
      await orch.close();
    });
  });

  // ── health() ───────────────────────────────────────────────────────

  describe('health()', () => {
    it('returns healthy result when config is valid', async () => {
      mockLoadConfig.mockReturnValue({ version: '0.1.0' } as unknown as ReturnType<
        typeof loadConfig
      >);

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.health();

      expect(result.configValid).toBe(true);
      expect(result.stateStoreConnected).toBe(false);
      expect(result.errors).toEqual([]);
      await orch.close();
    });

    it('reports state store connected when statePath is provided', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      const result = await orch.health();

      expect(result.stateStoreConnected).toBe(true);
      await orch.close();
    });

    it('reports config errors', async () => {
      mockLoadConfig.mockImplementation(() => {
        throw new Error('invalid YAML');
      });

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.health();

      expect(result.configValid).toBe(false);
      expect(result.errors).toEqual(['Config: invalid YAML']);
      await orch.close();
    });

    it('handles non-Error thrown during config load', async () => {
      mockLoadConfig.mockImplementation(() => {
        throw 'string error';
      });

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.health();

      expect(result.configValid).toBe(false);
      expect(result.errors).toEqual(['Config: string error']);
      await orch.close();
    });

    it('uses configDir for health check', async () => {
      const orch = new Orchestrator({ configDir: '/my/config', logger: makeSilentLogger() });
      await orch.health();

      expect(mockLoadConfig).toHaveBeenCalledWith('/my/config');
      await orch.close();
    });
  });

  // ── analyze() ──────────────────────────────────────────────────────

  describe('analyze()', () => {
    it('calls analyzeCodebase and returns profile', async () => {
      const profile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(profile);

      const orch = new Orchestrator({ workDir: '/myrepo', logger: makeSilentLogger() });
      const result = await orch.analyze();

      expect(mockAnalyzeCodebase).toHaveBeenCalledWith({ repoPath: '/myrepo' });
      expect(result).toBe(profile);
      await orch.close();
    });

    it('uses process.cwd() when no workDir', async () => {
      const profile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(profile);

      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await orch.analyze();

      expect(mockAnalyzeCodebase).toHaveBeenCalledWith({ repoPath: process.cwd() });
      await orch.close();
    });

    it('persists profile to state store', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      const profile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(profile);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      await orch.analyze();

      expect(mockStore.saveCodebaseProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: profile.repoPath,
          score: profile.score,
          filesCount: profile.filesCount,
        }),
      );
      await orch.close();
    });

    it('saves hotspot records to state store', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      const profile = makeProfile({
        hotspots: [
          { filePath: 'a.ts', churnRate: 3, complexity: 5, commitCount: 10 },
          { filePath: 'b.ts', churnRate: 7, complexity: 12, commitCount: 20 },
        ],
      });
      mockAnalyzeCodebase.mockResolvedValue(profile);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      await orch.analyze();

      expect(mockStore.saveHotspot).toHaveBeenCalledTimes(2);
      expect(mockStore.saveHotspot).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: 'a.ts', churnRate: 3 }),
      );
      expect(mockStore.saveHotspot).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: 'b.ts', churnRate: 7 }),
      );
      await orch.close();
    });

    it('returns cached profile when fresh', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const cached = {
        repoPath: '/myrepo',
        score: 42,
        filesCount: 100,
        modulesCount: 5,
        dependencyCount: 10,
        analyzedAt: new Date().toISOString(), // fresh
        architecturalPatterns: JSON.stringify([{ name: 'layered' }]),
        hotspots: JSON.stringify([{ filePath: 'x.ts' }]),
        moduleGraph: JSON.stringify({
          modules: [],
          edges: [],
          externalDependencies: [],
          cycles: [],
        }),
        conventionsData: JSON.stringify([{ category: 'naming' }]),
      };
      mockStore.getLatestComplexityProfile.mockReturnValue(cached);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      const result = await orch.analyze();

      expect(mockAnalyzeCodebase).not.toHaveBeenCalled();
      expect(result.repoPath).toBe('/myrepo');
      expect(result.score).toBe(42);
      expect(result.architecturalPatterns).toEqual([{ name: 'layered' }]);
      await orch.close();
    });

    it('ignores stale cache and re-analyzes', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
      const cached = {
        repoPath: '/myrepo',
        score: 42,
        filesCount: 100,
        modulesCount: 5,
        dependencyCount: 10,
        analyzedAt: staleDate,
        architecturalPatterns: JSON.stringify([]),
        hotspots: JSON.stringify([]),
        moduleGraph: JSON.stringify({
          modules: [],
          edges: [],
          externalDependencies: [],
          cycles: [],
        }),
        conventionsData: JSON.stringify([]),
      };
      mockStore.getLatestComplexityProfile.mockReturnValue(cached);

      const freshProfile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(freshProfile);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      const result = await orch.analyze();

      expect(mockAnalyzeCodebase).toHaveBeenCalled();
      expect(result).toBe(freshProfile);
      await orch.close();
    });

    it('re-analyzes when force is true', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const cached = {
        repoPath: '/myrepo',
        score: 42,
        analyzedAt: new Date().toISOString(),
        architecturalPatterns: JSON.stringify([]),
      };
      mockStore.getLatestComplexityProfile.mockReturnValue(cached);

      const freshProfile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(freshProfile);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      const result = await orch.analyze({ force: true });

      expect(mockAnalyzeCodebase).toHaveBeenCalled();
      expect(result).toBe(freshProfile);
      await orch.close();
    });

    it('handles cached profile with missing optional fields', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const cached = {
        repoPath: '/myrepo',
        score: 10,
        analyzedAt: new Date().toISOString(),
        architecturalPatterns: JSON.stringify([{ name: 'mvc' }]),
        // no hotspots, moduleGraph, conventionsData, filesCount, modulesCount, dependencyCount
      };
      mockStore.getLatestComplexityProfile.mockReturnValue(cached);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      const result = await orch.analyze();

      expect(result.filesCount).toBe(0);
      expect(result.modulesCount).toBe(0);
      expect(result.dependencyCount).toBe(0);
      expect(result.hotspots).toEqual([]);
      expect(result.conventions).toEqual([]);
      expect(result.moduleGraph).toEqual({
        modules: [],
        edges: [],
        externalDependencies: [],
        cycles: [],
      });
      await orch.close();
    });

    it('skips cache when no analyzedAt', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const cached = {
        repoPath: '/myrepo',
        score: 10,
        // no analyzedAt
      };
      mockStore.getLatestComplexityProfile.mockReturnValue(cached);

      const freshProfile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(freshProfile);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      const result = await orch.analyze();

      expect(mockAnalyzeCodebase).toHaveBeenCalled();
      expect(result).toBe(freshProfile);
      await orch.close();
    });

    it('skips cache when no architecturalPatterns', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const cached = {
        repoPath: '/myrepo',
        score: 10,
        analyzedAt: new Date().toISOString(),
        // no architecturalPatterns
      };
      mockStore.getLatestComplexityProfile.mockReturnValue(cached);

      const freshProfile = makeProfile();
      mockAnalyzeCodebase.mockResolvedValue(freshProfile);

      const orch = new Orchestrator({
        statePath: '/tmp/test.db',
        workDir: '/myrepo',
        logger: makeSilentLogger(),
      });
      const result = await orch.analyze();

      expect(mockAnalyzeCodebase).toHaveBeenCalled();
      expect(result).toBe(freshProfile);
      await orch.close();
    });
  });

  // ── agents() ───────────────────────────────────────────────────────

  describe('agents()', () => {
    it('returns empty array when no state store', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.agents();
      expect(result).toEqual([]);
      await orch.close();
    });

    it('returns entries from state store', async () => {
      const mockStore = makeMockStateStore();
      const entries: AutonomyLedgerEntry[] = [
        {
          agentName: 'claude-code',
          currentLevel: 1,
          totalTasks: 10,
          successCount: 8,
          failureCount: 2,
        },
      ];
      mockStore.getAllAutonomyLedgerEntries.mockReturnValue(entries);
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      const result = await orch.agents();

      expect(result).toBe(entries);
      await orch.close();
    });
  });

  // ── routing() ──────────────────────────────────────────────────────

  describe('routing()', () => {
    it('returns empty array when no state store', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.routing();
      expect(result).toEqual([]);
      await orch.close();
    });

    it('returns routing history from state store', async () => {
      const mockStore = makeMockStateStore();
      const decisions: RoutingDecision[] = [
        {
          issueId: '42',
          taskComplexity: 2,
          codebaseComplexity: 50,
          routingStrategy: 'fully-autonomous',
        },
      ];
      mockStore.getRoutingHistory.mockReturnValue(decisions);
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      const result = await orch.routing();

      expect(mockStore.getRoutingHistory).toHaveBeenCalledWith(50);
      expect(result).toBe(decisions);
      await orch.close();
    });

    it('passes custom limit', async () => {
      const mockStore = makeMockStateStore();
      mockStore.getRoutingHistory.mockReturnValue([]);
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await orch.routing({ limit: 10 });

      expect(mockStore.getRoutingHistory).toHaveBeenCalledWith(10);
      await orch.close();
    });
  });

  // ── complexity() ───────────────────────────────────────────────────

  describe('complexity()', () => {
    it('returns profile and context', async () => {
      const profile = makeProfile();
      const context = makeCodebaseContext();
      mockAnalyzeCodebase.mockResolvedValue(profile);
      mockBuildCodebaseContext.mockReturnValue(context);

      const orch = new Orchestrator({ workDir: '/myrepo', logger: makeSilentLogger() });
      const result = await orch.complexity();

      expect(result.profile).toBe(profile);
      expect(result.context).toBe(context);
      expect(mockBuildCodebaseContext).toHaveBeenCalledWith(profile);
      await orch.close();
    });

    it('passes analyze flag to force analysis', async () => {
      const profile = makeProfile();
      const context = makeCodebaseContext();
      mockAnalyzeCodebase.mockResolvedValue(profile);
      mockBuildCodebaseContext.mockReturnValue(context);

      const orch = new Orchestrator({ workDir: '/myrepo', logger: makeSilentLogger() });
      await orch.complexity({ analyze: true });

      // force=true is passed through to analyze
      expect(mockAnalyzeCodebase).toHaveBeenCalled();
      await orch.close();
    });
  });

  // ── cost() ─────────────────────────────────────────────────────────

  describe('cost()', () => {
    it('returns zero summary when no cost tracker', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.cost();

      expect(result.summary.totalCostUsd).toBe(0);
      expect(result.summary.entryCount).toBe(0);
      expect(result.budget.budgetUsd).toBe(0);
      expect(result.budget.overBudget).toBe(false);
      await orch.close();
    });

    it('returns cost summary from tracker', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });

      // Get the CostTracker instance created in constructor
      const costTracker = orch.costTracker!;
      const summary = makeCostSummary();
      const budget = makeBudgetStatus();
      vi.mocked(costTracker.getCostSummary).mockReturnValue(summary);
      vi.mocked(costTracker.getBudgetStatus).mockReturnValue(budget);

      const result = await orch.cost();

      expect(result.summary).toBe(summary);
      expect(result.budget).toBe(budget);
      await orch.close();
    });

    it('passes since and budget options', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });

      const costTracker = orch.costTracker!;
      vi.mocked(costTracker.getCostSummary).mockReturnValue(makeCostSummary());
      vi.mocked(costTracker.getBudgetStatus).mockReturnValue(makeBudgetStatus());

      await orch.cost({ since: '2024-01-01', budget: 500 });

      expect(costTracker.getCostSummary).toHaveBeenCalledWith('2024-01-01');
      expect(costTracker.getBudgetStatus).toHaveBeenCalledWith(500, '2024-01-01');
      await orch.close();
    });
  });

  // ── dashboard() ────────────────────────────────────────────────────

  describe('dashboard()', () => {
    it('returns dashboard data when no state store', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      const result = await orch.dashboard();

      expect(result.runs).toEqual([]);
      expect(result.agents).toEqual([]);
      expect(result.costSummary.totalCostUsd).toBe(0);
      expect(result.budgetStatus.budgetUsd).toBe(0);
      await orch.close();
    });

    it('returns dashboard data from state store', async () => {
      const mockStore = makeMockStateStore();
      const runs: PipelineRun[] = [
        { runId: 'run-1', status: 'completed', startedAt: '2024-01-01', pipelineType: 'execute' },
      ];
      const agents: AutonomyLedgerEntry[] = [
        {
          agentName: 'claude-code',
          currentLevel: 1,
          totalTasks: 5,
          successCount: 4,
          failureCount: 1,
        },
      ];
      mockStore.getPipelineRuns.mockReturnValue(runs);
      mockStore.getAllAutonomyLedgerEntries.mockReturnValue(agents);
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });

      const costTracker = orch.costTracker!;
      vi.mocked(costTracker.getCostSummary).mockReturnValue(makeCostSummary());
      vi.mocked(costTracker.getBudgetStatus).mockReturnValue(makeBudgetStatus());

      const result = await orch.dashboard();

      expect(result.runs).toEqual([
        { runId: 'run-1', status: 'completed', startedAt: '2024-01-01' },
      ]);
      expect(result.agents).toBe(agents);
      expect(result.costSummary.totalCostUsd).toBe(10);
      expect(result.budgetStatus.budgetUsd).toBe(100);
      await orch.close();
    });
  });

  // ── getters ────────────────────────────────────────────────────────

  describe('property getters', () => {
    it('autonomyTracker returns undefined without state store', () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      expect(orch.autonomyTracker).toBeUndefined();
    });

    it('costTracker returns undefined without state store', () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      expect(orch.costTracker).toBeUndefined();
    });

    it('state returns undefined without state store', () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      expect(orch.state).toBeUndefined();
    });

    it('autonomyTracker returns tracker with state store', () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      expect(orch.autonomyTracker).toBeDefined();
    });

    it('costTracker returns tracker with state store', () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      expect(orch.costTracker).toBeDefined();
    });

    it('state returns store with state store', () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );
      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      expect(orch.state).toBe(mockStore);
    });
  });

  // ── close() ────────────────────────────────────────────────────────

  describe('close()', () => {
    it('calls shutdown on plugins', async () => {
      const shutdownFn = vi.fn();
      const plugin: OrchestratorPlugin = { name: 'test', shutdown: shutdownFn };
      const orch = new Orchestrator({ plugins: [plugin], logger: makeSilentLogger() });
      await orch.close();

      expect(shutdownFn).toHaveBeenCalledOnce();
    });

    it('closes state store', async () => {
      const mockStore = makeMockStateStore();
      mockStateStoreOpen.mockReturnValue(
        mockStore as unknown as ReturnType<typeof StateStore.open>,
      );

      const orch = new Orchestrator({ statePath: '/tmp/test.db', logger: makeSilentLogger() });
      await orch.close();

      expect(mockStore.close).toHaveBeenCalledOnce();
    });

    it('handles close without state store', async () => {
      const orch = new Orchestrator({ logger: makeSilentLogger() });
      await expect(orch.close()).resolves.not.toThrow();
    });

    it('calls shutdown on multiple plugins', async () => {
      const shutdownA = vi.fn();
      const shutdownB = vi.fn();
      const orch = new Orchestrator({
        plugins: [
          { name: 'a', shutdown: shutdownA },
          { name: 'b', shutdown: shutdownB },
        ],
        logger: makeSilentLogger(),
      });
      await orch.close();

      expect(shutdownA).toHaveBeenCalledOnce();
      expect(shutdownB).toHaveBeenCalledOnce();
    });
  });
});
