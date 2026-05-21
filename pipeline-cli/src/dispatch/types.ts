/**
 * Dispatch Board protocol types (RFC-0041 §4.4).
 *
 * The Dispatch Board is a filesystem-backed queue/inflight/done/failed
 * channel that decouples the Conductor and Workers across process
 * boundaries. The Conductor writes manifests; Workers claim them atomically,
 * execute, and emit verdicts. The Conductor's pickup loop reads verdicts
 * and triggers reviewer fan-out + push + auto-merge arming.
 *
 * Phase 1 (AISDLC-377.1) ships the protocol surface + the in-session-agent
 * Worker kind. Phase 2 (AISDLC-377.3) adds the claude-p-shell supervisor.
 *
 * Schemas:
 *   - spec/schemas/dispatch-manifest.v1.schema.json
 *   - spec/schemas/dispatch-verdict.v1.schema.json
 *   - spec/schemas/dispatch-config.v1.schema.json
 */

/** Subdirectory layout under `.ai-sdlc/dispatch/`. */
export const BOARD_SUBDIRS = ['queue', 'inflight', 'done', 'failed'] as const;
export type BoardSubdir = (typeof BOARD_SUBDIRS)[number];

/** Worker backend kinds (RFC-0041 §4.3). */
export type WorkerKind = 'in-session-agent' | 'claude-p-shell';

/** What a manifest declares re: which Worker kinds may claim it. */
export type ManifestWorkerKind = WorkerKind | 'any';

/** Verdict outcome enum (matches schema). */
export type VerdictOutcome =
  | 'success'
  | 'iterate-needed'
  | 'iteration-exhausted'
  | 'failed'
  | 'quota-exhausted'
  | 'blocked';

/** Per-verification status returned by Worker (matches schema). */
export type VerificationStatus = 'passed' | 'failed' | 'skipped';

/**
 * In-memory representation of a dispatch manifest. Matches the JSON shape
 * declared by `dispatch-manifest.v1.schema.json`.
 */
export interface DispatchManifest {
  schemaVersion: 'v1';
  taskId: string;
  branch: string;
  worktree: string;
  baseSha: string;
  workerKind: ManifestWorkerKind;
  dispatchedAt: string;
  dispatchedBy: string;
  spec: {
    taskFile: string;
    model?: string;
    budgetMs?: number;
    verifyCommands: string[];
    permittedExternalPaths?: string[];
  };
  iterationsAttempted?: number;
  iterationBudget?: number;
  lastSessionId?: string;
  /**
   * RFC-0041 OQ-7 — quota-backoff gate. When set, Workers MUST refuse to
   * claim this manifest until the wall clock passes this ISO-8601 timestamp.
   */
  noClaimBefore?: string;
}

/**
 * In-memory representation of a dispatch verdict. Matches the JSON shape
 * declared by `dispatch-verdict.v1.schema.json`.
 */
export interface DispatchVerdict {
  schemaVersion: 'v1';
  taskId: string;
  outcome: VerdictOutcome;
  commitSha?: string | null;
  pushedBranch?: string | null;
  prUrl?: string | null;
  verifications?: Partial<{
    build: VerificationStatus;
    test: VerificationStatus;
    lint: VerificationStatus;
    format: VerificationStatus;
  }> & {
    [extra: string]: VerificationStatus | undefined;
  };
  acceptanceCriteriaMet?: number[];
  notes?: string;
  completedAt: string;
  workerId: string;
  workerKind?: WorkerKind;
  retryAfter?: number;
  cause?: string;
  durationMs?: number;
  /**
   * RFC-0041 Phase 1.5 (AISDLC-377.2) — total iteration cycles the Worker
   * burned to produce this verdict. First-attempt verdicts set this to 1;
   * resume-attempt verdicts set this to the prior value + 1. The Conductor
   * compares this against `manifest.iterationBudget` when an `iterate-needed`
   * verdict lands — at the cap, the Conductor writes an
   * `iteration-exhausted` diagnostic and stops triggering resumes.
   */
  iterationsAttempted?: number;
  /**
   * RFC-0041 Phase 1.5 (AISDLC-377.2) — `claude -p --session-id` captured by
   * a `claude-p-shell` Worker. The Conductor promotes this onto the next
   * iteration's manifest as `manifest.lastSessionId` so the supervisor can
   * `--resume` against the same conversation transcript. `in-session-agent`
   * Workers leave this undefined (they resume via Agent `continue: true`).
   */
  sessionId?: string;
}

/**
 * RFC-0041 Phase 1.5 (AISDLC-377.2) — resume signal written by the Conductor
 * under `inflight/<task-id>.resume.json` to trigger a Worker-driven iteration.
 * The inflight manifest stays put while the iteration runs; the resume signal
 * tells the still-alive Worker (or its supervisor-spawned successor) to
 * continue with prior conversation context + the conductor's feedback
 * prepended. See RFC-0041 §10 OQ-4 resolution.
 *
 * Schema: `spec/schemas/dispatch-resume-signal.v1.schema.json`.
 */
export interface ResumeSignal {
  schemaVersion: 'v1';
  taskId: string;
  /** Conductor-authored feedback prepended to the Worker's next-iteration prompt. */
  feedback: string;
  /** ISO-8601 timestamp the Conductor wrote the signal. */
  triggeredAt: string;
  /** Conductor identifier (e.g. `conductor-session-<uuid>`). Audit-only. */
  triggeredBy: string;
  /** `iterationsAttempted` at signal-write time. Worker emits `priorIteration + 1` on its verdict. */
  priorIteration?: number;
  /** Always `iterate-needed` in Phase 1.5 — other outcomes are not resumable. */
  priorOutcome?: 'iterate-needed';
}

/**
 * Heartbeat state co-located with the inflight manifest. Workers update
 * `inflight/<task-id>.state.json` every ~60 seconds while they're active so
 * the sweeper can distinguish "working" from "dead".
 */
export interface InflightHeartbeat {
  taskId: string;
  workerId: string;
  workerKind: WorkerKind;
  pid?: number;
  currentStep?: string;
  startedAt: string;
  lastHeartbeat: string;
}

/** Outcome of a claim attempt. */
export interface ClaimResult {
  /** True when this caller won the rename race. */
  claimed: boolean;
  /** When `claimed === true`, the path of the manifest now in `inflight/`. */
  manifestPath?: string;
  /** When `claimed === true`, the parsed manifest. */
  manifest?: DispatchManifest;
}

/** Counts returned by `peekQueue`. */
export interface QueueCounts {
  queued: number;
  inflight: number;
  done: number;
  failed: number;
}

/** Result of a stale-heartbeat sweep. */
export interface SweepResult {
  /** Manifests moved from inflight/ to failed/ during this sweep. */
  reapedTaskIds: string[];
}

/**
 * RFC-0041 Phase 1.5 (AISDLC-377.2) — default iteration budget when a manifest
 * omits `iterationBudget`. Matches RFC-0015 §5 (iterate-dev budget = 2 — one
 * original attempt + one resume). The Conductor honors this when deciding
 * whether `iterate-needed` triggers another resume.
 */
export const DEFAULT_ITERATION_BUDGET = 2;
