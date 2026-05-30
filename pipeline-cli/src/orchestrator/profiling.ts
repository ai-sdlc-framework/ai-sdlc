/**
 * Parallel-dispatch profiling instrumentation (AISDLC-479 / RFC-0014 +
 * RFC-0015).
 *
 * The orchestrator + Dispatch Board already DEFINE per-task timing fields —
 * `OrchestratorCompleted`/`OrchestratorFailed` event types in
 * `events.ts`, and `dispatchedAt`/`completedAt`/`durationMs` on the
 * dispatch-verdict schema — but pre-AISDLC-479 nothing ever CAPTURED them:
 * only `OrchestratorDispatched` (with no duration) was emitted, and Worker
 * verdicts left the three timing fields unset. The empty
 * `_estimates/calibration-YYYY-MM.jsonl` was the downstream symptom.
 *
 * This module closes the capture gap with three thin helpers built on the
 * existing `writeEvent` writer + `writeVerdict` board op:
 *
 *   - `emitTaskCompletion()` — emit an `OrchestratorCompleted` event
 *     (`taskId`, `ts`, `durationMs`, `outcome`).
 *   - `emitTaskFailure()`    — emit an `OrchestratorFailed` event.
 *   - `populateVerdictTiming()` — fill a verdict's `dispatchedAt`,
 *     `completedAt`, `durationMs` from the manifest's `dispatchedAt` + a
 *     completion clock, returning a NEW verdict (never mutates the input).
 *   - `writeTimedVerdict()`  — the composite the Worker calls: populate
 *     timing, write the verdict to the board, AND emit the matching
 *     completion/failure event in one call.
 *
 * **Gating (AC-7).** Event emission rides the existing
 * `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` gate inside `writeEvent` — when the
 * orchestrator is off, no events are written, exactly as
 * `OrchestratorDispatched` behaves today. The verdict timing fields are
 * populated unconditionally: the verdict file is written by the Worker
 * regardless of the flag, and stamping three already-schema'd fields is a
 * pure data-completeness change, not a new behaviour.
 *
 * @module orchestrator/profiling
 */

import { writeVerdict } from '../dispatch/board.js';
import type { DispatchManifest, DispatchVerdict } from '../dispatch/types.js';
import type { PipelineLogger } from '../types.js';
import { writeEvent, type WriteEventOpts } from './events.js';

// ── Outcome typing ────────────────────────────────────────────────────

/**
 * The `outcome` discriminator carried on `OrchestratorCompleted` /
 * `OrchestratorFailed` events. Mirrors the verdict outcome vocabulary so
 * the aggregator can map verdict → event without a translation table.
 * `approved` is the orchestrator-loop completion outcome the existing
 * `cli-orchestrator-corpus` aggregator already counts as a clean
 * completion (see `summariseRun`); `success` is the Dispatch-Board verdict
 * equivalent.
 */
export type TaskOutcome =
  | 'approved'
  | 'success'
  | 'iterate-needed'
  | 'iteration-exhausted'
  | 'failed'
  | 'quota-exhausted'
  | 'blocked';

/** Verdict outcomes that represent a successful completion (event = Completed). */
const COMPLETION_OUTCOMES: ReadonlySet<string> = new Set(['success', 'iterate-needed', 'approved']);

/**
 * Map a Dispatch-Board verdict outcome onto the event kind the profiling
 * stream should carry. `success` / `iterate-needed` → completion; every
 * other outcome (failed, quota-exhausted, blocked, iteration-exhausted) →
 * failure. Matches `writeVerdict`'s done/-vs-failed/ routing so the event
 * stream and the board subdir agree.
 */
export function isCompletionOutcome(outcome: string): boolean {
  return COMPLETION_OUTCOMES.has(outcome);
}

// ── Duration derivation ───────────────────────────────────────────────

/**
 * Compute `durationMs` from a manifest's `dispatchedAt` and a completion
 * timestamp. Returns `undefined` when either timestamp is unparseable or
 * the delta is negative (clock skew) — the caller leaves `durationMs`
 * unset rather than persisting a garbage value the aggregator would then
 * have to defend against.
 */
export function computeDurationMs(dispatchedAt: string, completedAt: string): number | undefined {
  const start = Date.parse(dispatchedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const delta = end - start;
  if (delta < 0) return undefined;
  return delta;
}

// ── Verdict timing population (AC-2) ──────────────────────────────────

export interface PopulateVerdictTimingOpts {
  /**
   * The manifest the verdict corresponds to. `manifest.dispatchedAt` is
   * the dispatch-time anchor copied onto the verdict's `dispatchedAt`.
   */
  manifest: DispatchManifest;
  /**
   * Override the completion clock. Tests inject a frozen clock; production
   * leaves it undefined and falls back to the verdict's existing
   * `completedAt` (set by the Worker at emit time) or `new Date()`.
   */
  now?: () => Date;
}

/**
 * Return a COPY of `verdict` with `dispatchedAt`, `completedAt`, and
 * `durationMs` populated from the manifest + completion clock. Never
 * mutates the input.
 *
 * Resolution rules:
 *   - `dispatchedAt`  ← `manifest.dispatchedAt` (always — the manifest is
 *     the authoritative dispatch anchor).
 *   - `completedAt`   ← the verdict's existing `completedAt` if already a
 *     valid ISO string, else `now().toISOString()`.
 *   - `durationMs`    ← `completedAt − dispatchedAt` via `computeDurationMs`;
 *     left unset when the delta can't be computed.
 *
 * Pre-AISDLC-479 these three fields were schema-defined but never set;
 * this is the writer that closes that gap.
 */
export function populateVerdictTiming(
  verdict: DispatchVerdict,
  opts: PopulateVerdictTimingOpts,
): DispatchVerdict {
  const now = opts.now ?? ((): Date => new Date());
  const dispatchedAt = opts.manifest.dispatchedAt;
  const existingCompletedAt =
    typeof verdict.completedAt === 'string' && !Number.isNaN(Date.parse(verdict.completedAt))
      ? verdict.completedAt
      : null;
  const completedAt = existingCompletedAt ?? now().toISOString();
  const durationMs = computeDurationMs(dispatchedAt, completedAt);

  const next: DispatchVerdict = {
    ...verdict,
    dispatchedAt,
    completedAt,
  };
  if (durationMs !== undefined) {
    next.durationMs = durationMs;
  }
  return next;
}

// ── Event emission (AC-1) ─────────────────────────────────────────────

export interface EmitTaskEventOpts extends WriteEventOpts {
  /** Task scope for the event. */
  taskId: string;
  /** Wall-clock duration in ms (claim → verdict). Omitted when unknown. */
  durationMs?: number;
  /** Outcome discriminator carried on the event. */
  outcome: TaskOutcome;
  /** Orchestrator session UUID — lets the aggregator group by run. */
  runId?: string;
  /** Tick the dispatch fired on. */
  tick?: number;
  /** Worker identifier. */
  workerId?: string;
}

/**
 * Emit an `OrchestratorCompleted` event to
 * `artifacts/_orchestrator/events-YYYY-MM-DD.jsonl` via the existing
 * `writeEvent` writer (AC-1). Returns the writer's boolean — `true` when
 * the line was appended, `false` when the orchestrator flag is off
 * (AC-7 — no behaviour change when gated off).
 */
export function emitTaskCompletion(opts: EmitTaskEventOpts): boolean {
  return writeEvent(
    {
      ts: '',
      type: 'OrchestratorCompleted',
      taskId: opts.taskId,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.tick !== undefined ? { tick: opts.tick } : {}),
      ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}),
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      outcome: opts.outcome,
    },
    eventWriterOpts(opts),
  );
}

/**
 * Emit an `OrchestratorFailed` event (AC-1). Same gating + return contract
 * as `emitTaskCompletion`.
 */
export function emitTaskFailure(opts: EmitTaskEventOpts): boolean {
  return writeEvent(
    {
      ts: '',
      type: 'OrchestratorFailed',
      taskId: opts.taskId,
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.tick !== undefined ? { tick: opts.tick } : {}),
      ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}),
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      outcome: opts.outcome,
    },
    eventWriterOpts(opts),
  );
}

/** Pull the `WriteEventOpts` subset out of the richer emit opts. */
function eventWriterOpts(opts: EmitTaskEventOpts): WriteEventOpts {
  const out: WriteEventOpts = {};
  if (opts.artifactsDir !== undefined) out.artifactsDir = opts.artifactsDir;
  if (opts.now !== undefined) out.now = opts.now;
  if (opts.logger !== undefined) out.logger = opts.logger;
  if (opts.isEnabled !== undefined) out.isEnabled = opts.isEnabled;
  return out;
}

// ── Composite Worker call (AC-1 + AC-2) ───────────────────────────────

export interface WriteTimedVerdictOpts {
  /** Dispatch Board directory (e.g. `.ai-sdlc/dispatch`). */
  boardDir: string;
  /** The verdict the Worker is about to emit. */
  verdict: DispatchVerdict;
  /** The manifest the verdict corresponds to (timing anchor). */
  manifest: DispatchManifest;
  /** Override the completion + event clock (tests). */
  now?: () => Date;
  /** Artifacts dir for the events stream. */
  artifactsDir?: string;
  /** Orchestrator session UUID for run-grouping. */
  runId?: string;
  /** Tick number. */
  tick?: number;
  /** Logger for best-effort write failures. */
  logger?: PipelineLogger;
  /** Override the event-writer flag predicate (tests). */
  isEnabled?: () => boolean;
}

export interface WriteTimedVerdictResult {
  /** Absolute path the verdict landed at. */
  verdictPath: string;
  /** The timing-populated verdict that was written. */
  verdict: DispatchVerdict;
  /** True when a completion/failure event was appended to the stream. */
  eventEmitted: boolean;
}

/**
 * Worker-side composite (AC-1 + AC-2): populate the verdict's timing
 * fields, write it to the board via `writeVerdict`, and emit the matching
 * `OrchestratorCompleted` / `OrchestratorFailed` event. One call covers
 * both the verdict-timing-population and event-emission acceptance
 * criteria so Worker code never forgets one half.
 *
 * The completion-vs-failure split mirrors `writeVerdict`'s done/-vs-failed/
 * routing: `success` + `iterate-needed` are completions; everything else
 * is a failure.
 */
export function writeTimedVerdict(opts: WriteTimedVerdictOpts): WriteTimedVerdictResult {
  const timed = populateVerdictTiming(opts.verdict, {
    manifest: opts.manifest,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const verdictPath = writeVerdict(opts.boardDir, timed);

  const emitArgs: EmitTaskEventOpts = {
    taskId: timed.taskId,
    outcome: timed.outcome as TaskOutcome,
    ...(timed.durationMs !== undefined ? { durationMs: timed.durationMs } : {}),
    ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.tick !== undefined ? { tick: opts.tick } : {}),
    ...(timed.workerId !== undefined ? { workerId: timed.workerId } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    ...(opts.isEnabled !== undefined ? { isEnabled: opts.isEnabled } : {}),
  };

  const eventEmitted = isCompletionOutcome(timed.outcome)
    ? emitTaskCompletion(emitArgs)
    : emitTaskFailure(emitArgs);

  return { verdictPath, verdict: timed, eventEmitted };
}
