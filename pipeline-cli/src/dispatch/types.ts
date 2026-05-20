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
