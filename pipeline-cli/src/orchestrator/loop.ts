/**
 * Orchestrator polling loop — RFC-0015 Phase 1 (bare loop) + Phase 3
 * (pre-dispatch admission filters).
 *
 * Polling driver that reads the dispatch frontier (AISDLC-117 / RFC-0014),
 * runs the three §4.3 admission filters against each candidate, dispatches
 * the survivors via `executePipeline()` (RFC-0012 Tier 2), and escalates
 * unknown failures by tagging the relevant PR with `needs-human-attention`
 * (RFC-0015 §13 Q1 layer A + Q8 catch-all).
 *
 * Phase 1 shipped the bare loop. Phase 3 (this revision) adds:
 *   - Three pre-dispatch filters (dependency / DoR / external-deps) per
 *     RFC §4.3 — see `./filters/`.
 *   - Filter-trace logging on every evaluated candidate (Part B of the
 *     Phase 3 task spec).
 *   - `OrchestratorAwaitingExternal` + sibling `OrchestratorBlockedBy*`
 *     events on the tick result (Part C; Phase 4 / AISDLC-169.4 plumbs
 *     these into `events.jsonl`).
 *   - In-memory stuck-candidate counter (>5 ticks of the same skip → emit
 *     `OrchestratorStuckCandidate`). Persistence to
 *     `$ARTIFACTS_DIR/_orchestrator/state.json` is deferred to Phase 4
 *     alongside the events.jsonl writer; v1 resets the counter on restart.
 *   - Exponential-backoff sleep cadence (Q3 + Q5 resolution): base
 *     `tickIntervalSec` doubled per consecutive idle tick, capped at 5min,
 *     reset on dispatch OR new-task arrival. Idle reasons distinguished by
 *     event type (`OrchestratorIdleNoWork` vs `OrchestratorIdleAllFiltered`).
 *
 * Out of scope (deferred):
 *   - No catalogued failure-recovery handlers (Phase 2 / AISDLC-169.2 —
 *     in-flight on PR #224).
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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildDependencyGraph, frontier, type DependencyGraph } from '../deps/dependency-graph.js';
import { sortFrontierByEffectivePriority } from '../deps/dispatch.js';
import { executePipeline } from '../execute-pipeline.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { defaultSpawner } from '../runtime/default-spawner.js';
import { findTaskFile, parseSimpleYaml } from '../steps/01-validate.js';
import {
  DEFAULT_LOGGER,
  type PipelineLogger,
  type PipelineOutcome,
  type PipelineResult,
  type SubagentSpawner,
} from '../types.js';
import { writeEvent, type OrchestratorEvent } from './events.js';
import { isOrchestratorEnabled, orchestratorDisabledMessage } from './feature-flag.js';
import { formatFilterTrace, runFilterChain } from './filters/index.js';
import type { FilterChainResult } from './filters/types.js';
import {
  claimInFlight,
  isInFlight,
  makeInFlightMap,
  reconstructInFlightFromWorktrees,
  releaseInFlight,
  type InFlightMap,
} from './in-flight.js';
import {
  loadFailurePatternCatalogue,
  runPlaybook,
  WorkerStateTracker,
  type FailurePatternCatalogue,
  type FailureSignal,
  type PlaybookEvent,
  type WorkerContext,
} from './playbook/index.js';
import { rollbackDispatch, type RollbackResult } from './rollback.js';
import type {
  DispatchFn,
  EscalateFn,
  EscalationRecord,
  FrontierFn,
  OrchestratorBlockedEvent,
  OrchestratorConfig,
  OrchestratorFilterEvent,
  OrchestratorIdleEvent,
  OrchestratorStatus,
  OrchestratorStuckCandidateEvent,
  OrchestratorTaskAlreadyInFlightEvent,
  OrchestratorTaskBlockedEvent,
  OrchestratorTickResult,
  TaskDispatchOutcome,
} from './types.js';

export const DEFAULT_TICK_INTERVAL_SEC = 30;
export const DEFAULT_MAX_CONCURRENT = 1;
/** RFC-0015 Phase 3 (Q3/Q5) — exponential backoff caps the idle sleep at 5min. */
export const MAX_IDLE_SLEEP_SEC = 5 * 60;
/** RFC-0015 §4.3 — emit `OrchestratorStuckCandidate` after this many consecutive skips. */
export const STUCK_CANDIDATE_THRESHOLD = 5;

/**
 * AISDLC-177 — pipeline outcomes that left a Step 4 side-effect on disk
 * (status flip + sentinel + worktree) AND require the orchestrator to
 * roll the side-effects back. Outcomes NOT in this set either never
 * dispatched (`task-already-in-flight`, filter rejection) or completed
 * successfully (`approved`, `needs-human-attention` — the latter parks
 * the PR for a human and INTENTIONALLY leaves the worktree in place so
 * the operator can iterate from where the dev stopped).
 */
export const ROLLBACK_OUTCOMES: ReadonlySet<PipelineOutcome | 'unknown-failure'> = new Set([
  'developer-failed',
  'developer-json-contract-violated',
  'aborted',
  'unknown-failure',
]);

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
   * RFC-0015 Phase 3 + Phase 4 — artifacts directory override. Used by:
   *   - the default events writer (Phase 4) for the JSONL rotation root.
   *   - the DoR + external-deps filters (Phase 3) to scope the calibration
   *     log + clearance file.
   * Falls back to `$ARTIFACTS_DIR` env then `<workDir>/artifacts`. Tests
   * point this at a tmpdir to keep filter state + events out of the
   * operator's real `./artifacts/`.
   */
  artifactsDir?: string;
  /**
   * RFC-0015 Phase 3 — graph loader for the pre-dispatch filter chain.
   * Defaults to building a fresh graph from disk on every tick (matches the
   * baseline frontier loader). Tests inject a pre-built graph so they
   * don't have to materialise backlog/ files.
   */
  graphLoader?: () => DependencyGraph;
  /**
   * RFC-0015 Phase 3 — frontmatter `labels:` loader for the DoR filter's
   * `dor-bypass` check. Defaults to reading the on-disk task file. Tests
   * inject a pure map so they don't have to materialise backlog files.
   */
  taskLabelsLoader?: (taskId: string) => readonly string[];
  /**
   * AISDLC-223 — frontmatter `blocked:` loader for the Blocked filter.
   * Defaults to reading the on-disk task file. Tests inject a pure map
   * so they don't have to materialise backlog files. Returns undefined
   * when the field is absent (backward-compatible).
   */
  taskBlockedLoader?: (
    taskId: string,
  ) => import('./filters/blocked.js').BlockedFrontmatter | undefined;
  /** RFC-0015 Phase 3 — wall-clock for event timestamps. Defaults to `Date.now()`. */
  now?: () => Date;
  /**
   * RFC-0015 Phase 3 — pre-loaded operator clearance set for external deps
   * (`<artifactsDir>/_orchestrator/cleared-external-deps.json` content as a
   * pre-built `Set<'<taskIdLower>::<externalDepId>'>`). When undefined the
   * external-deps filter walks the file directly.
   */
  clearedExternalKeys?: ReadonlySet<string>;
  /**
   * RFC-0015 Phase 3 — explicit calibration log path used by the DoR
   * filter. When undefined the DoR filter resolves
   * `<artifactsDir>/_dor/calibration.jsonl` per the conventional layout.
   */
  calibrationLogPath?: string;
  /**
   * RFC-0015 Phase 3 — per-task stuck-candidate counter shared across ticks.
   * The loop increments per skip + emits `OrchestratorStuckCandidate` once
   * the count crosses `STUCK_CANDIDATE_THRESHOLD`. Reset on the candidate's
   * next admission (or removal from the frontier). v1 keeps this in memory;
   * Phase 4 will persist to `$ARTIFACTS_DIR/_orchestrator/state.json`.
   */
  stuckCounters?: Map<string, StuckCounterEntry>;
  /**
   * RFC-0015 Phase 3 — global polling cadence state shared across ticks.
   * Tracks the current sleep interval + the previous frontier task IDs
   * (so a fresh task arrival can reset the backoff). v1 in-memory.
   */
  cadenceState?: CadenceState;
  /**
   * RFC-0015 / AISDLC-179 — in-flight dispatch tracker shared across
   * ticks. Pre-dispatch filter consults this map to reject any candidate
   * already mid-dispatch (prevents the original-bug witness where tick 2
   * re-dispatches AISDLC-178.1 while tick 1's dev subagent is still
   * running and trips "branch already exists" at Step 3).
   *
   * `runOrchestratorLoop()` reconstructs the map from
   * `<workDir>/.worktrees/&star;/.active-task` sentinels on cold start so
   * a restart after a crash doesn't re-dispatch tasks whose worktrees
   * are still around. Tests that drive `runOrchestratorTick` directly
   * pre-populate via this adapter to assert the filter fires.
   */
  inFlight?: InFlightMap;
}

/**
 * RFC-0015 Phase 3 — per-task stuck counter row. Tracks how many
 * consecutive ticks the candidate has been skipped + the most recent
 * skip reason (for the `OrchestratorStuckCandidate` event payload).
 * Reset to zero (entry deleted) on the next admission or a removal from
 * the frontier.
 */
export interface StuckCounterEntry {
  /** Number of consecutive ticks the candidate has been skipped. */
  ticks: number;
  /** Most recent skip reason — usually the failing filter name. */
  reason: string;
  /** Whether `OrchestratorStuckCandidate` already fired for this streak. */
  emittedStuckEvent: boolean;
}

/**
 * RFC-0015 Phase 3 — global polling cadence state. Mutated in place by
 * `runOrchestratorTick` so the loop can compute the next sleep without
 * re-deriving the streak from prior tick results.
 */
export interface CadenceState {
  /** Current sleep interval in seconds (next inter-tick pause). */
  currentIntervalSec: number;
  /** Idle ticks since the last dispatch. Reset to 0 on dispatch. */
  idleStreak: number;
  /**
   * Frontier IDs as of the previous tick — used to reset the backoff
   * when a NEW task lands in the queue (Q3 wake condition).
   */
  lastFrontierIds: ReadonlySet<string>;
}

/** Run a single tick. Exposed so `cli-orchestrator tick` can call it directly. */
export async function runOrchestratorTick(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
  tickNumber: number,
): Promise<OrchestratorTickResult> {
  const logger = adapters.logger ?? DEFAULT_LOGGER;
  const frontierFn = adapters.frontier ?? buildDefaultFrontier(config);
  const escalateFn = adapters.escalate ?? buildDefaultEscalate(config, adapters);
  // RFC-0015 Phase 2 — load the catalogue once per tick. The loader is a
  // small file read + in-process validation; doing it per tick keeps
  // operator edits to the YAML hot-reloadable without a daemon restart.
  const catalogue = adapters.catalogue ?? loadFailurePatternCatalogue({ workDir: config.workDir });
  // RFC-0015 Phase 4 — events sink. The default writer is feature-flag
  // gated + best-effort (swallows write errors); the helper wraps it in
  // a try/catch so a thrown injected sink never crashes the tick.
  const emit = buildEmitter(config, adapters, tickNumber);
  // AISDLC-176 — the default dispatcher needs the per-tick emit so it
  // can forward `DeveloperContractRetry` payloads from
  // `executePipeline()` to the events.jsonl bus. Tests injecting their
  // own dispatch adapter bypass this entirely.
  const dispatchFn = adapters.dispatch ?? buildDefaultDispatch(config, adapters, emit);
  // RFC-0015 Phase 3 — wall-clock + per-task stuck counter + cadence
  // state are shared across ticks via the adapters bag (see
  // `adaptersWithSharedState` in `runOrchestratorLoop`).
  const now = adapters.now ?? (() => new Date());
  const stuckCounters = adapters.stuckCounters ?? new Map<string, StuckCounterEntry>();
  const cadenceState = adapters.cadenceState ?? makeInitialCadenceState(config.tickIntervalSec);
  // RFC-0015 / AISDLC-179 — in-flight tracker. Direct-tick callers (tests,
  // `cli-orchestrator tick`) get a fresh map per call; the loop driver
  // (`runOrchestratorLoop`) injects a shared one + pre-warms it from
  // worktree sentinels on cold start.
  const inFlight = adapters.inFlight ?? makeInFlightMap();

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
    pruneStuckCounters(stuckCounters, []);
    const idleEvent = recordIdleTick(cadenceState, config, 'OrchestratorIdleNoWork', 0, now);
    // RFC-0015 Phase 3 + Phase 4 — surface the idle event on the
    // events.jsonl bus so downstream consumers (cli-status, dashboards)
    // see the same signal the in-process tickResult.idleEvent already
    // carries. Single events.jsonl path per the merged Phase plan.
    emit({
      type: idleEvent.type,
      idleStreak: idleEvent.idleStreak,
    });
    return {
      tick: tickNumber,
      candidates: 0,
      dispatched: [],
      outcomes: [],
      escalations: [],
      empty: true,
      filterEvents: [],
      idleEvent,
      nextSleepSec: cadenceState.currentIntervalSec,
      alreadyInFlight: [],
    };
  }

  // Reset the backoff streak when ANY new task has appeared since the last
  // tick (Q3 wake condition). The streak is also reset on dispatch below.
  applyNewTaskWakeIfApplicable(cadenceState, config, candidates);

  const budget = Math.max(0, config.maxConcurrent);
  const candidateIds = candidates.map((c) => c.id);
  pruneStuckCounters(stuckCounters, candidateIds);

  if (config.dryRun) {
    const idleEvent = recordIdleTick(cadenceState, config, 'OrchestratorIdleNoWork', 0, now);
    emit({ type: idleEvent.type, idleStreak: idleEvent.idleStreak });
    return {
      tick: tickNumber,
      candidates: candidates.length,
      dispatched: [],
      outcomes: [],
      escalations: [],
      empty: false,
      filterEvents: [],
      idleEvent,
      nextSleepSec: cadenceState.currentIntervalSec,
      alreadyInFlight: [],
    };
  }

  // ── Pre-dispatch filter chain (RFC-0015 Phase 3 §4.3) ─────────────────
  const graphLoader = adapters.graphLoader ?? buildDefaultGraphLoader(config);
  const labelsLoader = adapters.taskLabelsLoader ?? buildDefaultLabelsLoader(config.workDir);
  const blockedLoader = adapters.taskBlockedLoader ?? buildDefaultBlockedLoader(config.workDir);
  const graph = graphLoader();
  const filterEvents: OrchestratorFilterEvent[] = [];
  const alreadyInFlightEvents: OrchestratorTaskAlreadyInFlightEvent[] = [];
  const picks: string[] = [];

  // RFC-0015 / AISDLC-179 — in-flight pre-filter. Before running the
  // (potentially expensive) §4.3 filter chain we drop any candidate that's
  // already mid-dispatch. Original-bug witness: with `maxConcurrent: 1` and
  // a 30s tick interval, every tick re-picked the same task while tick 1's
  // dev subagent was still running — wasting dispatches and tripping
  // "branch already exists" at Step 3. Forwarding `OrchestratorTaskAlreadyInFlight`
  // to both the in-process accumulator + events bus gives operators a
  // forensic trace of the rejection.
  const dispatchableCandidates: typeof candidates = [];
  for (const candidate of candidates) {
    const existing = isInFlight(inFlight, candidate.id);
    if (existing) {
      const ts = now().toISOString();
      const event: OrchestratorTaskAlreadyInFlightEvent = {
        type: 'OrchestratorTaskAlreadyInFlight',
        ts,
        taskId: candidate.id,
        startedAt: existing.startedAt,
      };
      alreadyInFlightEvents.push(event);
      emit({
        type: 'OrchestratorTaskAlreadyInFlight',
        taskId: candidate.id,
        startedAt: existing.startedAt,
      });
      continue;
    }
    dispatchableCandidates.push(candidate);
  }

  for (const candidate of dispatchableCandidates) {
    if (picks.length >= budget) break;
    const labels = labelsLoader(candidate.id);
    const blockedFm = blockedLoader(candidate.id);
    const chainResult = runFilterChain({
      graph,
      taskId: candidate.id,
      taskLabels: labels,
      ...(blockedFm !== undefined ? { taskBlocked: blockedFm } : {}),
      ...(adapters.clearedExternalKeys !== undefined
        ? { clearedExternalKeys: adapters.clearedExternalKeys }
        : {}),
      ...(adapters.artifactsDir !== undefined ? { artifactsDir: adapters.artifactsDir } : {}),
      ...(adapters.calibrationLogPath !== undefined
        ? { calibrationLogPath: adapters.calibrationLogPath }
        : {}),
    });
    logger.info(formatFilterTrace(candidate.id, chainResult));
    const event = recordFilterEvent({
      taskId: candidate.id,
      chainResult,
      stuckCounters,
      now,
    });
    filterEvents.push(event);
    // RFC-0015 Phase 3 + Phase 4 — forward the structured filter
    // rejection + stuck-streak signals to the events.jsonl bus so
    // operators only have to grep one stream. The in-process
    // `tickResult.filterEvents[]` continues to carry the same data for
    // the cli-orchestrator status surface.
    if (event.blockedEvent) {
      emit(toEmittableBlockedEvent(event.blockedEvent));
    }
    if (event.stuckEvent) {
      emit({
        type: 'OrchestratorStuckCandidate',
        taskId: event.stuckEvent.taskId,
        reason: event.stuckEvent.reason,
        ticksSinceFirstSkip: event.stuckEvent.ticksSinceFirstSkip,
      });
    }
    if (chainResult.passed) {
      picks.push(candidate.id);
    }
  }

  if (picks.length === 0) {
    // Nothing dispatched — emit the matching idle event. If we evaluated
    // candidates and rejected them all, that's `OrchestratorIdleAllFiltered`
    // (a distinct cause from `OrchestratorIdleNoWork` so operators can grep
    // by type — Phase 4's events.jsonl writer surfaces it on the bus).
    const reason: OrchestratorIdleEvent['type'] =
      filterEvents.length > 0 ? 'OrchestratorIdleAllFiltered' : 'OrchestratorIdleNoWork';
    const idleEvent = recordIdleTick(cadenceState, config, reason, filterEvents.length, now);
    if (idleEvent.type === 'OrchestratorIdleAllFiltered') {
      emit({
        type: 'OrchestratorIdleAllFiltered',
        idleStreak: idleEvent.idleStreak,
        rejectedCount: idleEvent.rejectedCount,
      });
    } else {
      emit({ type: 'OrchestratorIdleNoWork', idleStreak: idleEvent.idleStreak });
    }
    return {
      tick: tickNumber,
      candidates: candidates.length,
      dispatched: [],
      outcomes: [],
      escalations: [],
      empty: false,
      filterEvents,
      idleEvent,
      nextSleepSec: cadenceState.currentIntervalSec,
      alreadyInFlight: alreadyInFlightEvents,
    };
  }

  const outcomes: TaskDispatchOutcome[] = [];
  const escalations: EscalationRecord[] = [];

  // Phase 1 default `maxConcurrent: 1`. We still use Promise.all so Phase 2
  // can bump the cap without touching this code path. Each dispatch is
  // wrapped in its own try/catch so one task's escape never crashes the loop.
  //
  // RFC-0015 / AISDLC-179 — every dispatch is also wrapped in
  // `claimInFlight`/`releaseInFlight` so concurrent ticks don't re-dispatch
  // the same task while it's mid-flight. Claim happens BEFORE the
  // `OrchestratorDispatched` emit so a tick that races in between two ticks
  // (theoretically impossible since runOrchestratorTick is awaited
  // sequentially per loop, but defensive against future concurrency) still
  // sees the entry. Release runs in `finally` so the slot is freed on
  // success AND failure paths.
  //
  // AISDLC-177 — capture the pre-dispatch task status BEFORE Step 4 flips
  // it inside the dispatcher. The captured value is the rollback target if
  // the dispatch fails (`developer-failed`, `developer-json-contract-violated`,
  // `aborted`, or a thrown error that surfaces as `unknown-failure`). We
  // read it here rather than inside the dispatcher because by the time
  // executePipeline returns, Step 4 has already mutated the file to
  // "In Progress".
  const settled = await Promise.allSettled(
    picks.map(async (taskId) => {
      const startedAt = now().toISOString();
      const preDispatchStatus = readTaskStatus(config.workDir, taskId) ?? 'To Do';
      const claim = claimInFlight(inFlight, taskId, {
        startedAt,
        worktreePath: join(config.workDir, '.worktrees', taskId.toLowerCase()),
        dispatchPromise: null,
      });
      // RFC-0015 Phase 4 — pre-dispatch event. Emitting BEFORE the
      // dispatch (rather than after) means a dispatch that hard-crashes
      // the orchestrator (theoretically impossible per the catch below,
      // but defensive) still leaves a forensic trace of "this task
      // started" on the events bus.
      emit({ type: 'OrchestratorDispatched', taskId });
      try {
        const result = await dispatchFn(taskId);
        return { taskId, result, preDispatchStatus };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { taskId, error: message, preDispatchStatus };
      } finally {
        // Only release the slot if THIS call won the claim — otherwise we'd
        // free a slot owned by a concurrent claimer (defensive; today's
        // single-threaded tick means `claim.claimed` is always true here
        // because the in-flight pre-filter already rejected duplicates).
        if (claim.claimed) {
          releaseInFlight(inFlight, taskId);
        }
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
    const value = s.value as DispatchSettledValue;

    if ('error' in value && value.error) {
      // Phase 2: try the playbook before falling through to the catch-all.
      // The playbook's redispatch path (e.g. RebaseConflict handler) needs
      // the worktree intact; we defer rollback until the playbook gives up
      // (escalated / unknown) so we don't pull the rug out from a recovery
      // attempt mid-flight.
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
        // AISDLC-177 — playbook gave up; sweep the worktree + revert
        // status so the next tick can re-pick cleanly.
        await maybeRollback({
          taskId: value.taskId,
          outcome: 'unknown-failure',
          preDispatchStatus: value.preDispatchStatus,
          config,
          adapters,
          emit,
          logger,
          now,
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
      // AISDLC-177 — uncatalogued failure; same sweep as the escalated
      // branch above.
      await maybeRollback({
        taskId: value.taskId,
        outcome: 'unknown-failure',
        preDispatchStatus: value.preDispatchStatus,
        config,
        adapters,
        emit,
        logger,
        now,
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
      // AISDLC-177 — pathological no-result branch still left Step 4's
      // side-effects on disk. Roll them back.
      await maybeRollback({
        taskId: value.taskId,
        outcome: 'unknown-failure',
        preDispatchStatus: value.preDispatchStatus,
        config,
        adapters,
        emit,
        logger,
        now,
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
    // AISDLC-177 — failure outcomes from `executePipeline()` (the
    // witness case: `developer-failed` from a dev subagent that returned
    // commitSha:null, plus the AISDLC-176 `developer-json-contract-violated`
    // and the catch-all `aborted`) all left Step 4's side-effects on
    // disk. Roll them back so the task is re-dispatchable cleanly.
    if (ROLLBACK_OUTCOMES.has(result.outcome)) {
      await maybeRollback({
        taskId: result.taskId,
        outcome: result.outcome,
        preDispatchStatus: value.preDispatchStatus,
        config,
        adapters,
        emit,
        logger,
        now,
        branch: result.branch,
        worktreePath: result.worktreePath,
      });
    }
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

  // Successful dispatch resets the backoff curve immediately (Q3 + Q5
  // resolution). Even if every dispatch escalated, the loop made forward
  // progress this tick — no need to slow polling.
  resetCadence(cadenceState, config);

  return {
    tick: tickNumber,
    candidates: candidates.length,
    dispatched: picks,
    outcomes,
    escalations,
    empty: false,
    playbookEvents,
    filterEvents,
    idleEvent: null,
    nextSleepSec: cadenceState.currentIntervalSec,
    alreadyInFlight: alreadyInFlightEvents,
  };
}

// ── AISDLC-177 rollback bridge ───────────────────────────────────────

/**
 * AISDLC-177 — settled-promise payload returned by the per-pick async
 * lambda. Carries the pre-dispatch status the orchestrator captured
 * BEFORE Step 4 flipped it, so the rollback target is known regardless
 * of whether the dispatcher succeeded, failed cleanly, or threw.
 */
type DispatchSettledValue =
  | { taskId: string; preDispatchStatus: string; result: PipelineResult }
  | { taskId: string; preDispatchStatus: string; error: string; result?: undefined };

interface MaybeRollbackArgs {
  taskId: string;
  outcome: PipelineOutcome | 'unknown-failure';
  preDispatchStatus: string;
  config: OrchestratorConfig;
  adapters: OrchestratorAdapters;
  emit: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void;
  logger: PipelineLogger;
  now: () => Date;
  /** Branch name from the dispatcher's result (when available). */
  branch?: string;
  /** Worktree path from the dispatcher's result (when available). */
  worktreePath?: string;
}

/**
 * AISDLC-177 — undo Step 3 + Step 4 side-effects for a failed dispatch
 * and emit the matching `OrchestratorRollback` (+ optional
 * `OrchestratorWorkQuarantined`) events.
 *
 * Best-effort by design: any failure inside `rollbackDispatch()`
 * accumulates in `result.warnings` rather than throwing — observability
 * must not crash the orchestrator hot loop.
 *
 * The branch + worktree path can be derived from the canonical task ID
 * (`ai-sdlc/<id-lower>` and `<workDir>/.worktrees/<id-lower>`), but we
 * accept overrides from the dispatcher's result so a future change to
 * the branch-naming convention (e.g. RFC-0010's tier-aware names)
 * doesn't desync.
 */
async function maybeRollback(args: MaybeRollbackArgs): Promise<void> {
  const idLower = args.taskId.toLowerCase();
  const branch = args.branch ?? `ai-sdlc/${idLower}`;
  const worktreePath = args.worktreePath ?? join(args.config.workDir, '.worktrees', idLower);

  let result: RollbackResult;
  try {
    result = await rollbackDispatch({
      workDir: args.config.workDir,
      taskId: args.taskId,
      fromStatus: args.preDispatchStatus,
      worktreePath,
      branch,
      runner: args.adapters.runner,
      logger: args.logger,
      now: args.now,
    });
  } catch (err) {
    // Defensive: rollbackDispatch is best-effort internally, but a
    // programming error (e.g. a future refactor that throws) must not
    // crash the loop. Log + continue.
    const reason = err instanceof Error ? err.message : String(err);
    args.logger.error(`[orchestrator-rollback] threw for ${args.taskId}: ${reason}`);
    return;
  }

  // AISDLC-186 — `statusReverted` is the forensic source of truth for
  // whether the task file's `status:` line was actually patched back to
  // `fromStatus`. `toStatus` continues to mirror `fromStatus` for the
  // common (success) case, but operators reading events.jsonl after a
  // partial rollback (e.g. task file disappeared mid-run) need this
  // boolean to know the file write never happened — the pre-186 payload
  // claimed `toStatus: <fromStatus>` regardless and the warning only
  // surfaced via `logger.warn`. Adding the field is strictly additive +
  // lossless (downstream consumers that don't know about it ignore it).
  args.emit({
    type: 'OrchestratorRollback',
    taskId: args.taskId,
    fromStatus: result.fromStatus,
    toStatus: result.fromStatus,
    statusReverted: result.statusReverted,
    worktreeRemoved: result.worktreeRemoved,
    branchQuarantined: result.branchQuarantined,
    ...(result.quarantineRef !== undefined ? { quarantineRef: result.quarantineRef } : {}),
  });

  if (
    result.branchQuarantined &&
    result.quarantineRef &&
    result.quarantineSha &&
    result.quarantineCommitCount
  ) {
    args.emit({
      type: 'OrchestratorWorkQuarantined',
      taskId: args.taskId,
      branch,
      quarantineRef: result.quarantineRef,
      commitSha: result.quarantineSha,
      commitCount: result.quarantineCommitCount,
    });
  }

  if (result.warnings.length > 0) {
    args.logger.warn(
      `[orchestrator-rollback] partial rollback for ${args.taskId}: ${result.warnings.join('; ')}`,
    );
  }
}

/**
 * AISDLC-177 — read the current `status:` value from a task file. Used
 * by the orchestrator to capture the pre-dispatch status BEFORE Step 4
 * flips it, so a later rollback knows what to revert TO. Returns null
 * when the file is missing / malformed (caller falls back to "To Do",
 * the conservative default).
 */
function readTaskStatus(workDir: string, taskId: string): string | null {
  try {
    const path = findTaskFile(taskId, workDir);
    if (!path || !existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const m = fmMatch[1].split('\n').find((line) => /^status:\s*/.test(line));
    if (!m) return null;
    const value = m.replace(/^status:\s*/, '').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
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
  // Playbook redispatch path doesn't currently surface
  // `DeveloperContractRetry` events (the redispatch happens inside the
  // playbook handler, not the per-tick orchestrator emit scope). A
  // no-op emit keeps the dispatcher signature uniform; if a future
  // playbook handler needs the retry signal it can wire its own emit.
  const dispatchFn =
    args.adapters.dispatch ?? buildDefaultDispatch(args.config, args.adapters, () => undefined);
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

// ── RFC-0015 Phase 3 helpers ──────────────────────────────────────────

/** Build a cadence state initialised at the configured base interval. */
export function makeInitialCadenceState(baseSec: number): CadenceState {
  return {
    currentIntervalSec: Math.max(0, baseSec),
    idleStreak: 0,
    lastFrontierIds: new Set(),
  };
}

/**
 * Reset the backoff curve to the configured base interval. Called on
 * dispatch (the loop made forward progress) AND on new-task arrival
 * (the queue gained work since the last tick). Also wipes the idle
 * streak counter so the next idle tick starts the curve fresh.
 */
function resetCadence(state: CadenceState, config: OrchestratorConfig): void {
  state.currentIntervalSec = Math.max(0, config.tickIntervalSec);
  state.idleStreak = 0;
}

/**
 * Apply the Q3 wake condition: if any candidate ID in this tick wasn't
 * present last tick, treat it as a new arrival + reset the backoff. The
 * cadence's `lastFrontierIds` is then refreshed so the NEXT tick can do
 * the same comparison.
 */
function applyNewTaskWakeIfApplicable(
  state: CadenceState,
  config: OrchestratorConfig,
  candidates: ReadonlyArray<{ id: string }>,
): void {
  const currentIds = new Set(candidates.map((c) => c.id));
  const hasNew = [...currentIds].some((id) => !state.lastFrontierIds.has(id));
  if (hasNew) resetCadence(state, config);
  state.lastFrontierIds = currentIds;
}

/**
 * Record an idle-tick event + advance the backoff curve. Returns the
 * event so the caller can pin it to the tick result.
 */
function recordIdleTick(
  state: CadenceState,
  config: OrchestratorConfig,
  reasonType: OrchestratorIdleEvent['type'],
  rejectedCount: number,
  now: () => Date,
): OrchestratorIdleEvent {
  state.idleStreak += 1;
  const base = Math.max(1, config.tickIntervalSec);
  const doubled = state.currentIntervalSec * 2;
  state.currentIntervalSec = Math.min(MAX_IDLE_SLEEP_SEC, Math.max(base, doubled));
  const ts = now().toISOString();
  if (reasonType === 'OrchestratorIdleAllFiltered') {
    return { type: 'OrchestratorIdleAllFiltered', ts, idleStreak: state.idleStreak, rejectedCount };
  }
  return { type: 'OrchestratorIdleNoWork', ts, idleStreak: state.idleStreak };
}

/**
 * Drop stuck-counter rows for IDs no longer in the frontier (their owning
 * task has either landed in `completed/`, been cancelled, or been removed
 * from the dispatch queue for some other reason). Keeps the in-memory map
 * bounded by frontier size rather than orchestrator lifetime.
 */
function pruneStuckCounters(
  counters: Map<string, StuckCounterEntry>,
  candidateIds: ReadonlyArray<string>,
): void {
  const keep = new Set(candidateIds.map((id) => id.toLowerCase()));
  for (const key of [...counters.keys()]) {
    if (!keep.has(key)) counters.delete(key);
  }
}

interface RecordFilterEventOpts {
  taskId: string;
  chainResult: FilterChainResult;
  stuckCounters: Map<string, StuckCounterEntry>;
  now: () => Date;
}

/**
 * Convert a filter chain result into an `OrchestratorFilterEvent` and
 * (when the chain rejected the candidate) bump the stuck-counter +
 * conditionally emit `OrchestratorStuckCandidate`. Resets the counter
 * when the chain admitted the candidate.
 */
function recordFilterEvent(opts: RecordFilterEventOpts): OrchestratorFilterEvent {
  const ts = opts.now().toISOString();
  const counterKey = opts.taskId.toLowerCase();

  if (opts.chainResult.passed) {
    // Admitted — wipe the stuck streak so a future skip starts clean.
    opts.stuckCounters.delete(counterKey);
    return {
      ts,
      taskId: opts.taskId,
      trace: opts.chainResult,
      stuckEvent: null,
      blockedEvent: null,
    };
  }

  const failure = opts.chainResult.failure;
  const blockedEvent = failure ? toBlockedEvent(opts.taskId, failure, ts) : null;

  // Bump the per-task stuck counter; emit the stuck event the first tick
  // we cross the threshold so operators see the signal exactly once per
  // streak (not on every subsequent tick).
  const reason = failure?.filter ?? 'unknown';
  const prior = opts.stuckCounters.get(counterKey);
  const next: StuckCounterEntry = {
    ticks: (prior?.ticks ?? 0) + 1,
    reason,
    emittedStuckEvent: prior?.emittedStuckEvent ?? false,
  };
  opts.stuckCounters.set(counterKey, next);

  let stuckEvent: OrchestratorStuckCandidateEvent | null = null;
  if (next.ticks > STUCK_CANDIDATE_THRESHOLD && !next.emittedStuckEvent) {
    stuckEvent = {
      type: 'OrchestratorStuckCandidate',
      ts,
      taskId: opts.taskId,
      reason,
      ticksSinceFirstSkip: next.ticks,
    };
    next.emittedStuckEvent = true;
  }

  return { ts, taskId: opts.taskId, trace: opts.chainResult, stuckEvent, blockedEvent };
}

/** Map a filter-chain failure to the matching RFC §7.1 event payload. */
function toBlockedEvent(
  taskId: string,
  failure: FilterChainResult['trace'][number],
  ts: string,
): OrchestratorBlockedEvent | null {
  const detail = failure.detail;
  if (!detail) return null;
  switch (detail.kind) {
    case 'dependency-blocked':
      return { type: 'OrchestratorBlockedByDependency', ts, taskId, blockers: detail.blockers };
    case 'dor-blocked':
      return {
        type: 'OrchestratorBlockedByDor',
        ts,
        taskId,
        verdict: detail.verdict,
        signedAt: detail.signedAt,
      };
    case 'awaiting-external':
      return {
        type: 'OrchestratorAwaitingExternal',
        ts,
        taskId,
        externalDeps: detail.blocking.map((d) => ({ id: d.id, kind: d.kind })),
        allExternalDeps: detail.all.map((d) => ({ id: d.id, kind: d.kind })),
      };
    case 'orphan-parent-needs-closure':
      return {
        type: 'OrchestratorOrphanParent',
        ts,
        taskId,
        completedChildren: detail.completedChildren,
      };
    case 'blocked': {
      const ev: OrchestratorTaskBlockedEvent = {
        type: 'TaskBlocked',
        ts,
        taskId,
        reason: detail.reason,
      };
      if (detail.until !== undefined) ev.until = detail.until;
      return ev;
    }
  }
}

/**
 * RFC-0015 Phase 3 + Phase 4 — strip the redundant `ts` from a structured
 * blocked event (the emitter stamps a fresh `ts` from the wall clock at
 * append time) and forward the per-type payload to `writeEvent()`. Keeps
 * the events.jsonl payload shape identical to the schema-validated
 * canonical form per `spec/schemas/orchestrator-events.v1.schema.json`.
 */
function toEmittableBlockedEvent(blocked: OrchestratorBlockedEvent): Omit<OrchestratorEvent, 'ts'> {
  switch (blocked.type) {
    case 'OrchestratorBlockedByDependency':
      return {
        type: 'OrchestratorBlockedByDependency',
        taskId: blocked.taskId,
        blockers: [...blocked.blockers],
      };
    case 'OrchestratorBlockedByDor':
      return {
        type: 'OrchestratorBlockedByDor',
        taskId: blocked.taskId,
        verdict: blocked.verdict,
        signedAt: blocked.signedAt,
      };
    case 'OrchestratorAwaitingExternal':
      return {
        type: 'OrchestratorAwaitingExternal',
        taskId: blocked.taskId,
        externalDeps: blocked.externalDeps.map((d) => ({ id: d.id, kind: d.kind })),
        allExternalDeps: blocked.allExternalDeps.map((d) => ({ id: d.id, kind: d.kind })),
      };
    case 'OrchestratorOrphanParent':
      return {
        type: 'OrchestratorOrphanParent',
        taskId: blocked.taskId,
        completedChildren: [...blocked.completedChildren],
      };
    case 'TaskBlocked': {
      const payload: Omit<OrchestratorEvent, 'ts'> = {
        type: 'TaskBlocked',
        taskId: blocked.taskId,
        reason: blocked.reason,
      };
      if (blocked.until !== undefined) payload.until = blocked.until;
      return payload;
    }
  }
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
  // RFC-0015 Phase 3 + Phase 4 — build a single adapter bag shared across
  // all ticks in this loop session:
  //   - Phase 4: mint a stable runId so every emitted event is correlatable
  //     across the date-rotated file boundary. Tests that pre-set
  //     `adapters.runId` win over the random mint.
  //   - Phase 3: pre-allocate the cadence + stuck-counter state so the
  //     backoff curve advances continuously and stuck-candidate streaks
  //     survive between ticks. Tests can pre-populate via the adapters
  //     bag; production starts fresh on every loop start (per RFC §13 Q2's
  //     stateless-recovery model — Phase 4 will eventually persist the
  //     stuck counters to `$ARTIFACTS_DIR/_orchestrator/state.json` for
  //     resume-across-restart).
  const sharedAdapters: OrchestratorAdapters = {
    ...adapters,
    runId: adapters.runId ?? randomUUID(),
    stuckCounters: adapters.stuckCounters ?? new Map<string, StuckCounterEntry>(),
    cadenceState: adapters.cadenceState ?? makeInitialCadenceState(config.tickIntervalSec),
    // RFC-0015 / AISDLC-179 — pre-warm the in-flight map from on-disk
    // worktree sentinels on cold start so a restart-after-crash doesn't
    // re-dispatch tasks whose worktrees still exist. Tests that pre-set
    // `adapters.inFlight` win over the reconstruction (e.g. to assert the
    // map is empty on a clean cold start, or to inject a synthetic entry).
    inFlight: adapters.inFlight ?? reconstructInFlightFromWorktrees(config.workDir),
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
      const tick = await runOrchestratorTick(config, sharedAdapters, tickNumber);
      ticks.push(tick);
      if (config.maxTicks !== null && tickNumber >= config.maxTicks) break;
      if (shouldStop) break;
      // RFC-0015 Phase 3 (Q3 + Q5) — sleep the backoff-aware interval, NOT
      // the static `config.tickIntervalSec`. The tick result carries the
      // computed value so tests can assert the curve from the result alone.
      await sleep(tick.nextSleepSec * 1000);
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
 *
 * AISDLC-223: also computes the `blocked` list by walking the frontier and
 * collecting tasks whose `blocked.reason` frontmatter field is non-empty.
 */
export async function buildOrchestratorStatus(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters = {},
  lastTick: OrchestratorTickResult | null = null,
): Promise<OrchestratorStatus> {
  const frontierFn = adapters.frontier ?? buildDefaultFrontier(config);
  const blockedLoader = adapters.taskBlockedLoader ?? buildDefaultBlockedLoader(config.workDir);
  const enabled = isOrchestratorEnabled();
  const front = frontierFn();

  // AISDLC-223 — build the blocked list by inspecting each frontier
  // candidate's `blocked:` frontmatter. Tasks blocked by this field are
  // ready by every OTHER criterion but held by the operator.
  const blocked: OrchestratorStatus['blocked'] = [];
  for (const candidate of front) {
    const fm = blockedLoader(candidate.id);
    const reason = fm?.reason?.trim() ?? '';
    if (reason !== '') {
      const entry: { taskId: string; reason: string; until?: string } = {
        taskId: candidate.id,
        reason,
      };
      if (fm?.until !== undefined) entry.until = fm.until;
      blocked.push(entry);
    }
  }

  return {
    frontier: front,
    queueDepth: front.length,
    lastTick,
    config,
    enabled,
    blocked,
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

/**
 * RFC-0015 Phase 3 — default graph loader for the filter chain. Builds a
 * fresh `DependencyGraph` from the on-disk backlog directories; matches
 * the convention `buildDefaultFrontier` uses so both callers see the same
 * snapshot when invoked back-to-back in a single tick.
 */
function buildDefaultGraphLoader(config: OrchestratorConfig): () => DependencyGraph {
  return () => buildDependencyGraph({ workDir: config.workDir }, () => undefined);
}

/**
 * RFC-0015 Phase 3 — default frontmatter labels loader for the DoR
 * filter's `dor-bypass` check. Reads the on-disk task file via the same
 * helpers `cli-deps` uses and returns the parsed `labels:` array
 * (lowercased for case-insensitive comparison). Returns `[]` on any
 * read / parse error — a missing-or-malformed file should never SILENTLY
 * admit a task that lacks a real bypass label.
 */
function buildDefaultLabelsLoader(workDir: string): (taskId: string) => readonly string[] {
  return (taskId): readonly string[] => {
    try {
      const path = findTaskFile(taskId, workDir);
      if (!path || !existsSync(path)) return [];
      const raw = readFileSync(path, 'utf8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return [];
      const fm = parseSimpleYaml(fmMatch[1]);
      const labels = fm.labels;
      if (!Array.isArray(labels)) return [];
      return labels
        .filter((l): l is string => typeof l === 'string')
        .map((l) => l.trim().toLowerCase());
    } catch {
      return [];
    }
  };
}

/**
 * AISDLC-223 — default `blocked:` frontmatter loader for the Blocked
 * filter. Reads the on-disk task file and returns the parsed `blocked:`
 * object when present. Returns `undefined` on any read / parse error or
 * when the field is absent — a missing field means "not blocked", which
 * is the backward-compatible default.
 */
function buildDefaultBlockedLoader(
  workDir: string,
): (taskId: string) => import('./filters/blocked.js').BlockedFrontmatter | undefined {
  return (taskId) => {
    try {
      const path = findTaskFile(taskId, workDir);
      if (!path || !existsSync(path)) return undefined;
      const raw = readFileSync(path, 'utf8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return undefined;
      const fm = parseSimpleYaml(fmMatch[1]);
      const b = fm.blocked;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
      const br = b as Record<string, unknown>;
      const reason = typeof br.reason === 'string' ? br.reason : undefined;
      const until = typeof br.until === 'string' ? br.until : undefined;
      const unblockedBy = Array.isArray(br.unblockedBy)
        ? (br.unblockedBy as unknown[]).filter((x: unknown): x is string => typeof x === 'string')
        : undefined;
      return { reason, until, unblockedBy };
    } catch {
      return undefined;
    }
  };
}

function buildDefaultDispatch(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
  emit: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void,
): DispatchFn {
  return async (taskId): Promise<PipelineResult> => {
    const spawner = adapters.spawner ?? (await defaultSpawner());
    return executePipeline({
      taskId,
      workDir: config.workDir,
      spawner,
      runner: adapters.runner ?? defaultRunner,
      logger: adapters.logger ?? DEFAULT_LOGGER,
      // AISDLC-224 — set autonomousMode so Step 3 can self-heal stale
      // branches automatically (guarded by AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP).
      autonomousMode: true,
      // AISDLC-176 — forward the `DeveloperContractRetry` recovery
      // signal from `executePipeline()`'s Step 6 onto the orchestrator
      // events.jsonl bus. High-frequency emission of this event tells
      // operators the developer.md system prompt has drifted (the agent
      // forgot the JSON contract often enough that the retry is doing
      // more work than it should be); rare emission tells operators the
      // retry is the safety net it was designed to be.
      // AISDLC-196 — also forward `phase` + optional `iteration` so
      // operators can attribute the retry to the initial-dispatch path
      // (Step 5b/6) versus the iteration-loop path (Step 9, iter N>1).
      onDeveloperContractRetry: ({ initialOutputPreview, durationMs, phase, iteration }): void => {
        emit({
          type: 'DeveloperContractRetry',
          taskId,
          initialOutputPreview,
          retryDurationMs: durationMs,
          phase,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
      // AISDLC-224 — forward Step 3's `WorktreeAutoCleaned` event onto the
      // orchestrator's events.jsonl bus. Without this hook, the event was
      // silently dropped on every real orchestrator run (code-reviewer #377
      // finding 2 — `setupWorktree`'s `emitEvent` was never threaded).
      onWorktreeAutoCleaned: (event): void => {
        emit({
          type: 'WorktreeAutoCleaned',
          taskId: event.taskId,
          branch: event.branch,
          reason: event.reason,
          hadOpenPR: event.hadOpenPR,
          hadUncommittedChanges: event.hadUncommittedChanges,
        });
      },
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
