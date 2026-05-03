/**
 * Shared types for the autonomous-pipeline orchestrator (RFC-0015 Phase 1).
 *
 * Phase 1 ships the bare loop + dispatch + escalation surface only. Phases 2-5
 * extend the same shapes (failure playbook, pre-dispatch admission filters,
 * events.jsonl writer, soak-corpus harness).
 */

import type { PipelineOutcome, PipelineResult } from '../types.js';

/** Configuration knobs for one orchestrator run. */
export interface OrchestratorConfig {
  /** Project root (defaults to process.cwd()). */
  workDir: string;
  /**
   * Polling cadence between ticks. Default 30s per RFC-0015 §4.1.
   * Phase 3 adds the exponential-backoff curve for empty/peak-blocked windows.
   */
  tickIntervalSec: number;
  /**
   * Max concurrent workers per tick. Phase 1 default 1 — RFC-0015 §11 calls
   * out single-worker for the bare loop; Phase 2+ scales to RFC-0010's tier-aware
   * default once the failure playbook is in place.
   */
  maxConcurrent: number;
  /**
   * Cap on consecutive ticks the loop will run before exiting. `null` = run
   * forever (production). Tests + cron-driven invocations set a finite value.
   */
  maxTicks: number | null;
  /** When true, dispatch never happens — used by `cli-orchestrator status`. */
  dryRun: boolean;
}

export interface OrchestratorTickResult {
  tick: number;
  /** Number of frontier candidates considered. */
  candidates: number;
  /** Number of tasks actually dispatched in this tick. */
  dispatched: string[];
  /** Per-dispatch outcomes (parallel to `dispatched`). */
  outcomes: TaskDispatchOutcome[];
  /** Any unknown-failure escalations recorded in this tick. */
  escalations: EscalationRecord[];
  /** Whether the tick saw an empty frontier. */
  empty: boolean;
}

export interface TaskDispatchOutcome {
  taskId: string;
  outcome: PipelineOutcome | 'unknown-failure';
  prUrl: string | null;
  /** When the dispatch threw, this carries the error message. */
  error?: string;
  /** Set when the result already had a `notes` field. */
  notes?: string;
}

/**
 * Phase 1 escalation record (RFC §13 Q8). Phase 4 expands this into the
 * `UnknownFailureMode` event in `events.jsonl`. For Phase 1 we keep the
 * shape collocated with the orchestrator so consumers can read it without
 * waiting on the full event-schema work.
 */
export interface EscalationRecord {
  taskId: string;
  /** ISO timestamp. */
  ts: string;
  /** `UnknownFailureMode` for Phase 1 — Phase 2 introduces catalogued modes. */
  event: 'UnknownFailureMode';
  /** Short human-readable reason — usually the exception message. */
  reason: string;
  /** Optional PR URL when escalation tagged an existing PR. */
  prUrl: string | null;
}

export interface OrchestratorStatus {
  /** Frontier as observed at status time. */
  frontier: Array<{ id: string; title: string }>;
  /** Number of ready candidates. */
  queueDepth: number;
  /** Last tick (if any) — null on cold start. */
  lastTick: OrchestratorTickResult | null;
  /** Current configuration (for operator inspection). */
  config: OrchestratorConfig;
  /** Whether the feature flag is enabled. */
  enabled: boolean;
}

/**
 * Adapter that hides the actual `executePipeline()` invocation so tests can
 * stub it without instantiating a real spawner / runner / worktree.
 */
export type DispatchFn = (taskId: string) => Promise<PipelineResult>;

/** Adapter that fetches the dispatch frontier (defaults to cli-deps frontier()). */
export type FrontierFn = () => Array<{ id: string; title: string }>;

/** Adapter that tags a PR with `needs-human-attention`. Shells out to `gh` in production. */
export type EscalateFn = (taskId: string, reason: string, prUrl: string | null) => Promise<void>;
