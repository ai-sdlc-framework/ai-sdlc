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
