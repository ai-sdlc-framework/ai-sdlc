/**
 * Staged rollout controller — manages canary, blue-green, and rolling
 * deployment strategies with auto-rollback on metric degradation.
 */

import type {
  RolloutControllerConfig,
  RolloutStatus,
  RolloutPhase,
  CanaryConfig,
  BlueGreenConfig,
} from './rollout-types.js';
import type { DeploymentResult } from './types.js';

export class RolloutController {
  private config: RolloutControllerConfig;
  private status: RolloutStatus;
  private _paused = false;
  private _aborted = false;

  constructor(config: RolloutControllerConfig) {
    this.config = config;
    this.status = {
      id: `rollout-${Date.now()}`,
      deploymentId: '',
      phase: 'pending',
      currentStep: 0,
      currentWeightPercent: 0,
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Execute the full rollout for a given version and environment.
   */
  async execute(version: string, environment: string): Promise<RolloutStatus> {
    try {
      // Deploy the new version
      const deployment = await this.config.target.deploy(version, environment);
      this.status.deploymentId = deployment.id;

      if (deployment.state === 'failed') {
        return this.fail(`Deployment failed: ${deployment.error ?? 'unknown'}`);
      }

      this.setPhase('progressing');

      switch (this.config.strategy.type) {
        case 'canary':
          return await this.executeCanary(deployment);
        case 'blue-green':
          return await this.executeBlueGreen(deployment);
        case 'rolling':
          return await this.executeRolling(deployment);
        default:
          return this.fail(`Unknown strategy type`);
      }
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Get the current rollout status.
   */
  getStatus(): RolloutStatus {
    return { ...this.status };
  }

  /**
   * Pause the rollout at the current step.
   */
  pause(): void {
    this._paused = true;
    this.setPhase('paused');
  }

  /**
   * Resume a paused rollout.
   */
  resume(): void {
    this._paused = false;
    this.setPhase('progressing');
  }

  /**
   * Abort the rollout and trigger rollback.
   * The actual rollback is performed by the executing strategy loop
   * which detects the _aborted flag.
   */
  abort(): void {
    this._aborted = true;
  }

  // ── Canary strategy ─────────────────────────────────────────────

  private async executeCanary(deployment: DeploymentResult): Promise<RolloutStatus> {
    const strategy = this.config.strategy as CanaryConfig;

    for (let i = 0; i < strategy.steps.length; i++) {
      if (this._aborted) return this.triggerRollback('Manual abort requested');

      // Wait while paused
      while (this._paused && !this._aborted) {
        await sleep(500);
      }
      if (this._aborted) return this.triggerRollback('Manual abort requested');

      const step = strategy.steps[i];
      this.status.currentStep = i;
      this.status.currentWeightPercent = step.weightPercent;
      this.setPhase('progressing');

      // Soak period — collect metrics at intervals
      this.setPhase('soaking');
      const soakEnd = Date.now() + step.soakDurationMs;

      while (Date.now() < soakEnd && !this._aborted) {
        if (this._paused) {
          await sleep(500);
          continue;
        }

        const metrics = await this.config.metricsSource.collect(deployment.id);
        this.status.metrics = metrics;

        // Check thresholds
        if (metrics.errorRate > strategy.maxErrorRate) {
          return this.triggerRollback(
            `Error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds threshold ${(strategy.maxErrorRate * 100).toFixed(1)}%`,
          );
        }
        if (metrics.latencyP95Ms > strategy.maxLatencyP95Ms) {
          return this.triggerRollback(
            `P95 latency ${metrics.latencyP95Ms}ms exceeds threshold ${strategy.maxLatencyP95Ms}ms`,
          );
        }

        // Sample every 1/5 of soak duration, minimum 100ms
        await sleep(Math.max(100, Math.floor(step.soakDurationMs / 5)));
      }

      if (this._aborted) return this.triggerRollback('Manual abort requested');
    }

    // All steps passed — complete at 100%
    this.status.currentWeightPercent = 100;
    return this.complete();
  }

  // ── Blue-green strategy ─────────────────────────────────────────

  private async executeBlueGreen(deployment: DeploymentResult): Promise<RolloutStatus> {
    const strategy = this.config.strategy as BlueGreenConfig;

    // Health check the new deployment
    this.setPhase('soaking');
    const checkEnd = Date.now() + strategy.healthCheckDurationMs;

    while (Date.now() < checkEnd && !this._aborted) {
      if (this._paused) {
        await sleep(500);
        continue;
      }

      const metrics = await this.config.metricsSource.collect(deployment.id);
      this.status.metrics = metrics;

      if (metrics.healthyInstances === 0) {
        return this.triggerRollback('No healthy instances detected');
      }

      await sleep(Math.max(100, Math.floor(strategy.healthCheckDurationMs / 5)));
    }

    if (this._aborted) return this.triggerRollback('Manual abort requested');

    // Switch traffic 0% -> 100%
    this.status.currentWeightPercent = 100;
    return this.complete();
  }

  // ── Rolling strategy ────────────────────────────────────────────

  private async executeRolling(deployment: DeploymentResult): Promise<RolloutStatus> {
    // For rolling updates, the deployment target itself handles the rollout.
    // We just monitor the health.
    this.setPhase('soaking');

    const metrics = await this.config.metricsSource.collect(deployment.id);
    this.status.metrics = metrics;

    if (metrics.healthyInstances === 0) {
      return this.triggerRollback('No healthy instances after rolling update');
    }

    this.status.currentWeightPercent = 100;
    return this.complete();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private setPhase(phase: RolloutPhase): void {
    this.status.phase = phase;
    this.config.onPhaseChange?.(this.getStatus());
  }

  private complete(): RolloutStatus {
    this.status.phase = 'completed';
    this.status.completedAt = new Date().toISOString();
    this.config.onPhaseChange?.(this.getStatus());
    return this.getStatus();
  }

  private fail(error: string): RolloutStatus {
    this.status.phase = 'failed';
    this.status.error = error;
    this.status.completedAt = new Date().toISOString();
    this.config.onPhaseChange?.(this.getStatus());
    return this.getStatus();
  }

  private async triggerRollback(reason: string): Promise<RolloutStatus> {
    this.config.onAutoRollback?.(this.getStatus(), reason);

    try {
      await this.config.target.rollback(this.status.deploymentId);
    } catch {
      // Rollback itself failed — still mark as rolled-back with error
    }

    this.status.phase = 'rolled-back';
    this.status.error = reason;
    this.status.completedAt = new Date().toISOString();
    this.config.onPhaseChange?.(this.getStatus());
    return this.getStatus();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
