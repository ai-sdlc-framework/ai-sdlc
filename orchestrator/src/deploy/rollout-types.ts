/**
 * Types for staged rollout strategies (canary, blue-green, rolling).
 */

import type { DeploymentTarget } from './types.js';

// ── Strategy configurations ─────────────────────────────────────────

export interface CanaryStep {
  /** Traffic weight percentage for this step (0-100). */
  weightPercent: number;
  /** Soak duration in milliseconds before advancing. */
  soakDurationMs: number;
}

export interface CanaryConfig {
  type: 'canary';
  /** Steps defining traffic percentage progression. */
  steps: CanaryStep[];
  /** Maximum error rate (0-1) before auto-rollback. */
  maxErrorRate: number;
  /** Maximum P95 latency in milliseconds before auto-rollback. */
  maxLatencyP95Ms: number;
}

export interface BlueGreenConfig {
  type: 'blue-green';
  /** Health check duration in ms before switching traffic. */
  healthCheckDurationMs: number;
  /** Whether to keep the old version running after switch. */
  keepOldVersion?: boolean;
}

export interface RollingConfig {
  type: 'rolling';
  /** Maximum number of instances updating concurrently. */
  maxSurge: number;
  /** Maximum number of instances unavailable during update. */
  maxUnavailable: number;
}

export type RolloutStrategy = CanaryConfig | BlueGreenConfig | RollingConfig;

// ── Rollout status ──────────────────────────────────────────────────

export type RolloutPhase =
  | 'pending'
  | 'progressing'
  | 'soaking'
  | 'paused'
  | 'completed'
  | 'rolled-back'
  | 'failed';

export interface RolloutStatus {
  /** Unique rollout identifier. */
  id: string;
  /** The deployment this rollout manages. */
  deploymentId: string;
  /** Current phase. */
  phase: RolloutPhase;
  /** Current step index (for canary). */
  currentStep: number;
  /** Current traffic weight percent. */
  currentWeightPercent: number;
  /** Latest collected metrics. */
  metrics?: RolloutMetrics;
  /** Error message if failed. */
  error?: string;
  /** Start time. */
  startedAt: string;
  /** Completion time. */
  completedAt?: string;
}

export interface RolloutMetrics {
  /** Error rate (0-1). */
  errorRate: number;
  /** P95 latency in milliseconds. */
  latencyP95Ms: number;
  /** Requests per second. */
  requestsPerSecond: number;
  /** Number of healthy instances. */
  healthyInstances: number;
  /** Total instances. */
  totalInstances: number;
  /** Timestamp of collection. */
  collectedAt: string;
}

// ── Metrics source interface ────────────────────────────────────────

export interface MetricsSource {
  /** Collect current metrics for the deployment. */
  collect(deploymentId: string): Promise<RolloutMetrics>;
}

// ── Rollout controller interface ────────────────────────────────────

export interface RolloutControllerConfig {
  /** The deployment target to manage. */
  target: DeploymentTarget;
  /** Metrics collection source. */
  metricsSource: MetricsSource;
  /** Rollout strategy configuration. */
  strategy: RolloutStrategy;
  /** Callback on phase changes. */
  onPhaseChange?: (status: RolloutStatus) => void;
  /** Callback when auto-rollback is triggered. */
  onAutoRollback?: (status: RolloutStatus, reason: string) => void;
}
