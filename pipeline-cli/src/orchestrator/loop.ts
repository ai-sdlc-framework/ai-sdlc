/**
 * Bare orchestrator loop — RFC-0015 Phase 1.
 *
 * Polling driver that reads the dispatch frontier (AISDLC-117 / RFC-0014),
 * dispatches up to `maxConcurrent` tasks via `executePipeline()` (RFC-0012
 * Tier 2), and escalates unknown failures by tagging the relevant PR with
 * `needs-human-attention` (RFC-0015 §13 Q1 layer A + Q8 catch-all).
 *
 * Phase 1 keeps the loop deliberately bare:
 *   - No catalogued failure-recovery handlers (that's Phase 2 / AISDLC-169.2).
 *   - No DoR / dependency / external-deps pre-dispatch admission filters
 *     beyond what `cli-deps frontier` already enforces (Phase 3 / AISDLC-169.3).
 *   - No events.jsonl writer or `cli-status --orchestrator` view
 *     (Phase 4 / AISDLC-169.4).
 *
 * What Phase 1 DOES guarantee:
 *   1. The loop honors `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental` — when
 *      the flag is unset the loop refuses to start and exits cleanly.
 *   2. Every dispatch flows through `executePipeline()` so it inherits the
 *      worktree allocation, sentinel write, finalize sequence (idempotent per
 *      RFC §13 Q2), and cleanup hook from RFC-0010 / RFC-0012 — no parallel
 *      worktree management code.
 *   3. Any exception escaping `executePipeline()` is captured, the failing
 *      task ID + error is recorded as an `UnknownFailureMode` escalation,
 *      and the PR (if one was opened before the throw) is tagged via the
 *      injected `EscalateFn`. The loop continues to the next tick — a
 *      single bad task never crashes the loop.
 *   4. SIGINT / SIGTERM drain the in-flight dispatch and exit cleanly.
 *
 * Adapters (`DispatchFn`, `FrontierFn`, `EscalateFn`) are dependency-injected
 * so unit tests can drive the loop without git/gh/spawner side effects.
 *
 * @module orchestrator/loop
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { buildDependencyGraph, frontier } from '../deps/dependency-graph.js';
import { sortFrontierByEffectivePriority } from '../deps/dispatch.js';
import { executePipeline } from '../execute-pipeline.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { defaultSpawner } from '../runtime/default-spawner.js';
import {
  DEFAULT_LOGGER,
  type PipelineLogger,
  type PipelineResult,
  type SubagentSpawner,
} from '../types.js';
import { writeEvent, type OrchestratorEvent } from './events.js';
import { isOrchestratorEnabled, orchestratorDisabledMessage } from './feature-flag.js';
import {
  loadFailurePatternCatalogue,
  runPlaybook,
  WorkerStateTracker,
  type FailurePatternCatalogue,
  type FailureSignal,
  type PlaybookEvent,
  type WorkerContext,
} from './playbook/index.js';
import type {
  DispatchFn,
  EscalateFn,
  EscalationRecord,
  FrontierFn,
  OrchestratorConfig,
  OrchestratorStatus,
  OrchestratorTickResult,
  TaskDispatchOutcome,
} from './types.js';

export const DEFAULT_TICK_INTERVAL_SEC = 30;
export const DEFAULT_MAX_CONCURRENT = 1;

/** Build the default config — callers can override individual fields. */
export function defaultOrchestratorConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    workDir: process.cwd(),
    tickIntervalSec: DEFAULT_TICK_INTERVAL_SEC,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxTicks: null,
    dryRun: false,
    ...overrides,
  };
}

export interface OrchestratorAdapters {
  /** Frontier source — defaults to a `cli-deps frontier`-equivalent in-process call. */
  frontier?: FrontierFn;
  /** Dispatcher — defaults to a real `executePipeline()` call. */
  dispatch?: DispatchFn;
  /** Escalation hook — defaults to a `gh pr edit --add-label needs-human-attention` shell-out. */
  escalate?: EscalateFn;
  /** Sleeper — defaults to `setTimeout`. Tests inject a synchronous resolve. */
  sleep?: (ms: number) => Promise<void>;
  /** Logger — defaults to console. */
  logger?: PipelineLogger;
  /**
   * Optional injected `SubagentSpawner` for the default dispatcher. Tests
   * usually override `dispatch` directly instead of going through this.
   */
  spawner?: SubagentSpawner;
  /** Optional injected `Runner` for the default frontier + escalate paths. */
  runner?: Runner;
  /**
   * RFC-0015 Phase 2 — failure-pattern catalogue. Defaults to the
   * on-disk `.ai-sdlc/orchestrator-failure-patterns.yaml` (or the bundled
   * default catalogue when the file is missing). Tests inject a
   * synthetic catalogue with overridden budgets.
   */
  catalogue?: FailurePatternCatalogue;
  /**
   * RFC-0015 Phase 2 — when true, the loop persists per-worker state
   * files to `$ARTIFACTS_DIR/_orchestrator/workers/<id>.state.json` for
   * forensic + Phase 4 `cli-status --orchestrator` consumption. Tests
   * set false to keep state in memory.
   */
  persistWorkerState?: boolean;
  /**
   * RFC-0015 Phase 4 — orchestrator session UUID. Stable across all
   * ticks within a single `runOrchestratorLoop()` invocation; stamped
   * onto every emitted `OrchestratorEvent` so consumers can correlate
   * events from one process even when the date-rotated events file
   * rolls over mid-run. Tests inject a deterministic value;
   * `runOrchestratorLoop()` mints one via `crypto.randomUUID()` when
   * unset.
   */
  runId?: string;
  /**
   * RFC-0015 Phase 4 — events sink. Defaults to the on-disk
   * date-rotated `events.jsonl` writer (`writeEvent()` from `./events.js`).
   * Tests inject a synchronous capturer to assert the per-tick event
   * sequence without touching the filesystem.
   *
   * Best-effort by contract: a thrown sink is swallowed so the
   * orchestrator hot loop is never crashed by an observability hiccup.
   */
  emitEvent?: (event: OrchestratorEvent) => void;
  /**
   * RFC-0015 Phase 4 — artifacts directory override forwarded to the
   * default events writer. Falls back to env then `./artifacts`. Tests
   * point this at a tmpdir.
   */
  artifactsDir?: string;
}

/** Run a single tick. Exposed so `cli-orchestrator tick` can call it directly. */
export async function runOrchestratorTick(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
  tickNumber: number,
): Promise<OrchestratorTickResult> {
  const logger = adapters.logger ?? DEFAULT_LOGGER;
  const frontierFn = adapters.frontier ?? buildDefaultFrontier(config);
  const dispatchFn = adapters.dispatch ?? buildDefaultDispatch(config, adapters);
  const escalateFn = adapters.escalate ?? buildDefaultEscalate(config, adapters);
  // RFC-0015 Phase 2 — load the catalogue once per tick. The loader is a
  // small file read + in-process validation; doing it per tick keeps
  // operator edits to the YAML hot-reloadable without a daemon restart.
  const catalogue = adapters.catalogue ?? loadFailurePatternCatalogue({ workDir: config.workDir });
  // RFC-0015 Phase 4 — events sink. The default writer is feature-flag
  // gated + best-effort (swallows write errors); the helper wraps it in
  // a try/catch so a thrown injected sink never crashes the tick.
  const emit = buildEmitter(config, adapters, tickNumber);

  const candidates = frontierFn();
  logger.progress(
    'orchestrator-tick',
    `tick=${tickNumber} frontier=${candidates.length} maxConcurrent=${config.maxConcurrent}`,
  );
  emit({
    type: 'OrchestratorTick',
    candidates: candidates.length,
    dispatched: 0,
  });

  if (candidates.length === 0) {
    return {
      tick: tickNumber,
      candidates: 0,
      dispatched: [],
      outcomes: [],
      escalations: [],
      empty: true,
    };
  }

  const budget = Math.max(0, config.maxConcurrent);
  const picks = candidates.slice(0, budget).map((c) => c.id);

  if (config.dryRun || picks.length === 0) {
    return {
      tick: tickNumber,
      candidates: candidates.length,
      dispatched: [],
      outcomes: [],
      escalations: [],
      empty: false,
    };
  }

  const outcomes: TaskDispatchOutcome[] = [];
  const escalations: EscalationRecord[] = [];

  // Phase 1 default `maxConcurrent: 1`. We still use Promise.all so Phase 2
  // can bump the cap without touching this code path. Each dispatch is
  // wrapped in its own try/catch so one task's escape never crashes the loop.
  const settled = await Promise.allSettled(
    picks.map(async (taskId) => {
      // RFC-0015 Phase 4 — pre-dispatch event. Emitting BEFORE the
      // dispatch (rather than after) means a dispatch that hard-crashes
      // the orchestrator (theoretically impossible per the catch below,
      // but defensive) still leaves a forensic trace of "this task
      // started" on the events bus.
      emit({ type: 'OrchestratorDispatched', taskId });
      try {
        const result = await dispatchFn(taskId);
        return { taskId, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { taskId, error: message };
      }
    }),
  );

  // Aggregate playbook events so the tick result carries a forensic
  // trail (Phase 4 will surface this via events.jsonl).
  const playbookEvents: PlaybookEvent[] = [];

  for (const s of settled) {
    if (s.status !== 'fulfilled') {
      // Promise.allSettled never rejects the outer promise, so this branch
      // is defensive — a future refactor that throws synchronously inside
      // the inner async still surfaces here as a clean escalation.
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      escalations.push(
        await pushEscalation(escalateFn, {
          taskId: '(unknown)',
          ts: new Date().toISOString(),
          event: 'UnknownFailureMode',
          reason,
          prUrl: null,
        }),
      );
      emit({
        type: 'OrchestratorFailed',
        taskId: '(unknown)',
        mode: 'UnknownFailureMode',
        reason,
        prUrl: null,
      });
      continue;
    }
    const value = s.value;

    if ('error' in value && value.error) {
      // Phase 2: try the playbook before falling through to the catch-all.
      const playbook = await tryPlaybookOnError({
        taskId: value.taskId,
        reason: value.error,
        config,
        adapters,
        catalogue,
        escalateFn,
        logger,
      });
      playbookEvents.push(...playbook.events);
      // Phase 4: forward each playbook state-machine transition to the
      // events bus so the cli-status view + future dashboard see the
      // same per-worker forensic trail the in-memory `playbookEvents`
      // array already carries.
      for (const ev of playbook.events) {
        if (ev.event === 'WorkerStateTransition') {
          emit({
            type: 'WorkerStateTransition',
            taskId: ev.taskId,
            workerId: ev.workerId,
            from: ev.from,
            to: ev.to,
            duration_ms: ev.duration_ms,
            context: ev.context,
          });
        }
      }
      if (playbook.outcome === 'recovered' && playbook.result) {
        outcomes.push({
          taskId: playbook.result.taskId,
          outcome: playbook.result.outcome,
          prUrl: playbook.result.prUrl,
          notes: playbook.result.notes,
        });
        emit({
          type: 'OrchestratorRecovered',
          taskId: playbook.result.taskId,
          mode: playbook.matchedMode ?? undefined,
          outcome: playbook.result.outcome,
          prUrl: playbook.result.prUrl,
        });
        continue;
      }
      if (playbook.outcome === 'escalated' && playbook.matchedMode) {
        escalations.push({
          taskId: value.taskId,
          ts: new Date().toISOString(),
          event: playbook.matchedMode,
          reason: playbook.note ?? value.error,
          prUrl: null,
        });
        outcomes.push({
          taskId: value.taskId,
          outcome: 'unknown-failure',
          prUrl: null,
          error: playbook.note ?? value.error,
          notes: `playbook handled ${playbook.matchedMode}`,
        });
        emit({
          type: 'OrchestratorFailed',
          taskId: value.taskId,
          mode: playbook.matchedMode,
          reason: playbook.note ?? value.error,
          prUrl: null,
        });
        continue;
      }
      // Fall-through: no catalogued mode matched → Phase 1 catch-all.
      const record: EscalationRecord = {
        taskId: value.taskId,
        ts: new Date().toISOString(),
        event: 'UnknownFailureMode',
        reason: value.error,
        prUrl: null,
      };
      escalations.push(await pushEscalation(escalateFn, record));
      outcomes.push({
        taskId: value.taskId,
        outcome: 'unknown-failure',
        prUrl: null,
        error: value.error,
      });
      emit({
        type: 'OrchestratorFailed',
        taskId: value.taskId,
        mode: 'UnknownFailureMode',
        reason: value.error,
        prUrl: null,
      });
      continue;
    }
    if (!value.result) {
      // Result missing without an explicit error — defensive escalation so we
      // surface the gap rather than silently dropping the task.
      const record: EscalationRecord = {
        taskId: value.taskId,
        ts: new Date().toISOString(),
        event: 'UnknownFailureMode',
        reason: 'dispatch returned no result',
        prUrl: null,
      };
      escalations.push(await pushEscalation(escalateFn, record));
      outcomes.push({
        taskId: value.taskId,
        outcome: 'unknown-failure',
        prUrl: null,
        error: record.reason,
      });
      emit({
        type: 'OrchestratorFailed',
        taskId: value.taskId,
        mode: 'UnknownFailureMode',
        reason: record.reason,
        prUrl: null,
      });
      continue;
    }
    const result = value.result;
    outcomes.push({
      taskId: result.taskId,
      outcome: result.outcome,
      prUrl: result.prUrl,
      notes: result.notes,
    });
    emit({
      type: 'OrchestratorCompleted',
      taskId: result.taskId,
      outcome: result.outcome,
      prUrl: result.prUrl,
    });
    // Phase 1 also escalates the executePipeline native `needs-human-attention`
    // outcome — that flag means the task is parked for a human anyway and
    // benefits from the durable PR label per RFC §13 Q1 layer A. The label
    // is idempotent (gh pr edit no-ops if the label is already attached).
    if (result.outcome === 'needs-human-attention') {
      escalations.push(
        await pushEscalation(escalateFn, {
          taskId: result.taskId,
          ts: new Date().toISOString(),
          event: 'UnknownFailureMode',
          reason: result.notes ?? 'needs-human-attention from executePipeline',
          prUrl: result.prUrl,
        }),
      );
      emit({
        type: 'OrchestratorFailed',
        taskId: result.taskId,
        mode: 'UnknownFailureMode',
        reason: result.notes ?? 'needs-human-attention from executePipeline',
        prUrl: result.prUrl,
      });
    }
  }

  return {
    tick: tickNumber,
    candidates: candidates.length,
    dispatched: picks,
    outcomes,
    escalations,
    empty: false,
    playbookEvents,
  };
}

// ── Phase 2 playbook bridge ──────────────────────────────────────────

interface TryPlaybookArgs {
  taskId: string;
  reason: string;
  config: OrchestratorConfig;
  adapters: OrchestratorAdapters;
  catalogue: FailurePatternCatalogue;
  escalateFn: EscalateFn;
  logger: PipelineLogger;
}

interface TryPlaybookResult {
  outcome: 'recovered' | 'escalated' | 'unknown';
  matchedMode: import('./playbook/types.js').FailureMode | null;
  events: PlaybookEvent[];
  result?: PipelineResult;
  note?: string;
}

/**
 * Build a `WorkerContext` from a thrown dispatch error and run the
 * playbook against it. Returns whatever the playbook decided so the
 * caller can either skip ahead (recovered), record a catalogued
 * escalation (escalated), or fall through to the Phase 1 catch-all
 * (unknown).
 */
async function tryPlaybookOnError(args: TryPlaybookArgs): Promise<TryPlaybookResult> {
  // Thrown dispatch errors carry no exit code — we synthesise `1` because
  // a non-throw return path means success; reaching `tryPlaybookOnError`
  // means the underlying step exited non-zero (or the dispatcher itself
  // raised). Specific handlers that REQUIRE a real exit code (e.g.
  // `EnvHookFailure` keys on 127) can still validate via stderr.
  const failure: FailureSignal = {
    stderr: args.reason,
    exitCode: 1,
  };
  const ctx: WorkerContext = {
    workerId: `w-${args.taskId.toLowerCase()}`,
    taskId: args.taskId,
    branch: `ai-sdlc/${args.taskId.toLowerCase()}`,
    worktreePath: `${args.config.workDir}/.worktrees/${args.taskId.toLowerCase()}`,
    state: 'DEV_RUNNING',
    prUrl: null,
    failure,
    attempts: 0,
    dispatchedAt: new Date().toISOString(),
  };
  const tracker = new WorkerStateTracker({
    workerId: ctx.workerId,
    taskId: ctx.taskId,
    branch: ctx.branch,
    worktreePath: ctx.worktreePath,
    initialState: 'DEV_RUNNING',
    inMemoryOnly: !args.adapters.persistWorkerState,
  });
  const dispatchFn = args.adapters.dispatch ?? buildDefaultDispatch(args.config, args.adapters);
  const playbook = await runPlaybook(ctx, {
    catalogue: args.catalogue,
    escalate: args.escalateFn,
    state: tracker,
    deps: {
      runner: args.adapters.runner ?? defaultRunner,
      sleep: args.adapters.sleep ?? defaultSleep,
      logger: args.logger,
      // The playbook's redispatch hook reuses the same dispatcher the
      // orchestrator built for normal flow — handlers that re-spawn the
      // dev get the SAME pipeline path, just executed again.
      redispatch: dispatchFn,
    },
  });
  return {
    outcome: playbook.outcome,
    matchedMode: playbook.matchedMode,
    events: [...playbook.events],
    result: playbook.pipelineResult,
    note: playbook.note,
  };
}

/**
 * Run the orchestrator loop until shutdown. Returns the array of completed
 * tick results (useful for test assertions + cron invocations that pass
 * `maxTicks: 1`).
 */
export async function runOrchestratorLoop(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters = {},
): Promise<OrchestratorTickResult[]> {
  if (!isOrchestratorEnabled()) {
    throw new OrchestratorDisabledError(orchestratorDisabledMessage());
  }
  const logger = adapters.logger ?? DEFAULT_LOGGER;
  const sleep = adapters.sleep ?? defaultSleep;
  // RFC-0015 Phase 4 — mint a stable runId for the entire loop session so
  // every emitted event is correlatable across the date-rotated file
  // boundary. Tests that pre-set `adapters.runId` (for deterministic
  // assertions) win over the random mint.
  const sessionAdapters: OrchestratorAdapters = {
    ...adapters,
    runId: adapters.runId ?? randomUUID(),
  };

  const ticks: OrchestratorTickResult[] = [];
  let tickNumber = 0;
  let shouldStop = false;

  // Drain on SIGINT/SIGTERM. Per RFC §13 Q2 (stateless + idempotent finalize)
  // we don't persist anything — the next start picks up where we left off
  // by re-reading the frontier. So "drain" just means "let the in-flight
  // tick finish, then exit".
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.warn(`[orchestrator] received ${signal}; draining + exiting after current tick`);
    shouldStop = true;
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    while (!shouldStop) {
      tickNumber += 1;
      const tick = await runOrchestratorTick(config, sessionAdapters, tickNumber);
      ticks.push(tick);
      if (config.maxTicks !== null && tickNumber >= config.maxTicks) break;
      if (shouldStop) break;
      await sleep(config.tickIntervalSec * 1000);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  return ticks;
}

/**
 * Build the read-only orchestrator status (used by `cli-orchestrator status`).
 * Does NOT dispatch anything — purely an inspection surface.
 */
export async function buildOrchestratorStatus(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters = {},
  lastTick: OrchestratorTickResult | null = null,
): Promise<OrchestratorStatus> {
  const frontierFn = adapters.frontier ?? buildDefaultFrontier(config);
  const enabled = isOrchestratorEnabled();
  const front = frontierFn();
  return {
    frontier: front,
    queueDepth: front.length,
    lastTick,
    config,
    enabled,
  };
}

/** Distinguished error raised when the loop refuses to start. */
export class OrchestratorDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorDisabledError';
  }
}

// ── Default adapters ──────────────────────────────────────────────────

/**
 * RFC-0015 Phase 4 — build a per-tick emitter that stamps each event
 * with the orchestrator's runId + the current tick number, then forwards
 * to either the injected sink (tests) or the on-disk events writer
 * (production).
 *
 * Returns a synchronous fire-and-forget — emission is best-effort per
 * RFC §7.3 and a thrown sink is swallowed so the orchestrator hot loop
 * is never crashed by an observability hiccup.
 */
function buildEmitter(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
  tickNumber: number,
): (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void {
  const artifactsDir =
    adapters.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(config.workDir, 'artifacts');
  const sink =
    adapters.emitEvent ??
    ((event: OrchestratorEvent): void => {
      writeEvent(event, { artifactsDir });
    });
  return (event): void => {
    const enriched: OrchestratorEvent = {
      ...event,
      ts: event.ts || new Date().toISOString(),
      tick: tickNumber,
      runId: adapters.runId,
    } as OrchestratorEvent;
    try {
      sink(enriched);
    } catch {
      // Swallow — observability must never crash the loop.
    }
  };
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDefaultFrontier(config: OrchestratorConfig): FrontierFn {
  return () => {
    // Use the same in-process frontier query the cli-deps subcommand calls.
    // When AI_SDLC_DEPS_COMPOSITION is on we get the effective-priority sort
    // for free; off we get the baseline `id ASC` order.
    const graph = buildDependencyGraph({ workDir: config.workDir }, () => {
      // Suppress per-tick stale-task warnings — they belong on cli-deps' own
      // surface, not in the orchestrator hot loop.
    });
    const baseline = frontier(graph);
    const ranked = sortFrontierByEffectivePriority(graph, baseline);
    return ranked.map((r) => ({ id: r.id, title: r.title }));
  };
}

function buildDefaultDispatch(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
): DispatchFn {
  return async (taskId): Promise<PipelineResult> => {
    const spawner = adapters.spawner ?? (await defaultSpawner());
    return executePipeline({
      taskId,
      workDir: config.workDir,
      spawner,
      runner: adapters.runner ?? defaultRunner,
      logger: adapters.logger ?? DEFAULT_LOGGER,
    });
  };
}

function buildDefaultEscalate(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
): EscalateFn {
  const runner = adapters.runner ?? defaultRunner;
  const logger = adapters.logger ?? DEFAULT_LOGGER;
  return async (taskId, reason, prUrl): Promise<void> => {
    logger.warn(
      `[orchestrator] escalation: task=${taskId} reason=${reason}` + (prUrl ? ` pr=${prUrl}` : ''),
    );
    if (!prUrl) return;
    // gh pr edit --add-label is idempotent: if the label is already attached
    // GitHub returns 200 + no-op. We `allowFailure: true` so an escalation
    // never throws back into the loop and crashes a tick.
    await runner('gh', ['pr', 'edit', prUrl, '--add-label', 'needs-human-attention'], {
      cwd: config.workDir,
      allowFailure: true,
    });
  };
}

async function pushEscalation(
  escalate: EscalateFn,
  record: EscalationRecord,
): Promise<EscalationRecord> {
  // The escalator runs side-effecting work (gh CLI) — wrap it so a thrown
  // adapter doesn't crash the loop.
  try {
    await escalate(record.taskId, record.reason, record.prUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...record,
      reason: `${record.reason} (escalator threw: ${message})`,
    };
  }
  return record;
}
