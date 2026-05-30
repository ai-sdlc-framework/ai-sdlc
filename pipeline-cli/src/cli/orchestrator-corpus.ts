/**
 * `cli-orchestrator-corpus` — aggregate downloaded orchestrator
 * `events.jsonl` artifacts (RFC-0015 Phase 4 / AISDLC-169.4) into an
 * unattended-completion + quota-burn report that drives the
 * AISDLC-169.5 / RFC-0015 §11 Phase 5 promotion decision.
 *
 * Sister CLI to `cli-deps-corpus` (AISDLC-167.5) and `cli-dor-corpus`
 * (AISDLC-161). The three share aesthetic conventions
 * (find-files-recursively, recommendation envelope, JSON-or-table
 * output, `safe-to-promote | continue-soak | insufficient-data`
 * recommendation) but answer different questions:
 *
 *   - `cli-dor-corpus`           → "is the DoR rubric ready for `enforce`?"
 *   - `cli-deps-corpus`          → "is the dependency-graph composition
 *                                  layer ready for default-on?"
 *   - `cli-orchestrator-corpus`  → "is the autonomous orchestrator ready
 *                                  for default-on?" (per-run unattended
 *                                  completion rate + quota-burn surprises
 *                                  + per-failure-mode distribution
 *                                  against a corpus of `events.jsonl`
 *                                  files)
 *
 * Per RFC-0015 §11 Phase 5 acceptance criteria (corpus-driven, NOT
 * calendar-gated per maintainer directive 2026-05-01):
 *
 *   - Unattended completion rate ≥ 95% AND
 *   - No quota-burn surprise vs RFC-0010 §14 SubscriptionLedger
 *     projections (actual tokens-per-task within ±20% of §12 cost
 *     model — operationalised as "actual tokens ≤ 110% of projected")
 *   AND
 *   - ≥ 20 tasks observed across ≥ 3 distinct backlog tasks/RFCs
 *
 * Whichever path satisfies the criteria first wins. Calendar duration
 * is a side-effect, not a gate.
 *
 * Hybrid promotion model (mirrors AISDLC-161 / AISDLC-167.5):
 *   - `recommendation: 'safe-to-promote'`  → operator can flip the
 *     `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` default OFF → ON (single PR,
 *     runbook in `docs/operations/orchestrator-promotion.md`).
 *   - `recommendation: 'continue-soak'`     → keep gathering data; the
 *     `reason` field names the failing metric.
 *   - `recommendation: 'insufficient-data'` → use the operator-override
 *     spot-check path described in the runbook (corpus too sparse for
 *     statistical confidence).
 *
 * **Signal source**: `events.jsonl` artifacts written by
 * `pipeline-cli/src/orchestrator/events.ts` (Phase 4). Each file is one
 * date-rotated JSONL stream; each line is one `OrchestratorEvent`. The
 * aggregator groups by `runId` (the orchestrator session UUID stamped
 * on every event) so multi-day runs that span date-rotations are
 * counted once rather than once-per-rotation.
 *
 * **Per-run derived metrics** (see `RunSummary`):
 *   - `dispatched`         — count of `OrchestratorDispatched` events
 *   - `completed`          — count of `OrchestratorCompleted` events
 *                            with `outcome === 'approved'`
 *   - `recovered`          — count of `OrchestratorRecovered` events
 *                            (Phase 2 playbook auto-fixed a failure)
 *   - `humanAttention`     — count of `OrchestratorFailed` events
 *                            (catch-all + catalogued escalations both
 *                            land here)
 *   - `unattendedRate`     — `(completed + recovered) / dispatched`
 *   - `tokensConsumed`     — sum of `context.tokens` from completion +
 *                            failure events when present (Phase 4
 *                            schema-stable opt-in field)
 *   - `tokensProjected`    — `dispatched * RFC §12 per-task projection
 *                            (default 200_000)`
 *   - `quotaBurnRatio`     — `tokensConsumed / tokensProjected` (1.0 =
 *                            on projection; >1.10 = surprise overage)
 *   - `failureModes`       — per-mode tally from `OrchestratorFailed`
 *                            events' `mode` field (e.g.
 *                            `{ UnknownFailureMode: 2, RebaseConflict: 1 }`)
 *
 * **Why per-run rather than per-event**: an "unattended completion
 * rate" is a per-task metric — we want "of N tasks dispatched, how
 * many completed without human intervention?" not "of M events, how
 * many were completion events?" The grouping IS the math; once a run
 * is partitioned by `runId` the metrics fall out of simple counts.
 *
 * **Why a separate aggregator (vs reusing `cli-deps-corpus`)**: the
 * input shape (events.jsonl with `runId` correlator) and the question
 * being asked (unattended-completion + quota-burn vs dispatch
 * agreement + override rate) are different enough that a separate
 * aggregator is clearer than a shared one with two modes. The two
 * tools share their CLI conventions and their recommendation-envelope
 * shape so an operator's eye doesn't have to retrain.
 *
 * Usage:
 *   $ gh run download --pattern '*-orchestrator-events' --dir ./downloaded
 *   $ cli-orchestrator-corpus aggregate ./downloaded
 *   $ cli-orchestrator-corpus aggregate ./downloaded --format table
 *
 * Output is JSON on stdout; `--format table` renders an ASCII summary.
 *
 * @module cli/orchestrator-corpus
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import type { OrchestratorEvent } from '../orchestrator/events.js';
import {
  aggregateProfile,
  readBoardVerdicts,
  readProfilingEvents,
  type EstimateActualsRecord,
  type ProfileReport,
} from './profile-aggregator.js';

// ── Defaults from RFC-0015 §11 Phase 5 + §12 ──────────────────────────

/**
 * Minimum dispatched-task count for `safe-to-promote`. Below this, the
 * recommendation is forced to `insufficient-data` regardless of the
 * unattended-completion rate (a 100% rate over 3 tasks is meaningless).
 * 20 is the RFC §11 Phase 5 floor ("≥20 tasks across 3 RFCs"). Tunable
 * via `--min-tasks`.
 */
const DEFAULT_MIN_TASKS = 20;

/**
 * Minimum distinct-backlog-task count for `safe-to-promote`. RFC §11
 * Phase 5 requires "≥3 RFCs" in the corpus; we operationalise that as
 * "≥3 distinct task IDs" since RFC tagging isn't carried on the events
 * stream and the orchestrator dispatches per-task, not per-RFC. A
 * three-task corpus that touches three RFCs satisfies both readings;
 * a three-task corpus that re-runs the same task three times does not.
 * Tunable via `--min-distinct-tasks`.
 */
const DEFAULT_MIN_DISTINCT_TASKS = 3;

/**
 * Unattended-completion rate floor per RFC §11 Phase 5 acceptance ("95%+
 * tasks complete without human intervention"). Tunable via
 * `--unattended-threshold`. Operationalised as
 * `(completed + recovered) / dispatched`.
 */
const DEFAULT_UNATTENDED_THRESHOLD = 0.95;

/**
 * Quota-burn-surprise ceiling. RFC §11 Phase 5 calls for "no quota-burn
 * surprise" against §12's projection (~200k tokens/task). We
 * operationalise "no surprise" as "actual ≤ 110% of projected"; a higher
 * ratio means the autonomous run consumed materially more tokens than
 * the RFC §12 cost model anticipated, and `default-on` would risk
 * mid-batch quota exhaustion. Tunable via `--quota-burn-threshold`.
 *
 * `0` runs that have NO token data (e.g. older Phase 4 events that
 * predate the optional `context.tokens` field) are treated as ratio
 * `0` for aggregation purposes — they don't contribute to the burn-rate
 * signal but also don't poison it.
 */
const DEFAULT_QUOTA_BURN_THRESHOLD = 1.1;

/**
 * Per-task token projection from RFC-0015 §12 ("avg ~200k tokens/task").
 * Tunable via `--tokens-per-task` so operators can override per-tier
 * (Max-20x's avg may differ from the §12 baseline).
 */
const DEFAULT_TOKENS_PER_TASK = 200_000;

// ── Public types ──────────────────────────────────────────────────────

export type Recommendation = 'insufficient-data' | 'safe-to-promote' | 'continue-soak';

/**
 * One row in the per-run breakdown — derived from all events sharing a
 * single `runId`. The orchestrator stamps `runId` on every emitted event
 * (see `loop.ts#runOrchestratorLoop`); events that lack a `runId`
 * (theoretically possible if a future event type is added without the
 * envelope) are bucketed into a synthetic `'(unknown-run)'` group.
 */
export interface RunSummary {
  /** Orchestrator session UUID (or `'(unknown-run)'` for envelope-less events). */
  runId: string;
  /** Earliest `ts` observed in the run. */
  firstSeen: string;
  /** Latest `ts` observed in the run. */
  lastSeen: string;
  /** Distinct task IDs dispatched in this run. */
  distinctTaskIds: number;
  /** Tasks dispatched (`OrchestratorDispatched` events). */
  dispatched: number;
  /** Successful completions (`OrchestratorCompleted` with outcome=approved). */
  completed: number;
  /**
   * Auto-recovered failures (`OrchestratorRecovered`). Counts toward the
   * "unattended" numerator since the operator wasn't pulled in.
   */
  recovered: number;
  /**
   * Failures that escalated to a human (`OrchestratorFailed`). These are
   * the denominator-but-not-numerator side of the unattended rate.
   */
  humanAttention: number;
  /**
   * `(completed + recovered) / dispatched`. `0` when `dispatched === 0`.
   */
  unattendedRate: number;
  /**
   * Sum of `context.tokens` from completion + failure events, when
   * present. `0` when no events carried token data — the `quotaBurnRatio`
   * field encodes the "no data" case as `0` so consumers can `===`-check.
   */
  tokensConsumed: number;
  /** `dispatched * tokensPerTask`. */
  tokensProjected: number;
  /**
   * `tokensConsumed / tokensProjected`. `0` when no token data was
   * captured for the run; `>1.10` is the default surprise threshold.
   */
  quotaBurnRatio: number;
  /**
   * Per-failure-mode tally. Keys are `FailureMode` values from
   * `pipeline-cli/src/orchestrator/playbook/types.ts`; the catch-all
   * `'UnknownFailureMode'` is included.
   */
  failureModes: Record<string, number>;
}

export interface AggregateMetrics {
  /** Total runs in the corpus. */
  runCount: number;
  /** Number of files we attempted to read. */
  filesRead: number;
  /** Number of files we couldn't parse (forensic). */
  skippedFiles: number;
  /** Number of malformed JSONL lines skipped across all files. */
  skippedLines: number;
  /** Sum of `dispatched` across all runs. */
  dispatched: number;
  /** Sum of `completed` across all runs. */
  completed: number;
  /** Sum of `recovered` across all runs. */
  recovered: number;
  /** Sum of `humanAttention` across all runs. */
  humanAttention: number;
  /** Distinct task IDs across the entire corpus (de-duplicated across runs). */
  distinctTaskIds: number;
  /**
   * Corpus-wide unattended completion rate:
   * `(completed + recovered) / dispatched`. `0` when nothing was dispatched.
   */
  unattendedRate: number;
  /**
   * Number of runs where `quotaBurnRatio > quotaBurnThreshold` (e.g.
   * actual > 110% of projected). Counts only runs that carried token
   * data; "no data" runs are excluded from the numerator AND denominator
   * to avoid penalising older artifacts.
   */
  quotaBurnSurprises: number;
  /**
   * Number of runs that DID carry token data — the denominator for the
   * `quotaBurnSurpriseRate` field. Use this to detect "we have lots of
   * runs but no token data was captured" scenarios.
   */
  runsWithTokenData: number;
  /**
   * `quotaBurnSurprises / runsWithTokenData`. `0` when no runs carried
   * token data.
   */
  quotaBurnSurpriseRate: number;
  /** Per-failure-mode tally summed across the corpus. */
  failureModes: Record<string, number>;
  /** Operator-facing recommendation. */
  recommendation: Recommendation;
  /** Human-readable rationale (operator log line). */
  reason: string;
}

export interface CorpusReport {
  perRun: RunSummary[];
  aggregate: AggregateMetrics;
}

export interface AggregateOpts {
  /** Below this dispatched count, recommendation is forced `insufficient-data`. */
  minTasks?: number;
  /** Below this distinct-task count, recommendation is forced `insufficient-data`. */
  minDistinctTasks?: number;
  /** Unattended-completion rate floor for `safe-to-promote`. */
  unattendedThreshold?: number;
  /** Quota-burn ratio ceiling above which a run is counted as a surprise. */
  quotaBurnThreshold?: number;
  /** Per-task token projection (RFC §12 default 200_000). */
  tokensPerTask?: number;
}

// ── File walking ──────────────────────────────────────────────────────

/**
 * Recursively walk a directory and return every events file. Mirrors
 * `cli-deps-corpus#findSnapshotFiles` so operator workflows are
 * symmetric.
 *
 * Naming filter: `events-YYYY-MM-DD.jsonl` is the canonical writer
 * convention from `events.ts#eventsFilePath`; we also accept loose
 * `*.jsonl` so an operator who renames during download isn't penalised.
 *
 * Single-file inputs are also supported — a path that is itself a JSONL
 * file is returned as a single-element array.
 */
export function findEventsFiles(rootPath: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let s;
    try {
      s = statSync(current);
    } catch {
      continue;
    }
    if (s.isFile()) {
      if (current.endsWith('.jsonl')) out.push(current);
      continue;
    }
    if (!s.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const e of entries) stack.push(join(current, e));
  }
  return out.sort();
}

/**
 * Validate that an arbitrary parsed JSONL line is shape-compatible with
 * `OrchestratorEvent`. Structural duck-typing on the fields the
 * aggregator actually consumes — extra fields are fine, missing fields
 * aren't. Mirrors `cli-deps-corpus#isValidSnapshotRecord` so the two
 * aggregators have parallel skip-vs-poison semantics.
 *
 * The check is deliberately lenient on per-event-type required fields
 * (e.g. `OrchestratorDispatched` is supposed to carry `taskId`) — if a
 * dispatch event arrives without a taskId we still want to count it
 * as "an event happened" rather than silently drop the corpus's worth
 * of forensic signal. Per-type field absence shows up downstream as
 * `distinctTaskIds=0` which is itself diagnostic.
 */
export function isValidEvent(raw: unknown): raw is OrchestratorEvent {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.ts !== 'string' || e.ts.length === 0) return false;
  if (typeof e.type !== 'string' || e.type.length === 0) return false;
  return true;
}

export interface LoadedEventsFile {
  path: string;
  events: OrchestratorEvent[];
}

/**
 * Load + parse every events file from a list. Malformed lines are
 * silently skipped (counted), files that fail to parse entirely are
 * reported via `skippedFiles`. Matches the
 * `cli-deps-corpus#loadSnapshotCorpus` shape so the call sites read
 * identically.
 */
export function loadEventsCorpus(files: string[]): {
  files: LoadedEventsFile[];
  skippedFiles: number;
  skippedLines: number;
} {
  const loaded: LoadedEventsFile[] = [];
  let skippedFiles = 0;
  let skippedLines = 0;

  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      skippedFiles += 1;
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      // Empty file — count as skipped (no signal). Mirrors
      // cli-deps-corpus's "empty-file is unreadable-file" treatment so
      // operator output is symmetric.
      skippedFiles += 1;
      continue;
    }
    const events: OrchestratorEvent[] = [];
    let allMalformed = true;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!isValidEvent(parsed)) {
        skippedLines += 1;
        continue;
      }
      events.push(parsed);
      allMalformed = false;
    }
    if (allMalformed) {
      skippedFiles += 1;
      continue;
    }
    loaded.push({ path: f, events });
  }

  return { files: loaded, skippedFiles, skippedLines };
}

// ── Aggregation ──────────────────────────────────────────────────────

/**
 * Pull a numeric `tokens` from an event's `context` bag. The Phase 4
 * schema declares `context` as `additionalProperties: true` so future
 * event shapes can carry per-event overhead without a schema bump;
 * here we treat `tokens` as the conventional opt-in field for
 * subscription-burn instrumentation. Returns `0` when absent so callers
 * don't have to undefined-guard.
 */
function extractTokens(event: OrchestratorEvent): number {
  const ctx = event.context;
  if (!ctx || typeof ctx !== 'object') return 0;
  const tokens = (ctx as Record<string, unknown>).tokens;
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) return tokens;
  return 0;
}

/**
 * Bucket events by `runId` and derive the per-run + corpus-wide metrics
 * the recommendation envelope needs.
 *
 * Pure function — no I/O — so tests can pass synthetic event arrays
 * and snapshot the output. The CLI front-end is a thin shell around
 * `loadEventsCorpus()` + this function + a renderer.
 *
 * Recommendation gating (in priority order):
 *   - `dispatched < minTasks` OR `distinctTaskIds < minDistinctTasks`
 *                                                → 'insufficient-data'
 *   - `unattendedRate < unattendedThreshold`     → 'continue-soak'
 *   - `quotaBurnSurprises > 0`                   → 'continue-soak'
 *   - else                                       → 'safe-to-promote'
 *
 * The `reason` string is shaped so an operator can paste it into the
 * promotion PR body unchanged.
 */
export function aggregateOrchestratorCorpus(
  files: LoadedEventsFile[],
  opts: AggregateOpts = {},
  meta: { skippedFiles?: number; skippedLines?: number; filesRead?: number } = {},
): CorpusReport {
  const minTasks = opts.minTasks ?? DEFAULT_MIN_TASKS;
  const minDistinctTasks = opts.minDistinctTasks ?? DEFAULT_MIN_DISTINCT_TASKS;
  const unattendedThreshold = opts.unattendedThreshold ?? DEFAULT_UNATTENDED_THRESHOLD;
  const quotaBurnThreshold = opts.quotaBurnThreshold ?? DEFAULT_QUOTA_BURN_THRESHOLD;
  const tokensPerTask = opts.tokensPerTask ?? DEFAULT_TOKENS_PER_TASK;

  // Bucket by runId — the orchestrator stamps it on every emitted event,
  // and grouping by it is what makes "tasks per run" math work across
  // date-rotated files. Events that lack a runId (theoretically possible
  // if a future schema change drops it) are bucketed into a single
  // synthetic group rather than dropped — losing them would understate
  // the corpus + bias the recommendation toward `safe-to-promote`.
  const byRun = new Map<string, OrchestratorEvent[]>();
  const allTaskIds = new Set<string>();
  for (const f of files) {
    for (const e of f.events) {
      const runKey = typeof e.runId === 'string' && e.runId.length > 0 ? e.runId : '(unknown-run)';
      const bucket = byRun.get(runKey);
      if (bucket) bucket.push(e);
      else byRun.set(runKey, [e]);
      if (typeof e.taskId === 'string' && e.taskId.length > 0) allTaskIds.add(e.taskId);
    }
  }

  const perRun: RunSummary[] = [];
  for (const [runId, events] of byRun.entries()) {
    perRun.push(summariseRun(runId, events, tokensPerTask));
  }
  // Sort by firstSeen ascending so per-run rows render in calendar
  // order — same convention as cli-deps-corpus.
  perRun.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

  const dispatched = perRun.reduce((acc, r) => acc + r.dispatched, 0);
  const completed = perRun.reduce((acc, r) => acc + r.completed, 0);
  const recovered = perRun.reduce((acc, r) => acc + r.recovered, 0);
  const humanAttention = perRun.reduce((acc, r) => acc + r.humanAttention, 0);
  const unattendedRate = dispatched === 0 ? 0 : (completed + recovered) / dispatched;

  const runsWithTokenData = perRun.filter((r) => r.tokensConsumed > 0).length;
  const quotaBurnSurprises = perRun.filter(
    (r) => r.tokensConsumed > 0 && r.quotaBurnRatio > quotaBurnThreshold,
  ).length;
  const quotaBurnSurpriseRate =
    runsWithTokenData === 0 ? 0 : quotaBurnSurprises / runsWithTokenData;

  const failureModes: Record<string, number> = {};
  for (const r of perRun) {
    for (const [mode, n] of Object.entries(r.failureModes)) {
      failureModes[mode] = (failureModes[mode] ?? 0) + n;
    }
  }

  let recommendation: Recommendation;
  let reason: string;
  if (dispatched < minTasks || allTaskIds.size < minDistinctTasks) {
    recommendation = 'insufficient-data';
    reason =
      `dispatched=${dispatched} < minTasks=${minTasks}` +
      ` OR distinctTaskIds=${allTaskIds.size} < minDistinctTasks=${minDistinctTasks}` +
      ` — operator may use the spot-check promotion path` +
      ` (see docs/operations/orchestrator-promotion.md)`;
  } else if (unattendedRate < unattendedThreshold) {
    recommendation = 'continue-soak';
    reason =
      `unattendedRate=${(unattendedRate * 100).toFixed(1)}%` +
      ` below threshold=${(unattendedThreshold * 100).toFixed(1)}%` +
      ` — too many failures escalate to needs-human-attention`;
  } else if (quotaBurnSurprises > 0) {
    recommendation = 'continue-soak';
    reason =
      `quotaBurnSurprises=${quotaBurnSurprises}/${runsWithTokenData}` +
      ` runs exceeded ${(quotaBurnThreshold * 100).toFixed(0)}% of projection` +
      ` (RFC-0015 §12 ${tokensPerTask}/task) — investigate before flipping default-on`;
  } else {
    recommendation = 'safe-to-promote';
    reason =
      `dispatched=${dispatched} ≥ ${minTasks},` +
      ` distinctTaskIds=${allTaskIds.size} ≥ ${minDistinctTasks},` +
      ` unattendedRate=${(unattendedRate * 100).toFixed(1)}% ≥ ${(unattendedThreshold * 100).toFixed(1)}%,` +
      ` quotaBurnSurprises=0` +
      ` — flip AI_SDLC_AUTONOMOUS_ORCHESTRATOR default OFF → ON`;
  }

  return {
    perRun,
    aggregate: {
      runCount: perRun.length,
      filesRead: meta.filesRead ?? files.length,
      skippedFiles: meta.skippedFiles ?? 0,
      skippedLines: meta.skippedLines ?? 0,
      dispatched,
      completed,
      recovered,
      humanAttention,
      distinctTaskIds: allTaskIds.size,
      unattendedRate,
      quotaBurnSurprises,
      runsWithTokenData,
      quotaBurnSurpriseRate,
      failureModes,
      recommendation,
      reason,
    },
  };
}

function summariseRun(
  runId: string,
  events: OrchestratorEvent[],
  tokensPerTask: number,
): RunSummary {
  let firstSeen = events[0]?.ts ?? '';
  let lastSeen = events[0]?.ts ?? '';
  let dispatched = 0;
  let completed = 0;
  let recovered = 0;
  let humanAttention = 0;
  let tokensConsumed = 0;
  const taskIds = new Set<string>();
  const failureModes: Record<string, number> = {};

  for (const e of events) {
    if (e.ts < firstSeen) firstSeen = e.ts;
    if (e.ts > lastSeen) lastSeen = e.ts;
    if (typeof e.taskId === 'string' && e.taskId.length > 0 && e.taskId !== '(unknown)') {
      taskIds.add(e.taskId);
    }
    switch (e.type) {
      case 'OrchestratorDispatched':
        dispatched += 1;
        break;
      case 'OrchestratorCompleted': {
        // Only count outcome=approved as a clean completion. A
        // completion event whose outcome is `needs-human-attention`
        // also fires an `OrchestratorFailed` per the loop's flow (see
        // loop.ts) so the failed-events counter captures it; we don't
        // double-count it here.
        const outcome = typeof e.outcome === 'string' ? e.outcome : '';
        if (outcome === 'approved') completed += 1;
        tokensConsumed += extractTokens(e);
        break;
      }
      case 'OrchestratorRecovered':
        recovered += 1;
        tokensConsumed += extractTokens(e);
        break;
      case 'OrchestratorFailed': {
        humanAttention += 1;
        const mode = typeof e.mode === 'string' ? e.mode : 'UnknownFailureMode';
        failureModes[mode] = (failureModes[mode] ?? 0) + 1;
        tokensConsumed += extractTokens(e);
        break;
      }
      default:
        // Tick / Dispatched / WorkerStateTransition / AwaitingExternal —
        // no per-task counters but token data is still aggregated when
        // present (the loop may stamp tick-level overhead onto the
        // OrchestratorTick context bag in a future phase).
        tokensConsumed += extractTokens(e);
        break;
    }
  }

  const tokensProjected = dispatched * tokensPerTask;
  const quotaBurnRatio =
    tokensProjected === 0 || tokensConsumed === 0 ? 0 : tokensConsumed / tokensProjected;
  const unattendedRate = dispatched === 0 ? 0 : (completed + recovered) / dispatched;

  return {
    runId,
    firstSeen,
    lastSeen,
    distinctTaskIds: taskIds.size,
    dispatched,
    completed,
    recovered,
    humanAttention,
    unattendedRate,
    tokensConsumed,
    tokensProjected,
    quotaBurnRatio,
    failureModes,
  };
}

// ── CLI shell ────────────────────────────────────────────────────────

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

/**
 * Render an ASCII summary — same conventions as `cli-deps-corpus` so
 * the operator's eye doesn't have to retrain.
 */
function renderTable(report: CorpusReport): string {
  const headers = [
    'runId',
    'firstSeen',
    'dispatched',
    'completed',
    'recovered',
    'human-att',
    'unattended%',
    'burnRatio',
  ];
  const rows = report.perRun.map((r) => [
    shortRun(r.runId),
    r.firstSeen.replace('T', ' ').replace(/\.\d+Z$/, 'Z'),
    String(r.dispatched),
    String(r.completed),
    String(r.recovered),
    String(r.humanAttention),
    `${(r.unattendedRate * 100).toFixed(1)}`,
    r.tokensConsumed === 0 ? '-' : r.quotaBurnRatio.toFixed(2),
  ]);
  if (rows.length === 0) rows.push(['(none)', '-', '0', '0', '0', '0', '-', '-']);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const tbl = [fmt(headers), sep, ...rows.map(fmt)].join('\n');
  const a = report.aggregate;
  const modes = Object.entries(a.failureModes)
    .sort(([, n1], [, n2]) => n2 - n1)
    .map(([m, n]) => `${m}=${n}`)
    .join(' ');
  const summary =
    `\nCorpus: runs=${a.runCount}  files=${a.filesRead}` +
    `  skippedFiles=${a.skippedFiles}  skippedLines=${a.skippedLines}` +
    `\nDispatched: ${a.dispatched}  Completed: ${a.completed}` +
    `  Recovered: ${a.recovered}  Human-attention: ${a.humanAttention}` +
    `  DistinctTasks: ${a.distinctTaskIds}` +
    `\nUnattended completion rate: ${(a.unattendedRate * 100).toFixed(1)}%` +
    `\nQuota-burn surprises: ${a.quotaBurnSurprises}/${a.runsWithTokenData}` +
    ` runs (${(a.quotaBurnSurpriseRate * 100).toFixed(1)}%)` +
    `\nFailure modes: ${modes || '(none)'}` +
    `\nRecommendation: ${a.recommendation}` +
    `\nReason: ${a.reason}\n`;
  return tbl + '\n' + summary;
}

/** Trim a UUID to the first 8 chars for table rendering. */
function shortRun(runId: string): string {
  if (runId === '(unknown-run)') return runId;
  return runId.length > 12 ? runId.slice(0, 8) : runId;
}

// ── `profile` subcommand (AISDLC-479) ─────────────────────────────────

/**
 * Append `EstimateActualsRecorded` records to the monthly-rotated
 * `<artifactsDir>/_estimates/calibration-YYYY-MM.jsonl` (AC-3 / AC-4).
 * The month key is derived from each record's own `ts` so backfills land
 * in the correct historical file. Best-effort: write failures throw (the
 * caller surfaces them) but a missing dir is created on demand.
 *
 * Idempotency: records whose `taskId` already appears in the target
 * month's file are skipped (the aggregator can be re-run over the same
 * corpus without double-counting). Returns the number of records actually
 * appended.
 */
export function appendActualsToCalibration(
  artifactsDir: string,
  actuals: readonly EstimateActualsRecord[],
): { appended: number; skipped: number } {
  const estimatesDir = join(artifactsDir, '_estimates');
  let appended = 0;
  let skipped = 0;

  // Group by month so we read each target file once.
  const byMonth = new Map<string, EstimateActualsRecord[]>();
  for (const rec of actuals) {
    const monthKey = rec.ts.slice(0, 7); // YYYY-MM
    const bucket = byMonth.get(monthKey);
    if (bucket) bucket.push(rec);
    else byMonth.set(monthKey, [rec]);
  }

  for (const [monthKey, recs] of byMonth.entries()) {
    const path = join(estimatesDir, `calibration-${monthKey}.jsonl`);
    const existingTaskIds = readExistingActualsTaskIds(path);
    const lines: string[] = [];
    for (const rec of recs) {
      if (existingTaskIds.has(rec.taskId)) {
        skipped += 1;
        continue;
      }
      existingTaskIds.add(rec.taskId);
      lines.push(JSON.stringify(rec));
      appended += 1;
    }
    if (lines.length === 0) continue;
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, lines.join('\n') + '\n', { encoding: 'utf8' });
  }

  return { appended, skipped };
}

/** Read the taskIds already present in a calibration file (idempotency). */
function readExistingActualsTaskIds(path: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { taskId?: unknown; type?: unknown };
      if (
        r &&
        typeof r === 'object' &&
        r.type === 'EstimateActualsRecorded' &&
        typeof r.taskId === 'string'
      ) {
        out.add(r.taskId);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Render the profile report as an ASCII table (mirrors `renderTable`). */
function renderProfileTable(report: ProfileReport): string {
  const headers = ['taskId', 'durationMs', 'outcome', 'success', 'source'];
  const rows = report.perTask.map((t) => [
    t.taskId,
    t.durationMs === null ? '-' : String(t.durationMs),
    t.outcome,
    t.success ? 'yes' : 'no',
    t.source,
  ]);
  if (rows.length === 0) rows.push(['(none)', '-', '-', '-', '-']);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const tbl = [fmt(headers), sep, ...rows.map(fmt)].join('\n');
  const s = report.summary;
  const summary =
    `\nTasks: ${s.taskCount}  Success: ${s.successCount}` +
    `  Success rate: ${(s.successRate * 100).toFixed(1)}%` +
    `\nDuration samples: ${s.durationSampleCount}` +
    `  p50: ${s.p50DurationMs === null ? '-' : s.p50DurationMs}ms` +
    `  p95: ${s.p95DurationMs === null ? '-' : s.p95DurationMs}ms` +
    `  total: ${s.totalDurationMs}ms` +
    `\nActuals records: ${report.actuals.length}\n`;
  return tbl + '\n' + summary;
}

export function buildOrchestratorCorpusCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-orchestrator-corpus')
    .usage('Usage: $0 <command> [options]')
    .command(
      'aggregate <input>',
      'Aggregate one or more downloaded orchestrator events.jsonl files into an unattended-completion + quota-burn report and recommendation envelope.',
      (y) =>
        y
          .positional('input', {
            type: 'string',
            demandOption: true,
            describe:
              'Path to a directory of downloaded events artifacts (recurses into subdirs) or a single events-YYYY-MM-DD.jsonl file.',
          })
          .option('min-tasks', {
            type: 'number',
            default: DEFAULT_MIN_TASKS,
            describe:
              'Minimum dispatched-task count for safe-to-promote (RFC-0015 §11 Phase 5: ≥20).',
          })
          .option('min-distinct-tasks', {
            type: 'number',
            default: DEFAULT_MIN_DISTINCT_TASKS,
            describe:
              'Minimum distinct-task count for safe-to-promote (RFC-0015 §11 Phase 5: ≥3 RFCs ≈ ≥3 tasks).',
          })
          .option('unattended-threshold', {
            type: 'number',
            default: DEFAULT_UNATTENDED_THRESHOLD,
            describe: 'Unattended-completion rate floor (RFC-0015 §11 Phase 5: 95%).',
          })
          .option('quota-burn-threshold', {
            type: 'number',
            default: DEFAULT_QUOTA_BURN_THRESHOLD,
            describe:
              'Per-run quota-burn ratio above which a run counts as a surprise (default 1.10 = 110% of projection).',
          })
          .option('tokens-per-task', {
            type: 'number',
            default: DEFAULT_TOKENS_PER_TASK,
            describe:
              'Per-task token projection from RFC-0015 §12 (default 200000). Override per subscription tier if needed.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const input = String(argv.input);
        const files = findEventsFiles(input);
        const { files: loaded, skippedFiles, skippedLines } = loadEventsCorpus(files);
        const report = aggregateOrchestratorCorpus(
          loaded,
          {
            minTasks: argv['min-tasks'] as number,
            minDistinctTasks: argv['min-distinct-tasks'] as number,
            unattendedThreshold: argv['unattended-threshold'] as number,
            quotaBurnThreshold: argv['quota-burn-threshold'] as number,
            tokensPerTask: argv['tokens-per-task'] as number,
          },
          { skippedFiles, skippedLines, filesRead: files.length },
        );
        if (String(argv.format) === 'table') emitText(renderTable(report));
        else emit(report);
      },
    )
    .command(
      'profile',
      'Read orchestrator events + Dispatch-Board verdicts and emit a per-task + summary throughput report (count, p50/p95 durationMs, success rate). Optionally append EstimateActualsRecorded records to _estimates/calibration-YYYY-MM.jsonl (AISDLC-479).',
      (y) =>
        y
          .option('artifacts-dir', {
            type: 'string',
            describe:
              'Artifacts directory holding _orchestrator/events-*.jsonl + _estimates/. Defaults to $ARTIFACTS_DIR then ./artifacts.',
          })
          .option('board-dir', {
            type: 'string',
            describe:
              'Dispatch Board directory holding done/ + failed/ verdicts. Defaults to .ai-sdlc/dispatch.',
          })
          .option('write-actuals', {
            type: 'boolean',
            default: false,
            describe:
              'Append EstimateActualsRecorded records to _estimates/calibration-YYYY-MM.jsonl (idempotent by taskId).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const artifactsDir =
          (argv['artifacts-dir'] as string | undefined) ??
          process.env.ARTIFACTS_DIR ??
          join(process.cwd(), 'artifacts');
        const boardDir =
          (argv['board-dir'] as string | undefined) ?? join(process.cwd(), '.ai-sdlc', 'dispatch');

        const events = readProfilingEvents(artifactsDir);
        const verdicts = readBoardVerdicts(boardDir);
        const report = aggregateProfile(verdicts, events);

        let actualsWrite: { appended: number; skipped: number } | undefined;
        if (argv['write-actuals'] as boolean) {
          actualsWrite = appendActualsToCalibration(artifactsDir, report.actuals);
        }

        if (String(argv.format) === 'table') {
          emitText(renderProfileTable(report));
          if (actualsWrite) {
            emitText(
              `Actuals written: appended=${actualsWrite.appended} skipped=${actualsWrite.skipped}\n`,
            );
          }
        } else {
          emit({ ...report, ...(actualsWrite ? { actualsWrite } : {}) });
        }
      },
    )
    .demandCommand(
      1,
      'A subcommand is required (currently: aggregate, profile). Run with --help for the list.',
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runOrchestratorCorpusCli(): Promise<void> {
  await buildOrchestratorCorpusCli().parseAsync();
}
