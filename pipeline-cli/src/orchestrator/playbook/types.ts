/**
 * Shared types for the autonomous-orchestrator failure playbook
 * (RFC-0015 Phase 2 / AISDLC-169.2).
 *
 * The playbook codifies the §5.1 failure taxonomy. Every catalogued mode
 * is one TypeScript module under `./handlers/<mode>.ts` that exports a
 * `Handler<Context>` value. The `playbook-runner` walks the registry
 * (`./registry.ts`) in priority order, dispatches the first handler whose
 * `detect(ctx)` matches, and applies its `remediate(ctx)` up to `budget`
 * attempts before falling back to the catch-all `UnknownFailureMode`
 * escalation (RFC §13 Q8).
 *
 * Phase 2 keeps the contract small + explicit:
 *   - No global state writes (RFC §13 Q4 audit checklist).
 *   - Every state transition emits a `WorkerStateTransition` event so the
 *     Phase 4 `events.jsonl` writer (AISDLC-169.4) gets a concrete payload
 *     shape to plumb through.
 *   - The `Handler.escalate` hook is OPTIONAL — most modes terminate via
 *     the playbook-runner's generic `needs-human-attention` escalation
 *     once the budget is exhausted; modes that need a custom escalation
 *     (e.g. `LongRunningPRBlocksWorker` parking the worker without a PR
 *     label) override it.
 */

import type { PipelineResult } from '../../types.js';

// ── Failure modes (RFC-0015 §5.1) ─────────────────────────────────────

/**
 * The 8 modes from §5.1 + `StackedPRBaseSquashed` (added post-iteration
 * via Q9). `UnknownFailureMode` is the conservative fall-through staked
 * out by Phase 1 (RFC §13 Q8) and re-used here for any failure that does
 * not match a catalogued detection signal.
 */
export type FailureMode =
  | 'SecretScanBlocked'
  | 'PushRaceWithMergeQueue'
  | 'RebaseConflict'
  | 'VerificationFailure'
  | 'ReviewerMajorOrCritical'
  | 'EnvHookFailure'
  | 'AttestationVerifyMismatch'
  | 'LongRunningPRBlocksWorker'
  | 'StackedPRBaseSquashed'
  | 'UnknownFailureMode';

// ── Worker state machine (RFC-0015 §5.2) ──────────────────────────────

/**
 * Worker states from §5.2. Each transition emits a `WorkerStateTransition`
 * event. The orchestrator never persists this for resume (RFC §13 Q2 —
 * stateless + idempotent finalize); the per-worker JSON file is
 * forensic-only and feeds Phase 4's `cli-status --orchestrator` view.
 */
export type WorkerState =
  | 'DEV_RUNNING'
  | 'REVIEW_RUNNING'
  | 'FINALIZING'
  | 'ITERATE_DEV'
  | 'REMEDIATE_SECRETSCAN'
  | 'REMEDIATE_PUSH_RACE'
  | 'REMEDIATE_REBASE'
  | 'REMEDIATE_VERIFICATION'
  | 'REMEDIATE_REVIEW'
  | 'REMEDIATE_ENV_HOOK'
  | 'REMEDIATE_ATTESTATION'
  | 'REMEDIATE_STACKED_PR'
  | 'SLEEP_RETRY'
  | 'PARKED'
  | 'NEEDS_HUMAN_ATTENTION'
  | 'DONE'
  | 'DONE_WITH_FLAG';

/** Per-mode → REMEDIATE state mapping. Centralised so the runner doesn't grow a switch. */
export const MODE_TO_REMEDIATE_STATE: Record<FailureMode, WorkerState> = {
  SecretScanBlocked: 'REMEDIATE_SECRETSCAN',
  PushRaceWithMergeQueue: 'REMEDIATE_PUSH_RACE',
  RebaseConflict: 'REMEDIATE_REBASE',
  VerificationFailure: 'REMEDIATE_VERIFICATION',
  ReviewerMajorOrCritical: 'REMEDIATE_REVIEW',
  EnvHookFailure: 'REMEDIATE_ENV_HOOK',
  AttestationVerifyMismatch: 'REMEDIATE_ATTESTATION',
  LongRunningPRBlocksWorker: 'PARKED',
  StackedPRBaseSquashed: 'REMEDIATE_STACKED_PR',
  UnknownFailureMode: 'NEEDS_HUMAN_ATTENTION',
};

/** Stable ordering of the 9 catalogued modes — registry priority. */
export const CATALOGUED_MODES: readonly FailureMode[] = [
  // High-precedence: explicit shape signals from git/gh push output.
  'SecretScanBlocked',
  'PushRaceWithMergeQueue',
  'StackedPRBaseSquashed',
  'RebaseConflict',
  // Verification + review remediation — re-spawn dev with feedback.
  'VerificationFailure',
  'ReviewerMajorOrCritical',
  // Environment + attestation — narrower trigger shapes.
  'EnvHookFailure',
  'AttestationVerifyMismatch',
  // Time-based — only matches when worker carries an aged PR.
  'LongRunningPRBlocksWorker',
] as const;

// ── Worker context ────────────────────────────────────────────────────

/**
 * Snapshot of a worker's runtime state at the moment a failure surfaces.
 *
 * The handler ONLY reads from this; the runner is responsible for
 * mutating the worker (via the injected `WorkerRunner` adapter) so
 * handlers stay pure-functional + trivially testable.
 */
export interface WorkerContext {
  workerId: string;
  taskId: string;
  /** Branch name the worker is operating on. Always scoped per-worker per RFC §13 Q4. */
  branch: string;
  /** Worktree path — every git/gh call must run inside this dir. */
  worktreePath: string;
  /** Current state machine state. */
  state: WorkerState;
  /** PR URL if a PR has been opened (null pre-push). */
  prUrl: string | null;
  /**
   * Captured failure signal — usually stderr from the failing command +
   * an exit code. The handler's `detect` runs against this verbatim.
   */
  failure: FailureSignal;
  /**
   * Per-mode remediation attempt count (NOT total iterations — only
   * counts THIS mode's retries). Reset by the runner when a remediation
   * succeeds and the worker progresses to a different state.
   */
  attempts: number;
  /** Wall-clock when the worker was first dispatched. Used by `LongRunningPRBlocksWorker`. */
  dispatchedAt: string;
}

/**
 * Captured failure context the handler matches against. Sourced from
 * `executePipeline()`'s exception path or from a polling check (e.g.
 * `LongRunningPRBlocksWorker` reads PR age, not stderr).
 */
export interface FailureSignal {
  /** Free-form stderr / log capture. May be empty for time-based modes. */
  stderr: string;
  /** Exit code from the failing command, when available. */
  exitCode: number | null;
  /** Optional categorical hint the producer can stamp (e.g. `gh-push`, `pre-commit-hook`). */
  source?: string;
  /**
   * Optional PR review verdict counts — populated when the failure is a
   * reviewer flag, not a process exit. Lets `ReviewerMajorOrCritical`
   * detect without parsing stderr.
   */
  reviewerFindings?: { critical: number; major: number; minor: number; suggestion: number };
  /**
   * Optional age-since-push (ms). Populated for `LongRunningPRBlocksWorker`
   * polling checks; absent for command-failure modes.
   */
  prAgeMs?: number;
  /**
   * Optional path-set from the failing diff — feeds `EnvHookFailure`'s
   * "data-only?" gate (skip `--no-verify` if any source files changed).
   */
  changedPaths?: readonly string[];
  /**
   * Optional base-PR mergedAt timestamp. Populated for `StackedPRBaseSquashed`
   * polling; lets the detector confirm the upstream PR landed via squash/rebase.
   */
  basePrMergedAt?: string | null;
  /** Optional `mergeStateStatus` from `gh pr view` — informs DIRTY-state checks. */
  mergeStateStatus?: string;
}

// ── Handler contract ──────────────────────────────────────────────────

export type RemediationStatus = 'recovered' | 'retry' | 'budget-exhausted' | 'inapplicable';

export interface RemediationOutcome {
  status: RemediationStatus;
  /** New worker state after remediation (runner uses this to emit transitions). */
  nextState?: WorkerState;
  /** Human-readable note included in the `RemediationApplied` / `RemediationFailed` event. */
  note?: string;
  /**
   * When `status === 'recovered'`, the optional pipeline result the worker
   * produced after remediation. Lets the runner promote a recovered worker
   * straight to `DONE` without re-dispatching the whole pipeline.
   */
  result?: PipelineResult;
}

/**
 * Per-mode handler contract. Every catalogued mode under
 * `./handlers/<mode>.ts` exports a value of this shape.
 */
export interface Handler {
  /** Mode this handler covers. Must match `FailureMode`. */
  readonly mode: FailureMode;
  /** Default per-worker retry budget. Overridable via the YAML catalogue. */
  readonly budget: number;
  /**
   * Detection predicate. Pure function over the failure signal — no I/O.
   * Returns true iff this handler claims the failure.
   */
  detect(ctx: WorkerContext): boolean;
  /**
   * Remediation step. Allowed to do bounded I/O (git/gh inside the
   * worker's worktree only — RFC §13 Q4 audit rule). Returns the
   * outcome the runner uses to advance the state machine.
   *
   * MUST NOT mutate `OrchestratorConfig` or any cross-worker shared
   * state. MUST NOT call `gh` without scoping by PR number.
   */
  remediate(ctx: WorkerContext, deps: HandlerDeps): Promise<RemediationOutcome>;
  /**
   * Optional escalation hook fired when the budget is exhausted. Defaults
   * to the runner's generic `needs-human-attention` PR-label escalation
   * (RFC §13 Q1 layer A). Override for modes that need a different
   * terminal state — e.g. `LongRunningPRBlocksWorker` PARKs the worker
   * but keeps the PR clean.
   */
  escalate?(ctx: WorkerContext, deps: HandlerDeps): Promise<void>;
}

/**
 * Side-effect dependencies handlers receive. Tests pass fakes; production
 * passes the real runner + a `gh` shim. Centralising them here keeps the
 * handlers' import surface trivial.
 */
export interface HandlerDeps {
  /** Generic command runner (git, gh, pnpm, etc.). */
  runner: import('../../runtime/exec.js').Runner;
  /** Sleep helper — tests inject sync resolve. */
  sleep: (ms: number) => Promise<void>;
  /**
   * Re-dispatch the worker's pipeline (e.g. after re-spawning the dev
   * agent with combined feedback). Tests inject a fake; production wraps
   * the orchestrator's `DispatchFn`.
   */
  redispatch?: (taskId: string) => Promise<PipelineResult>;
  /** Logger — handlers should keep noise low; the events.jsonl bus is the canonical surface. */
  logger: import('../../types.js').PipelineLogger;
}

// ── Events (Phase 4 will write these to events.jsonl) ─────────────────

/**
 * Event emitted on every state-machine transition. Phase 2 emits these in
 * memory (returned from the runner); Phase 4 wires them into `events.jsonl`.
 * The schema mirrors RFC §7.1 so the future writer is a thin adapter.
 */
export interface WorkerStateTransitionEvent {
  ts: string;
  workerId: string;
  taskId: string;
  event: 'WorkerStateTransition';
  from: WorkerState;
  to: WorkerState;
  duration_ms: number;
  context?: Record<string, unknown>;
}

export interface RemediationAppliedEvent {
  ts: string;
  workerId: string;
  taskId: string;
  event: 'RemediationApplied';
  mode: FailureMode;
  attempt: number;
  outcome: RemediationStatus;
  note?: string;
}

export interface RemediationFailedEvent {
  ts: string;
  workerId: string;
  taskId: string;
  event: 'RemediationFailed';
  mode: FailureMode;
  attempts: number;
  reason: string;
}

export interface WorkerParkedEvent {
  ts: string;
  workerId: string;
  taskId: string;
  event: 'WorkerParked';
  prUrl: string | null;
  reason: string;
}

export type PlaybookEvent =
  | WorkerStateTransitionEvent
  | RemediationAppliedEvent
  | RemediationFailedEvent
  | WorkerParkedEvent;

// ── Per-worker state file (Phase 4 forensic surface) ──────────────────

/**
 * On-disk per-worker state, persisted to
 * `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` on every
 * transition. Per RFC §13 Q2 this is forensic-only — NOT used for resume.
 * Phase 4's `cli-status --orchestrator` view consumes this file.
 */
export interface PersistedWorkerState {
  workerId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  state: WorkerState;
  dispatchedAt: string;
  updatedAt: string;
  /** Last N transitions — capped to keep the file tight. */
  history: Array<{
    ts: string;
    from: WorkerState;
    to: WorkerState;
    note?: string;
  }>;
  /** Last failure (if any) for forensic trace. */
  lastFailure?: {
    mode: FailureMode;
    attempts: number;
    reason: string;
  };
}
