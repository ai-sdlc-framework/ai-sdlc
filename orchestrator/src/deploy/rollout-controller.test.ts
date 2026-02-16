import { describe, it, expect, vi } from 'vitest';
import { RolloutController } from './rollout-controller.js';
import { createStubMetricsCollector } from './metrics-collector.js';
import type { DeploymentTarget, DeploymentResult } from './types.js';
import type { CanaryConfig, BlueGreenConfig, RollingConfig, RolloutStatus } from './rollout-types.js';

function createMockTarget(deployResult?: Partial<DeploymentResult>): DeploymentTarget {
  return {
    deploy: vi.fn(async (version, env) => ({
      id: `deploy-${Date.now()}`,
      state: 'healthy' as const,
      version,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...deployResult,
    })),
    getStatus: vi.fn(async (id) => ({
      id,
      state: 'healthy' as const,
      version: 'unknown',
      startedAt: '',
    })),
    rollback: vi.fn(async (id) => ({
      id: `${id}-rollback`,
      state: 'rolled-back' as const,
      version: 'unknown',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })),
  };
}

describe('RolloutController', () => {
  describe('canary strategy', () => {
    const canaryStrategy: CanaryConfig = {
      type: 'canary',
      steps: [
        { weightPercent: 10, soakDurationMs: 50 },
        { weightPercent: 50, soakDurationMs: 50 },
        { weightPercent: 100, soakDurationMs: 50 },
      ],
      maxErrorRate: 0.05,
      maxLatencyP95Ms: 500,
    };

    it('completes canary rollout through all steps', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ errorRate: 0, latencyP95Ms: 50 });

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: canaryStrategy,
      });

      const status = await controller.execute('v2.0.0', 'production');

      expect(status.phase).toBe('completed');
      expect(status.currentWeightPercent).toBe(100);
      expect(status.completedAt).toBeTruthy();
      expect(target.deploy).toHaveBeenCalledWith('v2.0.0', 'production');
    });

    it('rolls back on high error rate', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ errorRate: 0.01 });

      const onAutoRollback = vi.fn();
      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: canaryStrategy,
        onAutoRollback,
      });

      // Set error rate above threshold during first soak
      setTimeout(() => metricsSource.setMetrics({ errorRate: 0.1 }), 20);

      const status = await controller.execute('v2.0.0', 'production');

      expect(status.phase).toBe('rolled-back');
      expect(status.error).toContain('Error rate');
      expect(target.rollback).toHaveBeenCalled();
      expect(onAutoRollback).toHaveBeenCalled();
    });

    it('rolls back on high latency', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ latencyP95Ms: 50 });

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: canaryStrategy,
      });

      // Set latency above threshold
      setTimeout(() => metricsSource.setMetrics({ latencyP95Ms: 1000 }), 20);

      const status = await controller.execute('v2.0.0', 'production');

      expect(status.phase).toBe('rolled-back');
      expect(status.error).toContain('P95 latency');
    });

    it('fires phase change callbacks', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector();
      const phases: string[] = [];

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: canaryStrategy,
        onPhaseChange: (s) => phases.push(s.phase),
      });

      await controller.execute('v1.0.0', 'production');

      expect(phases).toContain('progressing');
      expect(phases).toContain('soaking');
      expect(phases).toContain('completed');
    });

    it('handles deployment failure', async () => {
      const target = createMockTarget({ state: 'failed', error: 'image not found' });
      const metricsSource = createStubMetricsCollector();

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: canaryStrategy,
      });

      const status = await controller.execute('v-bad', 'production');

      expect(status.phase).toBe('failed');
      expect(status.error).toContain('image not found');
    });

    it('can be paused and resumed', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector();
      const phases: string[] = [];

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: {
          type: 'canary',
          steps: [{ weightPercent: 50, soakDurationMs: 200 }],
          maxErrorRate: 0.05,
          maxLatencyP95Ms: 500,
        },
        onPhaseChange: (s) => phases.push(s.phase),
      });

      // Pause briefly then resume
      setTimeout(() => controller.pause(), 30);
      setTimeout(() => controller.resume(), 80);

      const status = await controller.execute('v1.0.0', 'production');

      expect(status.phase).toBe('completed');
      expect(phases).toContain('paused');
    });

    it('can be aborted', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector();

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: {
          type: 'canary',
          steps: [{ weightPercent: 50, soakDurationMs: 2000 }],
          maxErrorRate: 0.05,
          maxLatencyP95Ms: 500,
        },
      });

      // Abort shortly after start — soak is 2s so 50ms is well within it
      setTimeout(() => controller.abort(), 50);

      const status = await controller.execute('v1.0.0', 'production');

      expect(status.phase).toBe('rolled-back');
      expect(status.error).toBe('Manual abort requested');
    });
  });

  describe('blue-green strategy', () => {
    const bgStrategy: BlueGreenConfig = {
      type: 'blue-green',
      healthCheckDurationMs: 100,
    };

    it('completes blue-green switch on healthy deployment', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ healthyInstances: 3 });

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: bgStrategy,
      });

      const status = await controller.execute('v2.0.0', 'production');

      expect(status.phase).toBe('completed');
      expect(status.currentWeightPercent).toBe(100);
    });

    it('rolls back when no healthy instances', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ healthyInstances: 0 });

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: bgStrategy,
      });

      const status = await controller.execute('v2.0.0', 'production');

      expect(status.phase).toBe('rolled-back');
      expect(status.error).toContain('No healthy instances');
      expect(target.rollback).toHaveBeenCalled();
    });
  });

  describe('rolling strategy', () => {
    const rollingStrategy: RollingConfig = {
      type: 'rolling',
      maxSurge: 1,
      maxUnavailable: 0,
    };

    it('completes rolling update with healthy instances', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ healthyInstances: 3 });

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: rollingStrategy,
      });

      const status = await controller.execute('v3.0.0', 'production');

      expect(status.phase).toBe('completed');
      expect(status.currentWeightPercent).toBe(100);
    });

    it('rolls back when no healthy instances after rolling', async () => {
      const target = createMockTarget();
      const metricsSource = createStubMetricsCollector({ healthyInstances: 0 });

      const controller = new RolloutController({
        target,
        metricsSource,
        strategy: rollingStrategy,
      });

      const status = await controller.execute('v3.0.0', 'production');

      expect(status.phase).toBe('rolled-back');
      expect(status.error).toContain('No healthy instances');
    });
  });

  describe('getStatus', () => {
    it('returns current status', () => {
      const controller = new RolloutController({
        target: createMockTarget(),
        metricsSource: createStubMetricsCollector(),
        strategy: { type: 'canary', steps: [], maxErrorRate: 0.05, maxLatencyP95Ms: 500 },
      });

      const status = controller.getStatus();

      expect(status.phase).toBe('pending');
      expect(status.currentStep).toBe(0);
      expect(status.currentWeightPercent).toBe(0);
      expect(status.id).toMatch(/^rollout-/);
    });

    it('returns a copy (not mutable reference)', () => {
      const controller = new RolloutController({
        target: createMockTarget(),
        metricsSource: createStubMetricsCollector(),
        strategy: { type: 'canary', steps: [], maxErrorRate: 0.05, maxLatencyP95Ms: 500 },
      });

      const s1 = controller.getStatus();
      s1.phase = 'completed';
      const s2 = controller.getStatus();

      expect(s2.phase).toBe('pending');
    });
  });
});
