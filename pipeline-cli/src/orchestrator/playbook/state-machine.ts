/**
 * Worker state-machine tracker (RFC-0015 §5.2 + §13 Q2).
 *
 * One `WorkerStateTracker` per dispatched worker. Records every
 * transition as a `WorkerStateTransitionEvent` (returned in-memory in
 * Phase 2; Phase 4 plumbs them into `events.jsonl`) and persists the
 * worker's current state + a bounded transition history to
 * `$ARTIFACTS_DIR/_orchestrator/workers/<worker-id>.state.json` for
 * forensics + the future `cli-status --orchestrator` view.
 *
 * Per RFC §13 Q2, the persisted file is NOT consulted for resume —
 * startup re-derives state from the frontier + git + gh. Persistence is
 * purely a forensic + observability concern.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  FailureMode,
  PersistedWorkerState,
  PlaybookEvent,
  WorkerState,
  WorkerStateTransitionEvent,
} from './types.js';

export interface StateTrackerOpts {
  workerId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  /** Initial state — defaults to DEV_RUNNING (the entry edge of §5.2). */
  initialState?: WorkerState;
  /** Override `Date.now()` (tests). */
  now?: () => Date;
  /** Override the artifacts directory. Falls back to env then ./artifacts. */
  artifactsDir?: string;
  /** When true, suppress on-disk writes (tests that don't care about persistence). */
  inMemoryOnly?: boolean;
  /** Cap on history length to keep the file bounded. */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 64;

export class WorkerStateTracker {
  readonly workerId: string;
  readonly taskId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly dispatchedAt: string;

  private state: WorkerState;
  private readonly history: PersistedWorkerState['history'] = [];
  private readonly events: PlaybookEvent[] = [];
  private lastTransitionAt: number;
  private readonly now: () => Date;
  private readonly artifactsDir: string | null;
  private readonly inMemoryOnly: boolean;
  private readonly historyLimit: number;
  private lastFailure?: PersistedWorkerState['lastFailure'];

  constructor(opts: StateTrackerOpts) {
    this.workerId = opts.workerId;
    this.taskId = opts.taskId;
    this.branch = opts.branch;
    this.worktreePath = opts.worktreePath;
    this.now = opts.now ?? ((): Date => new Date());
    this.dispatchedAt = this.now().toISOString();
    this.state = opts.initialState ?? 'DEV_RUNNING';
    this.lastTransitionAt = this.now().getTime();
    this.artifactsDir = opts.inMemoryOnly
      ? null
      : (opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts'));
    this.inMemoryOnly = !!opts.inMemoryOnly;
    this.historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.persist();
  }

  /** Current state. */
  get currentState(): WorkerState {
    return this.state;
  }

  /** All emitted events in chronological order. */
  get emittedEvents(): readonly PlaybookEvent[] {
    return this.events;
  }

  /** All recorded transitions (capped by `historyLimit`). */
  get transitionHistory(): readonly PersistedWorkerState['history'][number][] {
    return this.history;
  }

  /** Path the persisted state file lives at (null when `inMemoryOnly`). */
  get persistencePath(): string | null {
    if (!this.artifactsDir) return null;
    return join(this.artifactsDir, '_orchestrator', 'workers', `${this.workerId}.state.json`);
  }

  /**
   * Transition the worker into a new state. Emits a `WorkerStateTransition`
   * event + persists to disk. No-ops when `to === currentState` so callers
   * can call this idempotently from inside a remediation loop.
   */
  transition(
    to: WorkerState,
    context?: Record<string, unknown>,
  ): WorkerStateTransitionEvent | null {
    if (to === this.state) return null;
    const tsDate = this.now();
    const ts = tsDate.toISOString();
    const durationMs = tsDate.getTime() - this.lastTransitionAt;
    const event: WorkerStateTransitionEvent = {
      ts,
      workerId: this.workerId,
      taskId: this.taskId,
      event: 'WorkerStateTransition',
      from: this.state,
      to,
      duration_ms: durationMs,
      context,
    };
    this.events.push(event);
    this.history.push({
      ts,
      from: this.state,
      to,
      note: typeof context?.note === 'string' ? context.note : undefined,
    });
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.state = to;
    this.lastTransitionAt = tsDate.getTime();
    this.persist();
    return event;
  }

  /** Stamp + persist the last failure for forensics. Does NOT change state. */
  recordFailure(mode: FailureMode, attempts: number, reason: string): void {
    this.lastFailure = { mode, attempts, reason };
    this.persist();
  }

  /** Append a non-transition event (Remediation*, WorkerParked, etc.). */
  emit(event: PlaybookEvent): void {
    this.events.push(event);
  }

  /** Snapshot the state for the Phase 4 `cli-status --orchestrator` view. */
  snapshot(): PersistedWorkerState {
    return {
      workerId: this.workerId,
      taskId: this.taskId,
      branch: this.branch,
      worktreePath: this.worktreePath,
      state: this.state,
      dispatchedAt: this.dispatchedAt,
      updatedAt: this.now().toISOString(),
      history: [...this.history],
      lastFailure: this.lastFailure,
    };
  }

  /** Persist current snapshot to `<artifactsDir>/_orchestrator/workers/<id>.state.json`. */
  persist(): void {
    if (this.inMemoryOnly || !this.artifactsDir) return;
    const path = this.persistencePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(this.snapshot(), null, 2), { encoding: 'utf8' });
    } catch {
      // Persistence is forensic-only per §13 Q2 — never fail the
      // orchestrator on a write hiccup. The in-memory state is still
      // authoritative for the running tick.
    }
  }
}

/**
 * Read the persisted state file (forensic / `cli-status --orchestrator`).
 * Returns null if the file doesn't exist.
 */
export function readPersistedWorkerState(
  workerId: string,
  artifactsDir?: string,
): PersistedWorkerState | null {
  const base = artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
  const path = join(base, '_orchestrator', 'workers', `${workerId}.state.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as PersistedWorkerState;
  } catch {
    return null;
  }
}
