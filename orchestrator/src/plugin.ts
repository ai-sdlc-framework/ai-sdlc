/**
 * Orchestrator plugin interface — extension points for enterprise hooks.
 *
 * Plugins can intercept pipeline lifecycle events (before/after run, errors)
 * and are initialized with shared context (state store, cost tracker, etc.).
 */

import type { StateStore } from './state/index.js';
import type { CostTracker } from './cost-tracker.js';
import type { AutonomyTracker } from './autonomy-tracker.js';
import type { Logger } from './logger.js';
import type { PipelineResult } from './execute.js';
import type { NotificationRouter } from './notifications/notification-router.js';

export interface PluginContext {
  store?: StateStore;
  costTracker?: CostTracker;
  autonomyTracker?: AutonomyTracker;
  notificationRouter?: NotificationRouter;
  log: Logger;
}

export interface BeforeRunEvent {
  runId: string;
  issueId: string;
  /** @deprecated Use `issueId` instead. */
  issueNumber?: number;
  startedAt: string;
}

export interface AfterRunEvent {
  runId: string;
  issueId: string;
  /** @deprecated Use `issueId` instead. */
  issueNumber?: number;
  result: PipelineResult;
  durationMs: number;
}

export interface RunErrorEvent {
  runId: string;
  issueId: string;
  /** @deprecated Use `issueId` instead. */
  issueNumber?: number;
  error: Error;
  durationMs: number;
}

export interface OrchestratorPlugin {
  name: string;
  initialize?(context: PluginContext): void | Promise<void>;
  beforeRun?(event: BeforeRunEvent): void | Promise<void>;
  afterRun?(event: AfterRunEvent): void | Promise<void>;
  onError?(event: RunErrorEvent): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}
