/**
 * Shared types for the autonomous-pipeline orchestrator (RFC-0015 Phase 1
 * extended through Phase 3).
 *
 * Phase 1 ships the bare loop + dispatch + escalation surface. Phase 3 adds
 * the pre-dispatch admission filters (dependency / DoR / external-deps),
 * the per-task stuck-candidate counter, and the global exponential-backoff
 * cadence state. Phases 4-5 extend the same shapes (events.jsonl writer,
 * soak-corpus harness).
 */

import type { PipelineOutcome, PipelineResult } from '../types.js';
import type { FilterChainResult } from './filters/types.js';

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
  /**
   * RFC-0015 Phase 2 — playbook events emitted while handling failures
   * in this tick (`WorkerStateTransition`, `RemediationApplied`,
   * `RemediationFailed`, `WorkerParked`). Phase 4 plumbs these into the
   * `events.jsonl` writer; Phase 2 returns them in-memory so callers can
   * inspect/forward without coupling to the file format.
   */
  playbookEvents?: import('./playbook/types.js').PlaybookEvent[];
  /**
   * RFC-0015 Phase 3 — per-candidate filter chain trace + Phase 3 events
   * for any candidate the chain rejected. The order matches the order in
   * which the loop walked candidates (post-priority-sort). Empty when no
   * candidates were considered (empty frontier OR `--dry-run`).
   */
  filterEvents: OrchestratorFilterEvent[];
  /**
   * RFC-0015 Phase 3 — `OrchestratorIdle*` event (one per tick when nothing
   * was dispatched; null when dispatched.length > 0). Distinguishes the
   * "no work" reason from the "off-peak" reason so operators can grep
   * events.jsonl by type once Phase 4 ships the writer.
   */
  idleEvent: OrchestratorIdleEvent | null;
  /**
   * RFC-0015 Phase 3 — global polling cadence after this tick. Reset to
   * the configured base interval on dispatch OR new-task arrival;
   * otherwise doubled per consecutive idle tick, capped at 5 min.
   */
  nextSleepSec: number;
}

/**
 * RFC-0015 Phase 3 — every candidate the chain evaluated produces one of
 * these. Admitted candidates carry `event: null`; rejected candidates carry
 * the matching `OrchestratorBlockedBy*` / `OrchestratorAwaitingExternal`
 * payload. Stuck-candidate detection (>5 ticks skipped for the same reason)
 * appends `OrchestratorStuckCandidate` to the same record.
 */
export interface OrchestratorFilterEvent {
  /** ISO timestamp of the filter run. */
  ts: string;
  /** Candidate task ID. */
  taskId: string;
  /** Full chain trace — every filter the chain walked, in order. */
  trace: FilterChainResult;
  /** Stuck-candidate event when this candidate has been skipped >5 ticks. */
  stuckEvent: OrchestratorStuckCandidateEvent | null;
  /**
   * Distinguished event derived from the chain failure (when present).
   * `null` when the chain admitted the candidate.
   */
  blockedEvent: OrchestratorBlockedEvent | null;
}

/**
 * Discriminated union for the admission-block events. Phase 4
 * (AISDLC-169.4) plumbs these into `events.jsonl`; Phase 3 surfaces them
 * in the tick result + via the logger. AISDLC-175 added the
 * `OrchestratorOrphanParent` arm for parent-task closure detection.
 */
export type OrchestratorBlockedEvent =
  | OrchestratorBlockedByDependencyEvent
  | OrchestratorBlockedByDorEvent
  | OrchestratorAwaitingExternalEvent
  | OrchestratorOrphanParentEvent;

export interface OrchestratorBlockedByDependencyEvent {
  type: 'OrchestratorBlockedByDependency';
  ts: string;
  taskId: string;
  /** Open task IDs gating dispatch (lowercased, sorted). */
  blockers: string[];
}

export interface OrchestratorBlockedByDorEvent {
  type: 'OrchestratorBlockedByDor';
  ts: string;
  taskId: string;
  /** Always `needs-clarification` in v1 (the only blocking verdict). */
  verdict: 'needs-clarification';
  /** ISO timestamp of the blocking verdict (null when unknown). */
  signedAt: string | null;
}

export interface OrchestratorAwaitingExternalEvent {
  type: 'OrchestratorAwaitingExternal';
  ts: string;
  taskId: string;
  /**
   * External deps that gated dispatch (`kind: 'manual'` AND no
   * operator-supplied clearance per the RFC §13 Q3 resolution).
   */
  externalDeps: Array<{ id: string; kind: string }>;
  /**
   * Full external-deps list (informational — non-blocking kinds are
   * surfaced here so operators see the complete picture).
   */
  allExternalDeps: Array<{ id: string; kind: string }>;
}

/**
 * AISDLC-175 — emitted when the orphan-parent filter rejects a candidate.
 * The candidate is a parent task whose every declared child is already in
 * `backlog/completed/`; the orchestrator skips it instead of dispatching a
 * developer subagent for what is bookkeeping (parent file `git mv` to
 * `completed/`) the framework should handle. Witness: AISDLC-70 (RFC-0010
 * parent with all 9 sub-tasks already in `completed/`) was incorrectly
 * dispatched on 2026-05-04 even though PR #231 had already shipped its
 * closure.
 */
export interface OrchestratorOrphanParentEvent {
  type: 'OrchestratorOrphanParent';
  ts: string;
  taskId: string;
  /**
   * IDs of the candidate's children that are all already in
   * `backlog/completed/` (lowercased, sorted). At least one entry by
   * construction — a parent with zero children is not an orphan parent.
   */
  completedChildren: string[];
}

export interface OrchestratorStuckCandidateEvent {
  type: 'OrchestratorStuckCandidate';
  ts: string;
  taskId: string;
  /** Reason from the most-recent skip — usually the failing filter name. */
  reason: string;
  /** Number of ticks since this candidate first started skipping. */
  ticksSinceFirstSkip: number;
}

/**
 * RFC-0015 Phase 3 (Q3 + Q5) — emitted on a tick that dispatched nothing.
 * The reason distinguishes "no candidates ready" from "candidates rejected
 * by filters" so operators can grep events.jsonl for the actual cause.
 */
export type OrchestratorIdleEvent =
  | { type: 'OrchestratorIdleNoWork'; ts: string; idleStreak: number }
  | { type: 'OrchestratorIdleAllFiltered'; ts: string; idleStreak: number; rejectedCount: number };

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
 * Escalation record carrying either Phase 1's `UnknownFailureMode`
 * catch-all (RFC §13 Q8) or one of the Phase 2 catalogued failure modes
 * (RFC-0015 §5.1) when the playbook runner exhausted its budget without
 * recovering. Phase 4 (AISDLC-169.4) expands this into the `events.jsonl`
 * stream; Phase 2 keeps the in-memory shape stable for downstream consumers.
 *
 * The `event` field is widened from the Phase 1 `'UnknownFailureMode'`
 * literal to the union of all catalogued modes so callers can reason
 * about which mode escalated without re-parsing `reason`.
 */
export interface EscalationRecord {
  taskId: string;
  /** ISO timestamp. */
  ts: string;
  /**
   * Failure-mode tag for the escalation. Catalogued modes ship in
   * `playbook/types.ts#FailureMode`; the Phase 1 catch-all
   * `'UnknownFailureMode'` is the conservative fall-through (Q8).
   */
  event:
    | 'UnknownFailureMode'
    | 'SecretScanBlocked'
    | 'PushRaceWithMergeQueue'
    | 'RebaseConflict'
    | 'VerificationFailure'
    | 'ReviewerMajorOrCritical'
    | 'EnvHookFailure'
    | 'AttestationVerifyMismatch'
    | 'LongRunningPRBlocksWorker'
    | 'StackedPRBaseSquashed';
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
