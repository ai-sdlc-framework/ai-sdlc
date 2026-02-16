/**
 * Orchestrator class — central entry point wrapping executePipeline,
 * startWatch, executeFixCI, and the state store.
 */

import { executePipeline, type ExecuteOptions, type PipelineResult } from './execute.js';
import { startWatch, type WatchOptions, type WatchHandle } from './watch.js';
import { executeFixCI, type FixCIOptions } from './fix-ci.js';
import { loadConfig, loadConfigAsync, type AiSdlcConfig } from './config.js';
import { StateStore } from './state/index.js';
import { createLogger, type Logger } from './logger.js';
import type { SecurityContext } from './security.js';
import type { AgentRunner } from './runners/types.js';
import { analyzeCodebase } from './analysis/analyzer.js';
import { buildCodebaseContext } from './analysis/context-builder.js';
import type { CodebaseProfile, CodebaseContext } from './analysis/types.js';
import type { AutonomyLedgerEntry, RoutingDecision } from './state/types.js';

export interface OrchestratorConfig {
  /** Path to the .ai-sdlc config directory. */
  configDir?: string;
  /** Working directory (defaults to process.cwd()). */
  workDir?: string;
  /** Path to the SQLite state database. Omit to disable persistence. */
  statePath?: string;
  /** Security context for enterprise features. */
  security?: SecurityContext;
  /** Custom agent runner override. */
  runner?: AgentRunner;
  /** Custom logger. */
  logger?: Logger;
}

export interface StatusResult {
  config: AiSdlcConfig;
  recentRuns: Array<{
    runId: string;
    issueNumber?: number;
    status: string;
    startedAt?: string;
  }>;
}

export interface HealthResult {
  configValid: boolean;
  stateStoreConnected: boolean;
  errors: string[];
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private _state?: StateStore;
  private log: Logger;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.log = config.logger ?? createLogger();

    if (config.statePath) {
      this._state = StateStore.open(config.statePath);
    }
  }

  /**
   * Run the full pipeline for a single issue.
   */
  async run(issueNumber: number, overrides?: Partial<ExecuteOptions>): Promise<PipelineResult> {
    const runId = `run-${Date.now()}-${issueNumber}`;
    const startedAt = new Date().toISOString();

    // Record pipeline start in state store
    if (this._state) {
      this._state.savePipelineRun({
        runId,
        issueNumber,
        pipelineType: 'execute',
        status: 'running',
        currentStage: 'init',
      });
    }

    try {
      const result = await executePipeline(issueNumber, {
        configDir: this.config.configDir,
        workDir: this.config.workDir,
        runner: this.config.runner,
        security: this.config.security,
        logger: this.log,
        ...overrides,
      });

      // Record success in state store
      if (this._state) {
        this._state.updatePipelineRunStatus(runId, 'completed', {
          result: JSON.stringify({
            prUrl: result.prUrl,
            filesChanged: result.filesChanged.length,
            promotionEligible: result.promotionEligible,
          }),
        });
        this._state.saveEpisodicRecord({
          issueNumber,
          pipelineType: 'execute',
          outcome: 'success',
          filesChanged: result.filesChanged.length,
        });
      }

      return result;
    } catch (err) {
      // Record failure in state store
      if (this._state) {
        this._state.updatePipelineRunStatus(runId, 'failed', {
          result: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        });
        this._state.saveEpisodicRecord({
          issueNumber,
          pipelineType: 'execute',
          outcome: 'failure',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  /**
   * Start watch mode — continuous reconciliation loop.
   */
  async start(options?: Partial<WatchOptions>): Promise<WatchHandle> {
    return startWatch({
      executeOptions: {
        runner: this.config.runner,
        security: this.config.security,
        logger: this.log,
      },
      ...options,
    });
  }

  /**
   * Fix a failing CI run on an agent-created PR.
   */
  async fixCI(prNumber: number, runId: number, overrides?: Partial<FixCIOptions>): Promise<void> {
    return executeFixCI(prNumber, runId, {
      configDir: this.config.configDir,
      workDir: this.config.workDir,
      runner: this.config.runner,
      security: this.config.security,
      logger: this.log,
      ...overrides,
    });
  }

  /**
   * Get pipeline status, optionally filtered by issue number.
   */
  async status(issueNumber?: number): Promise<StatusResult> {
    const configDir = this.config.configDir ?? `${this.config.workDir ?? '.'}/.ai-sdlc`;
    const config = loadConfig(configDir);

    const recentRuns = this._state
      ? this._state.getPipelineRuns(issueNumber, 10).map((r) => ({
          runId: r.runId,
          issueNumber: r.issueNumber,
          status: r.status,
          startedAt: r.startedAt,
        }))
      : [];

    return { config, recentRuns };
  }

  /**
   * Health check — validates config, state store, and adapter connectivity.
   */
  async health(): Promise<HealthResult> {
    const errors: string[] = [];
    let configValid = false;
    const stateStoreConnected = !!this._state;

    try {
      const configDir = this.config.configDir ?? `${this.config.workDir ?? '.'}/.ai-sdlc`;
      loadConfig(configDir);
      configValid = true;
    } catch (err) {
      errors.push(`Config: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { configValid, stateStoreConnected, errors };
  }

  /**
   * Analyze the codebase and return a CodebaseProfile.
   * Caches the result in the state store if available.
   */
  async analyze(options?: { force?: boolean }): Promise<CodebaseProfile> {
    const workDir = this.config.workDir ?? process.cwd();

    // Check cache (24h) unless forced
    if (!options?.force && this._state) {
      const cached = this._state.getLatestComplexityProfile(workDir);
      if (cached?.analyzedAt) {
        const age = Date.now() - new Date(cached.analyzedAt).getTime();
        if (age < 24 * 60 * 60 * 1000 && cached.architecturalPatterns) {
          // Return reconstructed profile from cached data
          return {
            repoPath: cached.repoPath,
            score: cached.score,
            filesCount: cached.filesCount ?? 0,
            modulesCount: cached.modulesCount ?? 0,
            dependencyCount: cached.dependencyCount ?? 0,
            modules: [],
            moduleGraph: cached.moduleGraph ? JSON.parse(cached.moduleGraph) : { modules: [], edges: [], externalDependencies: [], cycles: [] },
            architecturalPatterns: cached.architecturalPatterns ? JSON.parse(cached.architecturalPatterns) : [],
            hotspots: cached.hotspots ? JSON.parse(cached.hotspots) : [],
            conventions: cached.conventionsData ? JSON.parse(cached.conventionsData) : [],
            analyzedAt: cached.analyzedAt,
          };
        }
      }
    }

    const profile = await analyzeCodebase({ repoPath: workDir });

    // Persist to state store
    if (this._state) {
      this._state.saveCodebaseProfile({
        repoPath: profile.repoPath,
        score: profile.score,
        filesCount: profile.filesCount,
        modulesCount: profile.modulesCount,
        dependencyCount: profile.dependencyCount,
        architecturalPatterns: JSON.stringify(profile.architecturalPatterns),
        hotspots: JSON.stringify(profile.hotspots),
        moduleGraph: JSON.stringify(profile.moduleGraph),
        conventionsData: JSON.stringify(profile.conventions),
      });

      // Save individual hotspot records
      for (const hotspot of profile.hotspots) {
        this._state.saveHotspot({
          repoPath: workDir,
          filePath: hotspot.filePath,
          churnRate: hotspot.churnRate,
          complexity: hotspot.complexity,
          commitCount: hotspot.commitCount,
        });
      }
    }

    return profile;
  }

  /**
   * Get agent roster with autonomy levels and performance.
   */
  async agents(): Promise<AutonomyLedgerEntry[]> {
    if (!this._state) return [];
    // Get all agents from the autonomy ledger
    // Since we don't have a listAll method, we'll query known agents
    const entries: AutonomyLedgerEntry[] = [];
    const rows = this._state['db']
      .prepare('SELECT * FROM autonomy_ledger ORDER BY agent_name')
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      entries.push({
        id: row.id as number,
        agentName: row.agent_name as string,
        currentLevel: row.current_level as number,
        totalTasks: row.total_tasks as number,
        successCount: row.success_count as number,
        failureCount: row.failure_count as number,
        lastTaskAt: row.last_task_at as string | undefined,
        metrics: row.metrics as string | undefined,
      });
    }
    return entries;
  }

  /**
   * Get routing decision history.
   */
  async routing(options?: { limit?: number }): Promise<RoutingDecision[]> {
    if (!this._state) return [];
    return this._state.getRoutingHistory(options?.limit ?? 50);
  }

  /**
   * Get codebase complexity profile as CodebaseContext.
   */
  async complexity(options?: { analyze?: boolean }): Promise<{ profile: CodebaseProfile; context: CodebaseContext }> {
    const profile = await this.analyze({ force: options?.analyze });
    const context = buildCodebaseContext(profile);
    return { profile, context };
  }

  /**
   * Access the state store directly.
   */
  get state(): StateStore | undefined {
    return this._state;
  }

  /**
   * Clean up resources.
   */
  close(): void {
    this._state?.close();
  }
}
