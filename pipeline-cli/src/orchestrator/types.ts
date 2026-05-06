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
  /**
   * RFC-0015 / AISDLC-179 — `OrchestratorTaskAlreadyInFlight` events for
   * candidates the in-flight filter rejected this tick. Empty array on
   * ticks where no candidate clashed with an in-flight dispatch.
   * Surfaces in-process so tests + callers can assert the filter fired
   * without grepping events.jsonl; the loop also forwards these events
   * to the on-disk events bus.
   */
  alreadyInFlight: OrchestratorTaskAlreadyInFlightEvent[];
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
 * AISDLC-223 adds `OrchestratorTaskBlocked` for operator-blocked tasks.
 */
export type OrchestratorBlockedEvent =
  | OrchestratorBlockedByDependencyEvent
  | OrchestratorBlockedByDorEvent
  | OrchestratorAwaitingExternalEvent
  | OrchestratorOrphanParentEvent
  | OrchestratorTaskBlockedEvent;

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
 * AISDLC-223 — emitted on every tick that the `Blocked` admission filter
 * rejects a candidate. The task has a non-empty `blocked.reason`
 * frontmatter field — it is ready by all other criteria but the operator
 * has put it on hold until the unblocking condition clears.
 */
export interface OrchestratorTaskBlockedEvent {
  type: 'TaskBlocked';
  ts: string;
  taskId: string;
  /** The value of `blocked.reason` — the operator-supplied hold reason. */
  reason: string;
  /**
   * Advisory ISO date after which the operator should re-evaluate the
   * block. Mirrors `blocked.until` when present.
   */
  until?: string;
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
 * RFC-0015 / AISDLC-179 — emitted when the pre-dispatch filter rejects a
 * candidate because the task is already in-flight (either from an earlier
 * tick in this orchestrator process, or from a previous process whose
 * worktree sentinel was reconstructed on cold start). Lets operators
 * correlate the rejected re-dispatch attempt with the original dispatch's
 * `OrchestratorDispatched` event via `startedAt`.
 */
export interface OrchestratorTaskAlreadyInFlightEvent {
  type: 'OrchestratorTaskAlreadyInFlight';
  ts: string;
  taskId: string;
  /** ISO-8601 timestamp the existing in-flight dispatch was claimed. */
  startedAt: string;
}

/**
 * AISDLC-177 — emitted after a failed dispatch when the orchestrator has
 * undone the side-effects Step 4 introduced (status flip + per-worktree
 * sentinel + worktree directory). The payload tells the operator exactly
 * what was reverted so a forensic dive into events.jsonl can reconstruct
 * the cleanup without grepping disk.
 *
 * Fired on `developer-failed`, `developer-json-contract-violated`, and
 * any future failure outcome that left a Step 4 side-effect on disk.
 * NOT fired when the dispatch never claimed a worktree (e.g.
 * `task-already-in-flight` rejection — there's nothing to roll back).
 */
export interface OrchestratorRollbackEvent {
  type: 'OrchestratorRollback';
  ts: string;
  taskId: string;
  /** Task status before Step 4 flipped it (typically `To Do`). */
  fromStatus: string;
  /**
   * Status the orchestrator INTENDED to restore the task to (mirrors
   * `fromStatus`). NOTE: this field reports intent, not the on-disk
   * reality. Consult `statusReverted` (AISDLC-186) to know whether the
   * task file was actually patched.
   */
  toStatus: string;
  /**
   * AISDLC-186 — true when the task file's `status:` line was
   * successfully patched back to `fromStatus`; false when the rollback
   * could not write the file (task file disappeared, frontmatter
   * unparseable, disk error). Pre-186 the event payload had no such
   * field and partial failures only surfaced via `logger.warn`.
   */
  statusReverted: boolean;
  /** True when `git worktree remove --force <path>` succeeded. */
  worktreeRemoved: boolean;
  /** True when the dev's branch had commits we preserved as a quarantine ref. */
  branchQuarantined: boolean;
  /**
   * Quarantine ref name (e.g.
   * `quarantine/aisdlc-70-2026-05-04T14-23-44-123`); set when
   * `branchQuarantined`. AISDLC-186 — the timestamp suffix carries
   * millisecond precision; legacy second-precision refs from pre-186
   * rollbacks (`...T14-23-44`) co-exist with the new format.
   */
  quarantineRef?: string;
}

/**
 * AISDLC-177 — companion event to `OrchestratorRollback`, fired only when
 * the developer's branch carried commits beyond `origin/main` AND the
 * orchestrator successfully renamed the branch under `quarantine/<ref>`.
 * Operators can grep for this event type to see every preserved-but-
 * abandoned dev attempt without parsing the larger rollback payloads.
 */
export interface OrchestratorWorkQuarantinedEvent {
  type: 'OrchestratorWorkQuarantined';
  ts: string;
  taskId: string;
  /** Original branch name the dev was working on. */
  branch: string;
  /** Quarantine ref name the orchestrator created. */
  quarantineRef: string;
  /** SHA of the tip commit preserved under the quarantine ref. */
  commitSha: string;
  /** Number of commits beyond origin/main on the quarantined branch. */
  commitCount: number;
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
  /**
   * AISDLC-223 — tasks that are in the dispatchable frontier (ready by
   * all criteria) but currently blocked by the operator via
   * `blocked.reason` frontmatter. Empty array when no tasks are blocked.
   * Each entry mirrors the `blocked:` frontmatter so operators can see
   * the full blocked queue without parsing events.jsonl.
   */
  blocked: Array<{ taskId: string; reason: string; until?: string }>;
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
