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

import {
  dispatchResultToSubagentResult,
  readDispatchResult,
  type DispatchResult,
} from '../runtime/spawners/dispatch-result.js';

import { buildDependencyGraph, frontier, type DependencyGraph } from '../deps/dependency-graph.js';
import { sortFrontierByEffectivePriority } from '../deps/dispatch.js';
import { executePipeline } from '../execute-pipeline.js';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { defaultSpawner } from '../runtime/default-spawner.js';
import { runExecuteCommand, type ExecuteCommandResult, type SpawnerKind } from '../cli/execute.js';
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
import {
  countCheckpointCommits,
  countCommitsBeyondMain,
  detectRecoverableWorktree,
} from './checkpoint.js';
import type {
  DispatchFn,
  EscalateFn,
  EscalationRecord,
  FrontierFn,
  OrchestratorBlockedByBlastRadiusOverlapEvent,
  OrchestratorBlockedByDispatchabilityEvent,
  OrchestratorBlockedEvent,
  OrchestratorConfig,
  OrchestratorFilterEvent,
  OrchestratorTaskResumedEvent,
  PipelineFailureDetail,
  PipelineOutcomeDetail,
  RichDispatchResult,
  UmbrellaDispatchFn,
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
 *
 * AISDLC-242 — `aborted` is intentionally EXCLUDED from this set.
 * An `aborted` outcome (killed by SIGTERM/SIGKILL/watchdog or network
 * blip) is classified as a RECOVERABLE abort: the worktree is preserved
 * so the next tick can resume from the dev's partial work. The matching
 * `OrchestratorTaskAbortedRecoverable` event is emitted in its place.
 * Use `UNRECOVERABLE_OUTCOMES` for the set that DOES include `aborted`
 * only when you explicitly want to roll back killed sessions.
 */
export const ROLLBACK_OUTCOMES: ReadonlySet<PipelineOutcome | 'unknown-failure'> = new Set([
  'developer-failed',
  'developer-json-contract-violated',
  'unknown-failure',
]);

/**
 * AISDLC-242 — the `aborted` outcome is classified as RECOVERABLE by
 * default (the worktree is preserved for resume). This set is exported for
 * callers that need to check whether a given outcome should trigger the
 * recoverable-abort path rather than a full rollback.
 */
export const RECOVERABLE_ABORT_OUTCOMES: ReadonlySet<PipelineOutcome | 'unknown-failure'> = new Set(
  ['aborted'],
);

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
  /**
   * AISDLC-229 — umbrella dispatcher. When set, overrides `dispatch`. The
   * tick loop calls this and populates `outcomes[i].pipeline` and
   * `outcomes[i].failure` from the richer return type. Tests that inject a
   * plain `dispatch` adapter use the legacy path and leave `pipeline` /
   * `failure` undefined. Production uses `buildDefaultUmbrellaDispatch()`.
   */
  umbrellaDispatch?: UmbrellaDispatchFn;
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
  /**
   * AISDLC-229 — spawner kind for the umbrella dispatcher. Defaults to
   * `'claude-cli'` (inline manifest mode, AISDLC-198). Override via the
   * `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK` env var or by injecting this
   * field directly (tests).
   *
   * When `claude-cli` is selected but `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key`
   * is set AND the umbrella reports the consumer bridge is missing (AISDLC-225
   * not yet shipped), the orchestrator automatically falls back to `api-key`.
   */
  umbrellaSpawnerKind?: SpawnerKind;
  /**
   * AISDLC-229 — umbrella executor. When provided, overrides the default
   * `runExecuteCommand` call. Tests inject a stub to avoid spawning a real
   * process. The function receives the task ID and spawner kind and returns
   * an `ExecuteCommandResult`.
   */
  umbrellaExecutor?: (taskId: string, spawnerKind: SpawnerKind) => Promise<ExecuteCommandResult>;
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
   * AISDLC-243 — frontmatter `dispatchable:` loader for the Dispatchability
   * filter. Defaults to reading the on-disk task file. Tests inject a pure
   * map so they don't have to materialise backlog files. Returns undefined
   * when the field is absent (backward-compatible with tasks predating this
   * field — absent means dispatchable:true). Returns a pair of
   * `[dispatchable, dispatchableReason]` so both values can be loaded in one
   * file read.
   */
  taskDispatchableLoader?: (taskId: string) => {
    dispatchable: boolean | undefined;
    dispatchableReason: string | undefined;
  };
  /**
   * AISDLC-223 — frontmatter `blocked:` loader for the Blocked filter.
   * Defaults to reading the on-disk task file. Tests inject a pure map
   * so they don't have to materialise backlog files. Returns undefined
   * when the field is absent (backward-compatible).
   */
  taskBlockedLoader?: (
    taskId: string,
  ) => import('./filters/blocked.js').BlockedFrontmatter | undefined;
  /**
   * AISDLC-231 — options forwarded to the `BlastRadiusOverlap` filter.
   * Tests inject stubs (`computeBlastRadiusFiles`, `listOpenPRs`,
   * `repoRoot`) to drive the filter without filesystem or network access.
   * When undefined the filter uses defaults (reads `references:` frontmatter
   * from `<workDir>/backlog/`, scans `.worktrees/` sentinels, calls `gh`).
   *
   * Typed as `Omit<..., 'taskId'>` so the adapter cannot supply a stray
   * `taskId` that would override the per-candidate id injected by the loop.
   * The chain spreads these opts BEFORE setting `taskId` so the candidate's
   * own id always wins (enforced in chain.ts).
   */
  blastRadiusOverlapOpts?: Omit<
    import('./filters/blast-radius-overlap.js').CheckBlastRadiusOverlapOpts,
    'taskId'
  >;
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
   * AISDLC-225 — consumer-bridge continuation path. When set, the tick loop
   * reads the dispatch-result.json at this path and uses it as the dispatch
   * result for the admitted task instead of re-dispatching. This is the
   * second half of the inline-spawner protocol: the slash command body writes
   * the Agent result, then re-invokes `cli-orchestrator tick
   * --continue-from-result <path>` to advance the pipeline to Steps 6+.
   *
   * The path is passed by the CLI's `--continue-from-result` flag. When
   * undefined (the common case), the tick dispatches normally.
   */
  continueFromResultPath?: string;
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
  //
  // AISDLC-229 — build a unified rich dispatcher that always returns a
  // `RichDispatchResult`. Priority order:
  //   1. `adapters.umbrellaDispatch` — injected by tests that exercise the
  //      new umbrella path directly.
  //   2. `adapters.dispatch` (legacy `DispatchFn`) — used by existing tests
  //      that haven't migrated to the umbrella shape yet. Wrapped to fill
  //      the `RichDispatchResult` envelope with `pipeline: undefined` and
  //      `failure: undefined` so the tick loop has a single code path.
  //   3. Default — production behaviour:
  //      - Default to the LEGACY direct-spawner path (`buildDefaultDispatch`)
  //        wrapped in the rich envelope. This uses `ShellClaudePSpawner`
  //        directly, the same path that successfully drove AISDLC-178.5,
  //        178.6, and 229 itself through the queue.
  //      - Opt INTO the umbrella path with `AI_SDLC_ORCHESTRATOR_USE_UMBRELLA=1`.
  //        AISDLC-240 — the umbrella's default `claude-cli` spawner depends
  //        on AISDLC-225's manifest-consumer bridge, which is not yet shipped.
  //        Without it the spawner emits a manifest no one consumes, the
  //        subprocess "completes" with empty stdout, and every dispatch
  //        fails as `developer-json-contract-violated`. Reverting the
  //        default to the legacy path unblocks orchestrator dispatch
  //        until AISDLC-225 closes the consumer loop.
  const useUmbrella = (process.env.AI_SDLC_ORCHESTRATOR_USE_UMBRELLA ?? '').trim() === '1';
  // AISDLC-240 — `adapters.umbrellaExecutor` is the test-injection hook for
  // stubbing the umbrella's internal `runExecuteCommand` call. Its presence
  // means the test is exercising the umbrella path, so opt INTO the umbrella
  // even when the env flag is absent. Without this special-case the umbrella
  // tests fail because `buildDefaultUmbrellaDispatch` is no longer the default.
  const testWantsUmbrella = adapters.umbrellaExecutor !== undefined;
  const richDispatchFn: UmbrellaDispatchFn = (() => {
    if (adapters.umbrellaDispatch) return adapters.umbrellaDispatch;
    // AISDLC-225 — consumer-bridge continuation. When `continueFromResultPath`
    // is set, the slash command body has already run the Agent and written the
    // dispatch-result.json. The tick reads that file and forwards the result to
    // `executePipeline()` Steps 6+ without re-dispatching. This is the second
    // half of the inline-spawner handshake.
    if (adapters.continueFromResultPath !== undefined) {
      const resultPath = adapters.continueFromResultPath;
      return buildContinuationDispatch(resultPath, config, adapters, emit);
    }
    if (adapters.dispatch) {
      const legacyFn = adapters.dispatch;
      return async (taskId: string) => ({ result: await legacyFn(taskId) });
    }
    if (useUmbrella || testWantsUmbrella) {
      return buildDefaultUmbrellaDispatch(config, adapters, emit);
    }
    const legacyFn = buildDefaultDispatch(config, adapters, emit);
    return async (taskId: string) => ({ result: await legacyFn(taskId) });
  })();
  // NOTE: `tryPlaybookOnError` builds its own dispatchFn from
  // `args.adapters.dispatch ?? buildDefaultDispatch(...)` at call time.
  // No need to construct a separate alias here.
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
  const dispatchableLoader =
    adapters.taskDispatchableLoader ?? buildDefaultDispatchableLoader(config.workDir);
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
  //
  // AISDLC-242 fix (Major 2) — recoverable-abort bypass: when a cold-start
  // reconstruction added the task to the in-flight map (dispatchPromise ===
  // null, meaning the originating process is dead) AND the worktree has a
  // recoverable abort sentinel + partial commits, we allow the candidate
  // through so it reaches `picks` and `detectAndEmitResumes` can emit
  // `OrchestratorTaskResumed`. Without this bypass, the in-flight entry from
  // `reconstructInFlightFromWorktrees` permanently blocks the task, leaving
  // the preserved worktree stuck and `OrchestratorTaskResumed` never emitting.
  // Note: entries with a live dispatchPromise (from the CURRENT process) are
  // still blocked — only dead-process sentinel entries are eligible for bypass.
  const dispatchableCandidates: typeof candidates = [];
  for (const candidate of candidates) {
    const existing = isInFlight(inFlight, candidate.id);
    if (existing) {
      // Recoverable-abort bypass: if the entry comes from a prior dead process
      // (dispatchPromise === null) and the worktree has partial commits, allow
      // this candidate through for resumption rather than blocking it forever.
      if (
        existing.dispatchPromise === null &&
        detectRecoverableWorktree(config.workDir, candidate.id) !== null
      ) {
        // Remove the stale sentinel entry so claimInFlight below can create a
        // fresh live entry for the new dispatch.
        inFlight.delete(candidate.id.toLowerCase());
        dispatchableCandidates.push(candidate);
        continue;
      }
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
    const dispatchableFm = dispatchableLoader(candidate.id);
    const chainResult = runFilterChain({
      graph,
      taskId: candidate.id,
      taskLabels: labels,
      // AISDLC-243 — pass the pre-loaded dispatchable flag + reason so the
      // Dispatchability filter doesn't need to re-read the task file.
      ...(dispatchableFm.dispatchable !== undefined
        ? { taskDispatchable: dispatchableFm.dispatchable }
        : {}),
      ...(dispatchableFm.dispatchableReason !== undefined
        ? { taskDispatchableReason: dispatchableFm.dispatchableReason }
        : {}),
      ...(blockedFm !== undefined ? { taskBlocked: blockedFm } : {}),
      ...(adapters.clearedExternalKeys !== undefined
        ? { clearedExternalKeys: adapters.clearedExternalKeys }
        : {}),
      ...(adapters.artifactsDir !== undefined ? { artifactsDir: adapters.artifactsDir } : {}),
      ...(adapters.calibrationLogPath !== undefined
        ? { calibrationLogPath: adapters.calibrationLogPath }
        : {}),
      // AISDLC-231 — pass blast-radius overlap options when provided.
      // Tests inject stubs via `adapters.blastRadiusOverlapOpts`; production
      // leaves this undefined and the filter uses defaults (reads frontmatter
      // `references:`, scans `.worktrees/` sentinels, calls `gh`).
      ...(adapters.blastRadiusOverlapOpts !== undefined
        ? { blastRadiusOverlapOpts: adapters.blastRadiusOverlapOpts }
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

  // AISDLC-242 — detect recoverable worktrees for the picked tasks BEFORE
  // dispatching. When a picked task has a preserved worktree from a prior
  // aborted session, emit `OrchestratorTaskResumed` so operators know the
  // dispatch is continuing from partial work rather than starting fresh.
  // The actual resumption is transparent to the dispatcher — it finds the
  // existing worktree + branch and continues where the dev left off.
  detectAndEmitResumes(picks, config, emit, logger, now);

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
        const richResult = await richDispatchFn(taskId);
        // Normalise: the rich result carries the PipelineResult + optional
        // pipeline/failure extras. Pass all three so the settled-value
        // aggregator can populate the full TaskDispatchOutcome.
        return {
          taskId,
          result: richResult.result,
          pipeline: richResult.pipeline,
          failure: richResult.failure,
          preDispatchStatus,
        };
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
    // AISDLC-229 — build the outcome entry. When the rich umbrella path
    // was taken, `value.pipeline` and `value.failure` carry the extra fields.
    // When the legacy `dispatch` adapter was injected (tests), both are
    // `undefined` — the outcome shape is unchanged for existing consumers.
    const outcomeEntry: TaskDispatchOutcome = {
      taskId: result.taskId,
      outcome: result.outcome,
      prUrl: result.prUrl,
      notes: result.notes,
    };
    if (value.pipeline !== undefined) outcomeEntry.pipeline = value.pipeline;
    if (value.failure !== undefined) {
      outcomeEntry.failure = value.failure;
    } else if (result.outcome === 'rebase-conflict') {
      // AISDLC-232 — when the legacy `dispatch` adapter is used (tests or
      // older callers), the `failure` field isn't populated by the umbrella.
      // Surface a synthetic `rebase-conflict` failure detail so
      // `outcomes[i].failure` is always set when the outcome is `rebase-conflict`.
      outcomeEntry.failure = {
        type: 'rebase-conflict',
        message: result.notes ?? 'late-rebase hit semantic conflicts before push',
      };
    }
    outcomes.push(outcomeEntry);
    emit({
      type: 'OrchestratorCompleted',
      taskId: result.taskId,
      outcome: result.outcome,
      prUrl: result.prUrl,
    });
    // AISDLC-177 — failure outcomes from `executePipeline()` (the
    // witness case: `developer-failed` from a dev subagent that returned
    // commitSha:null, plus the AISDLC-176 `developer-json-contract-violated`)
    // all left Step 4's side-effects on disk. Roll them back so the task is
    // re-dispatchable cleanly.
    //
    // AISDLC-242 — `aborted` is now RECOVERABLE (excluded from
    // ROLLBACK_OUTCOMES): instead of tearing down the worktree, we preserve
    // it and emit `OrchestratorTaskAbortedRecoverable` so the next tick can
    // resume from the dev's partial work. Full rollback still fires for
    // `developer-failed` and `developer-json-contract-violated`.
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
    } else if (RECOVERABLE_ABORT_OUTCOMES.has(result.outcome)) {
      // Recoverable abort — preserve the worktree and emit the matching event.
      emitRecoverableAbort({
        taskId: result.taskId,
        outcome: result.outcome,
        reason: result.notes ?? `aborted (${result.outcome})`,
        config,
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
  | {
      taskId: string;
      preDispatchStatus: string;
      result: PipelineResult;
      pipeline?: PipelineOutcomeDetail;
      failure?: PipelineFailureDetail;
    }
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

// ── AISDLC-242 recoverable-abort bridge ─────────────────────────────

interface EmitRecoverableAbortArgs {
  taskId: string;
  outcome: PipelineOutcome | 'unknown-failure';
  reason: string;
  config: OrchestratorConfig;
  emit: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void;
  logger: PipelineLogger;
  now: () => Date;
  /** Branch name from the dispatcher's result (when available). */
  branch?: string;
  /** Worktree path from the dispatcher's result (when available). */
  worktreePath?: string;
}

/**
 * AISDLC-242 — handle an `aborted` dispatch outcome as RECOVERABLE:
 * preserve the worktree + branch (do NOT roll back) and emit the
 * `OrchestratorTaskAbortedRecoverable` event so operators + future ticks
 * can detect and resume the session.
 *
 * The worktree is left on disk with the `.active-task` sentinel intact so
 * `reconstructInFlightFromWorktrees()` picks it up on the next cold start
 * and the in-flight filter keeps it from being re-dispatched as a fresh
 * session. The resume path in `runOrchestratorTick` checks for recoverable
 * worktrees at the start of each tick and emits `OrchestratorTaskResumed`
 * when it detects partial work to continue.
 */
function emitRecoverableAbort(args: EmitRecoverableAbortArgs): void {
  const idLower = args.taskId.toLowerCase();
  const branch = args.branch ?? `ai-sdlc/${idLower}`;
  const wPath = args.worktreePath ?? join(args.config.workDir, '.worktrees', idLower);

  const commitCount = countCommitsBeyondMain(wPath);
  const checkpointCount = countCheckpointCommits(wPath);

  // Trim the reason to keep events.jsonl scannable.
  const reason = args.reason.slice(0, 120);

  args.logger.info(
    `[orchestrator] recoverable abort for ${args.taskId}: worktree preserved at ${wPath} ` +
      `(${commitCount} commits ahead, ${checkpointCount} checkpoints). ` +
      `Next tick will resume. Reason: ${reason}`,
  );

  // Spread into a plain object to satisfy the index-signature requirement
  // of the `emit` function (which accepts `Omit<OrchestratorEvent, 'ts'> & { ts?: string }`).
  args.emit({
    type: 'OrchestratorTaskAbortedRecoverable' as const,
    ts: args.now().toISOString(),
    taskId: args.taskId,
    branch,
    worktreePath: wPath,
    reason,
    hasCheckpointCommits: checkpointCount > 0,
    commitCount,
  });
}

/**
 * AISDLC-242 — on each tick, check whether any in-flight task has a
 * recoverable worktree from a previous aborted session. When found, emit
 * `OrchestratorTaskResumed` and log the details so operators see that the
 * next dispatch will continue from where the dev left off.
 *
 * This is informational-only — the actual resume happens implicitly because
 * the worktree + branch are still on disk and the dev agent is re-dispatched
 * with the same worktree path context.
 */
function detectAndEmitResumes(
  taskIds: string[],
  config: OrchestratorConfig,
  emit: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void,
  logger: PipelineLogger,
  now: () => Date,
): OrchestratorTaskResumedEvent[] {
  const resumed: OrchestratorTaskResumedEvent[] = [];
  for (const taskId of taskIds) {
    const recoverable = detectRecoverableWorktree(config.workDir, taskId);
    if (!recoverable) continue;

    const ts = now().toISOString();
    const branch = `ai-sdlc/${taskId.toLowerCase()}`;
    const ev: OrchestratorTaskResumedEvent = {
      type: 'OrchestratorTaskResumed',
      ts,
      taskId,
      branch,
      worktreePath: recoverable.worktreePath,
      checkpointCommits: recoverable.checkpointCount,
      commitCount: recoverable.commitCount,
      resumedAt: ts,
    };
    logger.info(
      `[orchestrator] resuming ${taskId} from recoverable worktree: ` +
        `${recoverable.commitCount} commits ahead (${recoverable.checkpointCount} checkpoints)`,
    );
    // Spread to satisfy the index-signature requirement of the `emit` function.
    emit({
      type: 'OrchestratorTaskResumed' as const,
      ts,
      taskId: ev.taskId,
      branch: ev.branch,
      worktreePath: ev.worktreePath,
      checkpointCommits: ev.checkpointCommits,
      commitCount: ev.commitCount,
      resumedAt: ev.resumedAt,
    });
    resumed.push(ev);
  }
  return resumed;
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
    case 'not-dispatchable': {
      const ev: OrchestratorBlockedByDispatchabilityEvent = {
        type: 'OrchestratorBlockedByDispatchability',
        ts,
        taskId,
        dispatchableReason: detail.dispatchableReason,
      };
      return ev;
    }
    case 'blast-radius-overlap': {
      const ev: OrchestratorBlockedByBlastRadiusOverlapEvent = {
        type: 'OrchestratorBlockedByBlastRadiusOverlap',
        ts,
        taskId,
        inFlightTaskId: detail.inFlightTaskId,
        overlap: detail.overlap,
        overlapCount: detail.overlapCount,
      };
      return ev;
    }
    case 'already-in-flight':
      // AlreadyInFlight rejections are handled as `OrchestratorTaskAlreadyInFlight`
      // events separately in the loop — they don't map to a `BlockedEvent` arm.
      return null;
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
    case 'OrchestratorBlockedByDispatchability':
      return {
        type: 'OrchestratorBlockedByDispatchability',
        taskId: blocked.taskId,
        dispatchableReason: blocked.dispatchableReason,
      };
    case 'OrchestratorBlockedByBlastRadiusOverlap':
      return {
        type: 'OrchestratorBlockedByBlastRadiusOverlap',
        taskId: blocked.taskId,
        inFlightTaskId: blocked.inFlightTaskId,
        overlap: [...blocked.overlap],
        overlapCount: blocked.overlapCount,
      };
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

/**
 * AISDLC-243 — default `dispatchable:` + `dispatchableReason:` frontmatter
 * loader for the Dispatchability filter. Reads the on-disk task file and
 * returns the parsed values when present. Returns `{ dispatchable: undefined,
 * dispatchableReason: undefined }` on any read / parse error or when the field
 * is absent — an absent `dispatchable` field means `true` (backward-compatible
 * default: all pre-243 tasks are dispatchable unless explicitly opted out).
 */
function buildDefaultDispatchableLoader(workDir: string): (taskId: string) => {
  dispatchable: boolean | undefined;
  dispatchableReason: string | undefined;
} {
  return (taskId) => {
    try {
      const path = findTaskFile(taskId, workDir);
      if (!path || !existsSync(path))
        return { dispatchable: undefined, dispatchableReason: undefined };
      const raw = readFileSync(path, 'utf8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return { dispatchable: undefined, dispatchableReason: undefined };
      const fm = parseSimpleYaml(fmMatch[1]);
      const d = fm.dispatchable;
      const dispatchable = typeof d === 'boolean' ? d : undefined;
      const r = fm.dispatchableReason;
      const dispatchableReason = typeof r === 'string' ? r : undefined;
      return { dispatchable, dispatchableReason };
    } catch {
      return { dispatchable: undefined, dispatchableReason: undefined };
    }
  };
}

/**
 * AISDLC-229 — resolve which spawner kind to use for the umbrella dispatch.
 *
 * Decision tree:
 *   1. If `adapters.umbrellaSpawnerKind` is explicitly set, use it.
 *   2. If `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is set AND the
 *      umbrella will need the fallback (checked post-hoc after the umbrella
 *      runs — see `buildDefaultUmbrellaDispatch`), fall back to `api-key`.
 *   3. Otherwise default to `claude-cli` (AISDLC-198 inline manifest mode).
 */
function resolveUmbrellaSpawnerKind(adapters: OrchestratorAdapters): SpawnerKind {
  if (adapters.umbrellaSpawnerKind) return adapters.umbrellaSpawnerKind;
  return 'claude-cli';
}

/**
 * AISDLC-229 — extract `prNumber` from a GitHub PR URL.
 * Returns `null` on parse failure.
 */
function parsePrNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const m = prUrl.match(/\/pull\/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * AISDLC-229 — build a `PipelineOutcomeDetail` from an `ExecuteCommandResult`.
 * Returns `undefined` when the result carries no pipeline data (pre-review
 * failure paths where `result.pipeline` is absent).
 */
function extractPipelineDetail(
  execResult: ExecuteCommandResult,
): PipelineOutcomeDetail | undefined {
  const pr = execResult.pipeline;
  if (!pr) return undefined;

  // reviewer verdicts — extract from finalVerdict if available
  let reviewerVerdicts: PipelineOutcomeDetail['reviewerVerdicts'] = null;
  if (pr.finalVerdict?.verdicts && pr.finalVerdict.verdicts.length > 0) {
    const verdictMap: Record<string, 'approved' | 'changes-requested'> = {};
    for (const v of pr.finalVerdict.verdicts) {
      if (
        v.agentId === 'code-reviewer' ||
        v.agentId === 'test-reviewer' ||
        v.agentId === 'security-reviewer'
      ) {
        const role = v.agentId.replace('-reviewer', '') as 'code' | 'test' | 'security';
        verdictMap[role] = v.approved ? 'approved' : 'changes-requested';
      }
    }
    if (verdictMap.code && verdictMap.test && verdictMap.security) {
      reviewerVerdicts = {
        code: verdictMap.code,
        test: verdictMap.test,
        security: verdictMap.security,
      };
    }
  }

  return {
    attestationSha: null, // no direct attestation SHA on PipelineResult; enriched post-hoc
    prNumber: parsePrNumber(pr.prUrl),
    reviewerVerdicts,
    iterations: pr.iterations ?? null,
  };
}

/**
 * AISDLC-229 — default umbrella dispatcher that calls `runExecuteCommand`
 * (the AISDLC-182 umbrella CLI entry point) instead of `executePipeline`
 * directly. This ensures the full Step 0-13 pipeline runs, including:
 * Step 7 (reviewer spawning), Step 8 (verdict aggregation), Step 10
 * (DSSE attestation sign), Step 11 (push + PR), Step 12 (sibling PRs).
 *
 * Spawner selection:
 *   1. Default: `claude-cli` (AISDLC-198 inline manifest mode).
 *   2. Fallback: if `AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key` is set
 *      AND the umbrella returns `ok: false` with a spawner-unavailable reason
 *      (AISDLC-225 consumer bridge not yet shipped), retry with `api-key`.
 *   3. Otherwise: record `failure: { type: 'spawner-unavailable', ... }` and
 *      set outcome to `aborted` so the tick continues without blocking.
 *
 * NOTE: The `api-key` fallback path uses ANTHROPIC_API_KEY. If the key is
 * missing, the umbrella will return `ok: false` with an appropriate reason,
 * which surfaces as `failure: { type: 'unknown', ... }`.
 */
/**
 * AISDLC-225 — build a `UmbrellaDispatchFn` that reads a pre-written
 * `dispatch-result.json` and calls `executePipeline()` with a prefill
 * spawner that returns the on-disk `SubagentResult` for the `developer`
 * spawn call. All subsequent spawner calls (reviewers) go through the
 * normal `defaultSpawner()` path.
 *
 * This is the consumer-bridge continuation: the slash command body
 * already ran the Agent and wrote the result; this tick just needs to
 * advance the pipeline from Step 6 (parse developer return) onwards.
 *
 * When the file is missing or invalid, the function falls back to a
 * normal dispatch (same as if `continueFromResultPath` were not set),
 * so a stale `--continue-from-result` flag never silently breaks the
 * loop.
 */
function buildContinuationDispatch(
  resultPath: string,
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
  emit: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void,
): UmbrellaDispatchFn {
  const logger = adapters.logger ?? DEFAULT_LOGGER;

  return async (taskId): Promise<RichDispatchResult> => {
    // Read the dispatch-result.json written by the slash command body.
    const dispatchResult: DispatchResult | null = readDispatchResult({ resultPath });

    if (!dispatchResult) {
      logger.warn(
        `[orchestrator] --continue-from-result: no valid dispatch-result.json at ${resultPath}; ` +
          `falling back to normal dispatch for ${taskId}`,
      );
      // Fall back to the legacy direct-spawner path (same as default production behaviour).
      const legacyFn = buildDefaultDispatch(config, adapters, emit);
      return { result: await legacyFn(taskId) };
    }

    logger.info(
      `[orchestrator] --continue-from-result: restoring ${dispatchResult.status} result ` +
        `for ${dispatchResult.taskId} from ${resultPath}`,
    );

    // Build a "prefill spawner" that returns the pre-loaded SubagentResult when
    // asked for the developer type. Reviewer spawns go through the real spawner.
    const preloadedSubagentResult = dispatchResultToSubagentResult(dispatchResult);
    let developerSpawnConsumed = false;
    const baseSpawner = adapters.spawner ?? (await defaultSpawner());

    const prefillSpawner: SubagentSpawner = {
      spawn: async (opts) => {
        if (opts.type === 'developer' && !developerSpawnConsumed) {
          developerSpawnConsumed = true;
          logger.info(
            `[orchestrator] prefill-spawner: returning pre-loaded developer result ` +
              `(status=${preloadedSubagentResult.status}, durationMs=${preloadedSubagentResult.durationMs})`,
          );
          return preloadedSubagentResult;
        }
        return baseSpawner.spawn(opts);
      },
      spawnParallel: async (opts) => {
        return Promise.all(opts.map((o) => prefillSpawner.spawn(o)));
      },
    };

    const result = await executePipeline({
      taskId,
      workDir: config.workDir,
      spawner: prefillSpawner,
      runner: adapters.runner ?? defaultRunner,
      logger,
      autonomousMode: true,
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

    return { result };
  };
}

function buildDefaultUmbrellaDispatch(
  config: OrchestratorConfig,
  adapters: OrchestratorAdapters,
  emit: (event: Omit<OrchestratorEvent, 'ts'> & { ts?: string }) => void,
): UmbrellaDispatchFn {
  const logger = adapters.logger ?? DEFAULT_LOGGER;
  const spawnerKind = resolveUmbrellaSpawnerKind(adapters);
  const executor = adapters.umbrellaExecutor;

  return async (taskId): Promise<import('./types.js').RichDispatchResult> => {
    const runUmbrella = async (kind: SpawnerKind): Promise<ExecuteCommandResult> => {
      if (executor) return executor(taskId, kind);
      return runExecuteCommand({
        taskId,
        workDir: config.workDir,
        spawnerKind: kind,
        maxIterations: 2,
        dryRun: false,
        run: true,
        logger,
      });
    };

    // First attempt with configured spawner (usually `claude-cli`).
    let execResult = await runUmbrella(spawnerKind);

    // AISDLC-229 AC #2 — spawner-unavailable fallback. When:
    //   1. the first attempt failed (ok: false)
    //   2. AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key is set
    //   3. the failure reason looks like a spawner-resolution error
    // …retry once with `api-key`.
    const fallbackEnv = process.env.AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK;
    const wantFallback = fallbackEnv === 'api-key';
    if (!execResult.ok && wantFallback && spawnerKind !== 'api-key') {
      const reason = execResult.reason ?? '';
      // Spawner-unavailable signatures: missing API key, manifest errors,
      // or explicit ANTHROPIC_API_KEY requirement message.
      const looksLikeSpawnerIssue =
        reason.includes('ANTHROPIC_API_KEY') ||
        reason.includes('spawner') ||
        reason.includes('manifest') ||
        reason.includes('ClaudeCliInlineSpawner') ||
        reason.includes('claude-cli');
      if (looksLikeSpawnerIssue) {
        logger.warn(
          `[orchestrator] claude-cli spawner unavailable for ${taskId}; ` +
            `falling back to api-key (AI_SDLC_ORCHESTRATOR_SPAWNER_FALLBACK=api-key)`,
        );
        emit({ type: 'OrchestratorDispatched', taskId }); // re-emit to log the retry
        execResult = await runUmbrella('api-key');
      }
    }

    // Map ExecuteCommandResult → RichDispatchResult
    if (!execResult.ok) {
      // Umbrella reported failure — synthesise a PipelineResult so the tick
      // loop can reason about the outcome + run rollback if needed.
      const reason = execResult.reason ?? 'unknown umbrella failure';
      logger.warn(`[orchestrator] umbrella failed for ${taskId}: ${reason}`);
      const failureType: PipelineFailureDetail['type'] = (() => {
        if (reason.includes('developer-failed')) return 'developer-failed';
        if (reason.includes('developer-json-contract-violated'))
          return 'developer-json-contract-violated';
        if (reason.includes('aborted')) return 'aborted';
        if (reason.includes('spawner') || reason.includes('ANTHROPIC_API_KEY'))
          return 'spawner-unavailable';
        return 'unknown';
      })();
      const syntheticResult: PipelineResult = {
        taskId,
        branch: `ai-sdlc/${taskId.toLowerCase()}`,
        worktreePath: `${config.workDir}/.worktrees/${taskId.toLowerCase()}`,
        outcome:
          failureType === 'developer-failed'
            ? 'developer-failed'
            : failureType === 'developer-json-contract-violated'
              ? 'developer-json-contract-violated'
              : 'aborted',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
        notes: reason,
      };
      return {
        result: syntheticResult,
        failure: { type: failureType, message: reason },
      };
    }

    // Umbrella succeeded — extract the PipelineResult + pipeline extras.
    const pr = execResult.pipeline;
    if (!pr) {
      // Dry-run plan — shouldn't happen in `run: true` mode but be defensive.
      const syntheticResult: PipelineResult = {
        taskId,
        branch: `ai-sdlc/${taskId.toLowerCase()}`,
        worktreePath: `${config.workDir}/.worktrees/${taskId.toLowerCase()}`,
        outcome: 'aborted',
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
        notes: 'umbrella returned ok without pipeline result (dry-run plan?)',
      };
      return {
        result: syntheticResult,
        failure: { type: 'unknown', message: 'umbrella ok but no pipeline result' },
      };
    }

    const pipelineDetail = extractPipelineDetail(execResult);
    return {
      result: pr,
      pipeline: pipelineDetail,
    };
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
      // AISDLC-241 — activate the in-process mutex (and cross-process file
      // lock) for Step 3's `git worktree add`. The singleton `_globalMutex`
      // inside `withWorktreeMutex` serializes all concurrent ticks running
      // in the same Node.js process; `workDir` activates the advisory
      // `mkdir`-based file lock for the rare case of two independently
      // started `cli-orchestrator tick` processes racing the same repo.
      // The manual `/ai-sdlc execute` path leaves `mutexOpts` undefined,
      // preserving the no-lock backward-compatible default.
      mutexOpts: { workDir: config.workDir },
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
