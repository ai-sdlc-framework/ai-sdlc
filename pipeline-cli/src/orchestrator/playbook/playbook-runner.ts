/**
 * Playbook runner (RFC-0015 Phase 2 / AISDLC-169.2).
 *
 * Given a `WorkerContext` (failure signal + worker metadata), walks the
 * registry in priority order, dispatches the first matching handler,
 * runs the remediation up to `budget` attempts, and returns a
 * `PlaybookResult` describing what happened. The runner is the
 * orchestrator-loop's single failure-handling entry point — `loop.ts`
 * delegates here instead of jumping straight to the Phase 1
 * `UnknownFailureMode` escalation.
 *
 * The runner enforces RFC §13 Q4 by virtue of structure:
 *   - Each `WorkerContext` is per-worker; no shared state crosses runner
 *     invocations.
 *   - Handler `remediate()` calls run sequentially within a single
 *     worker but multiple workers can each have their own runner
 *     instance executing concurrently.
 *   - The runner never mutates the catalogue or registry — both are
 *     readonly inputs.
 *
 * `escalate(ctx, reason)` is the terminal action. By default it tags the
 * worker's PR (if any) with `needs-human-attention` per RFC §13 Q1
 * layer A. Per-mode handlers can override via their `escalate?` hook
 * (e.g. `LongRunningPRBlocksWorker` parks without labelling).
 */

import type { EscalateFn } from '../types.js';
import { effectiveBudgets, type FailurePatternCatalogue } from './catalogue.js';
import { assertRegistryConsistency, PLAYBOOK_HANDLERS } from './registry.js';
import { WorkerStateTracker } from './state-machine.js';
import {
  MODE_TO_REMEDIATE_STATE,
  type FailureMode,
  type Handler,
  type HandlerDeps,
  type PlaybookEvent,
  type RemediationAppliedEvent,
  type RemediationFailedEvent,
  type WorkerContext,
  type WorkerParkedEvent,
} from './types.js';

export interface PlaybookOpts {
  catalogue: FailurePatternCatalogue;
  /** Side-effect dependencies handlers receive. */
  deps: HandlerDeps;
  /**
   * Escalation hook. Defaults to a no-op when unset; the orchestrator's
   * `loop.ts` injects its own `EscalateFn` so the catch-all and the
   * Phase 1 PR-label escalation share one code path.
   */
  escalate?: EscalateFn;
  /** State tracker (one per worker). */
  state: WorkerStateTracker;
  /** Override for `Date.now()` / `new Date()`. */
  now?: () => Date;
}

export interface PlaybookResult {
  /** Mode the runner matched. `null` = no handler claimed the failure → fall-through. */
  matchedMode: FailureMode | null;
  /** Final outcome: `recovered`, `escalated`, or `unknown` (no handler matched). */
  outcome: 'recovered' | 'escalated' | 'unknown';
  /** All events emitted during this playbook invocation. */
  events: PlaybookEvent[];
  /** The handler-supplied `result` if remediation produced one (e.g. re-dispatch). */
  pipelineResult?: import('../../types.js').PipelineResult;
  /** Last note returned by the handler (or runner) for debugging. */
  note?: string;
}

/**
 * Run the playbook against a single failure context. Returns when the
 * failure is recovered, escalated, or escapes catalogue match.
 */
export async function runPlaybook(ctx: WorkerContext, opts: PlaybookOpts): Promise<PlaybookResult> {
  // Belt + braces: catch a regression that desyncs registry + catalogue.
  // Cheap to assert per call (the registry is 9 entries) and gives a
  // crisp failure rather than silent miscategorisation.
  assertRegistryConsistency();

  const events: PlaybookEvent[] = [];
  const now = opts.now ?? ((): Date => new Date());

  // Find the first handler whose detect() claims this failure.
  const handler = pickHandler(ctx);
  if (!handler) {
    // RFC §13 Q8 catch-all — emit nothing here (the loop will record
    // UnknownFailureMode itself); just signal that the playbook didn't
    // own the failure.
    return {
      matchedMode: null,
      outcome: 'unknown',
      events,
      note: 'no catalogued handler matched; falling through to UnknownFailureMode',
    };
  }

  const budgets = effectiveBudgets(opts.catalogue);
  const budget = budgets[handler.mode] ?? handler.budget;
  // Per RFC §13 Q7, an operator-set `escalateImmediately: true` skips
  // the remediation loop and goes straight to escalation.
  const cataloguedEntry = opts.catalogue.patterns.find((p) => p.mode === handler.mode);
  const escalateImmediately = cataloguedEntry?.escalateImmediately === true;

  // Emit the entry transition immediately so the events.jsonl trail
  // shows the worker entering the remediation lane before the handler
  // runs (matters for forensic timing in Phase 4).
  const remediateState = MODE_TO_REMEDIATE_STATE[handler.mode];
  const entryEvent = opts.state.transition(remediateState, {
    note: `entering remediation for ${handler.mode}`,
    mode: handler.mode,
  });
  if (entryEvent) events.push(entryEvent);

  // The handler may need to retry — drive it up to `budget` times.
  // Per RFC §13 Q7, `budget: 0` is the operator's "escalate immediately"
  // signal — skip remediation entirely.
  let lastNote = '';
  let pipelineResult: import('../../types.js').PipelineResult | undefined;

  if (budget === 0 || escalateImmediately) {
    return await escalate(
      ctx,
      handler,
      0,
      `${handler.mode}: operator catalogue ${escalateImmediately ? 'set escalateImmediately=true' : 'set budget=0'}`,
      events,
      opts,
    );
  }

  for (let attempt = 0; attempt < budget; attempt++) {
    const attemptCtx: WorkerContext = { ...ctx, state: remediateState, attempts: attempt };
    const outcome = await handler.remediate(attemptCtx, opts.deps);

    const applied: RemediationAppliedEvent = {
      ts: now().toISOString(),
      workerId: ctx.workerId,
      taskId: ctx.taskId,
      event: 'RemediationApplied',
      mode: handler.mode,
      attempt: attempt + 1,
      outcome: outcome.status,
      note: outcome.note,
    };
    events.push(applied);
    opts.state.emit(applied);
    lastNote = outcome.note ?? lastNote;
    if (outcome.result) pipelineResult = outcome.result;

    if (outcome.status === 'recovered') {
      const next = outcome.nextState ?? 'DONE';
      const t = opts.state.transition(next, { note: outcome.note, mode: handler.mode });
      if (t) events.push(t);
      return {
        matchedMode: handler.mode,
        outcome: 'recovered',
        events,
        pipelineResult,
        note: outcome.note,
      };
    }
    if (outcome.status === 'inapplicable') {
      // Handler decided it can't actually run (e.g. missing redispatch
      // hook). Treat as a hard escalation rather than retry — there's no
      // point looping if the handler will say no every time.
      return await escalate(
        ctx,
        handler,
        attempt + 1,
        outcome.note ?? 'inapplicable',
        events,
        opts,
      );
    }
    if (outcome.status === 'budget-exhausted') {
      return await escalate(
        ctx,
        handler,
        attempt + 1,
        outcome.note ?? 'budget exhausted',
        events,
        opts,
      );
    }
    // status === 'retry' — keep going.
    if (outcome.nextState) {
      const t = opts.state.transition(outcome.nextState, {
        note: outcome.note,
        mode: handler.mode,
      });
      if (t) events.push(t);
    }
  }

  // Loop exited without recovering — escalate.
  return await escalate(ctx, handler, budget, lastNote || 'budget exhausted', events, opts);
}

// ── Internals ─────────────────────────────────────────────────────────

function pickHandler(ctx: WorkerContext): Handler | undefined {
  for (const h of PLAYBOOK_HANDLERS) {
    try {
      if (h.detect(ctx)) return h;
    } catch {
      // A buggy detector throwing is no worse than not matching — keep
      // walking the registry. The misbehaving handler is caught by its
      // own unit test, not by a runtime fallthrough.
      continue;
    }
  }
  return undefined;
}

async function escalate(
  ctx: WorkerContext,
  handler: Handler,
  attempts: number,
  reason: string,
  events: PlaybookEvent[],
  opts: PlaybookOpts,
): Promise<PlaybookResult> {
  const now = opts.now ?? ((): Date => new Date());

  // Mode-specific escalator wins over the generic `escalate` injection.
  if (handler.escalate) {
    try {
      await handler.escalate(ctx, opts.deps);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      opts.deps.logger.warn(`[playbook/${handler.mode}] custom escalate threw: ${m}`);
    }
  } else if (opts.escalate) {
    try {
      await opts.escalate(ctx.taskId, `${handler.mode}: ${reason}`, ctx.prUrl);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      opts.deps.logger.warn(`[playbook/${handler.mode}] generic escalate threw: ${m}`);
    }
  }

  const failed: RemediationFailedEvent = {
    ts: now().toISOString(),
    workerId: ctx.workerId,
    taskId: ctx.taskId,
    event: 'RemediationFailed',
    mode: handler.mode,
    attempts,
    reason,
  };
  events.push(failed);
  opts.state.emit(failed);
  opts.state.recordFailure(handler.mode, attempts, reason);

  // Terminal state depends on the mode: long-running-PR parks; everything
  // else flags for human attention.
  const terminal =
    handler.mode === 'LongRunningPRBlocksWorker' ? 'PARKED' : 'NEEDS_HUMAN_ATTENTION';
  const transition = opts.state.transition(terminal, { note: reason, mode: handler.mode });
  if (transition) events.push(transition);

  if (handler.mode === 'LongRunningPRBlocksWorker') {
    const parked: WorkerParkedEvent = {
      ts: now().toISOString(),
      workerId: ctx.workerId,
      taskId: ctx.taskId,
      event: 'WorkerParked',
      prUrl: ctx.prUrl,
      reason,
    };
    events.push(parked);
    opts.state.emit(parked);
  } else {
    // Final "done with flag" stamp so the persisted state is unambiguous.
    const stamp = opts.state.transition('DONE_WITH_FLAG', { note: reason, mode: handler.mode });
    if (stamp) events.push(stamp);
  }

  return {
    matchedMode: handler.mode,
    outcome: 'escalated',
    events,
    note: reason,
  };
}
