/**
 * Pre-dispatch filter chain composer (RFC-0015 Phase 3 / AISDLC-169.3).
 *
 * Walks the filters in the order RFC §4.3 specifies and short-circuits
 * on the first failure. The chain is pure — it returns the trace + the
 * verdict; the loop is responsible for emitting the matching event +
 * requeueing the candidate for the next tick.
 *
 * Order is significant:
 *   - OrphanParent runs first — constant-time graph lookup, most decisive
 *     (an orphan parent isn't real dispatch work at all).
 *   - AlreadyInFlight runs second — catches mid-dispatch duplicates before
 *     the costlier dep/blast-radius checks.
 *   - DependencyReadiness runs third — in-memory graph walk (~µs), the
 *     most common blocking condition in practice. A dep-blocked task also
 *     overlapping a blast-radius should report the dep block (more
 *     actionable for the operator), so dep runs BEFORE blast-radius.
 *   - BlastRadiusOverlap (AISDLC-231) runs AFTER DependencyReadiness and
 *     BEFORE Dispatchability — it serialises tasks that overlap with
 *     in-flight file sets. The ordering ensures a dep-blocked task emits
 *     `OrchestratorBlockedByDependency` (root cause) rather than the less
 *     informative `OrchestratorBlockedByBlastRadiusOverlap`.
 *   - Dispatchability runs after BlastRadiusOverlap and before DorReadiness
 *     so permanently non-dispatchable tasks skip the DoR log scan.
 *   - DoR readiness is a single log file scan (~ms).
 *   - ExternalDependencies is a single JSON file read + frontmatter scan.
 *   - Blocked (AISDLC-223) runs last per AC #3.
 *
 * @module orchestrator/filters/chain
 */

import type { DependencyGraph } from '../../deps/dependency-graph.js';
import { checkAlreadyInFlight, type CheckAlreadyInFlightOpts } from './already-in-flight.js';
import {
  checkBlastRadiusOverlap,
  type CheckBlastRadiusOverlapOpts,
} from './blast-radius-overlap.js';
import { checkBlocked, type BlockedFrontmatter, type CheckBlockedOpts } from './blocked.js';
import {
  checkDependencyReadiness,
  type CheckDependencyReadinessOpts,
} from './dependency-readiness.js';
import { checkDispatchability, type CheckDispatchabilityOpts } from './dispatchability.js';
import { checkDorReadiness, type CheckDorReadinessOpts } from './dor-readiness.js';
import {
  checkExternalDependencies,
  type CheckExternalDependenciesOpts,
} from './external-dependencies.js';
import { checkOrphanParent, type CheckOrphanParentOpts } from './orphan-parent.js';
import { checkCapturesPending, type CheckCapturesPendingOpts } from './captures-pending.js';
import type { FilterChainResult, FilterResult } from './types.js';

export interface RunFilterChainOpts {
  /** Pre-built graph — shared across all filters in this tick. */
  graph: DependencyGraph;
  /** Candidate task ID. */
  taskId: string;
  /**
   * Frontmatter `labels:` for the candidate (case-insensitive bypass match).
   * The loop loads these once when it builds the candidate's filter context.
   */
  taskLabels?: readonly string[];
  /** Override of the calibration log path — defaults to the conventional location. */
  calibrationLogPath?: string;
  /** Override of `$ARTIFACTS_DIR` — used by both DoR + external-deps filters. */
  artifactsDir?: string;
  /**
   * Pre-loaded operator clearance set for external deps. When undefined the
   * external-deps filter walks `<artifactsDir>/_orchestrator/cleared-external-deps.json`.
   */
  clearedExternalKeys?: ReadonlySet<string>;
  /**
   * AISDLC-243 — pre-parsed `dispatchable:` frontmatter field for the candidate.
   * When undefined the Dispatchability filter treats the task as dispatchable
   * (backward-compatible with tasks that predate this field). `false` causes
   * the filter to reject the candidate immediately after DependencyReadiness.
   */
  taskDispatchable?: boolean;
  /**
   * AISDLC-243 — pre-parsed `dispatchableReason:` frontmatter field. Advisory
   * string carried in the filter trace + event payload so operators can see WHY
   * a task is non-dispatchable without opening the task file. Only meaningful
   * when `taskDispatchable === false`.
   */
  taskDispatchableReason?: string;
  /**
   * AISDLC-223 — pre-parsed `blocked:` frontmatter field for the candidate.
   * When undefined the Blocked filter treats the task as not blocked
   * (backward-compatible with tasks that predate this field). The loop loads
   * this alongside `taskLabels` so the chain stays I/O-free.
   */
  taskBlocked?: BlockedFrontmatter;
  /**
   * AISDLC-227 — options forwarded to `checkAlreadyInFlight`. When undefined
   * the filter uses defaults (reads `AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS`
   * from the environment; repoRoot defaults to `process.cwd()`).
   */
  alreadyInFlightOpts?: Pick<
    CheckAlreadyInFlightOpts,
    'repoRoot' | 'detectSubprocess' | 'listOpenPRs' | 'readProcessTable'
  >;
  /**
   * AISDLC-231 — options forwarded to `checkBlastRadiusOverlap`. When
   * undefined the filter uses defaults (repoRoot defaults to `process.cwd()`,
   * blast-radius computed from task frontmatter `references:`). Tests inject
   * stubs so they can drive the filter without filesystem access.
   */
  blastRadiusOverlapOpts?: Pick<
    CheckBlastRadiusOverlapOpts,
    'repoRoot' | 'backlogDir' | 'listOpenPRs' | 'computeBlastRadiusFiles'
  >;
  /**
   * AISDLC-269 — options forwarded to `checkCapturesPending`. When undefined
   * the filter uses defaults (reads `AI_SDLC_EMERGENT_CAPTURE` from the
   * environment; degrade-open when flag is unset). Tests inject `hasPendingCaptures`
   * stubs so they can drive the filter without a real captures directory.
   */
  capturesPendingOpts?: Pick<
    CheckCapturesPendingOpts,
    'artifactsDir' | 'hasPendingCaptures' | 'env'
  >;
}

/**
 * Run the eight filters in chain order against a single candidate.
 * Short-circuits on the first failure but ALWAYS returns the partial trace
 * so the loop's event emission carries the prefix of cleared filters.
 *
 * Order: OrphanParent (AISDLC-175) → AlreadyInFlight (AISDLC-227) →
 * DependencyReadiness → BlastRadiusOverlap (AISDLC-231) →
 * Dispatchability (AISDLC-243) → DorReadiness → ExternalDependencies →
 * Blocked (AISDLC-223) → CapturesPending (RFC-0024 / AISDLC-269).
 *
 * Rationale for DependencyReadiness BEFORE BlastRadiusOverlap: a task
 * that is both dep-blocked AND overlapping an in-flight blast-radius
 * should emit `OrchestratorBlockedByDependency` — the root cause visible
 * to the operator. `OrchestratorBlockedByBlastRadiusOverlap` is deferred
 * until deps are clear so it only fires when the overlap is the actual
 * blocker. Dispatchability runs AFTER BlastRadiusOverlap and BEFORE DoR
 * so permanently non-dispatchable tasks skip the DoR log scan entirely.
 * Blocked runs after ExternalDependencies per AC #3 of AISDLC-223.
 * CapturesPending runs last — it does a filesystem scan of the captures
 * directory and only fires when AI_SDLC_EMERGENT_CAPTURE is set (degrade-open).
 */
export function runFilterChain(opts: RunFilterChainOpts): FilterChainResult {
  const trace: FilterResult[] = [];

  // Filter 0 — orphan-parent detection (AISDLC-175). Cheapest + most
  // decisive: an orphan parent is bookkeeping work the framework should
  // handle, not real dispatch.
  const orphanOpts: CheckOrphanParentOpts = { graph: opts.graph, taskId: opts.taskId };
  const orphan = checkOrphanParent(orphanOpts);
  trace.push(orphan);
  if (!orphan.passed) return { passed: false, trace, failure: orphan };

  // Filter 0.5 — already-in-flight detection (AISDLC-227). Runs BEFORE the
  // dependency walk because the cost of a duplicate dispatch (worktree clash,
  // ~30s wasted setup) far outweighs the cost of a `gh pr list` + existsSync
  // + optional `ps -ax` call. Three signals: (a) open PR, (b) active worktree
  // sentinel, (c) live claude --print subprocess (behind env flag).
  const inflightOpts: CheckAlreadyInFlightOpts = {
    taskId: opts.taskId,
    ...opts.alreadyInFlightOpts,
  };
  const inflight = checkAlreadyInFlight(inflightOpts);
  trace.push(inflight);
  if (!inflight.passed) return { passed: false, trace, failure: inflight };

  // Filter 1 — dependency readiness. Runs BEFORE blast-radius overlap so
  // that a task blocked by both an open dependency AND an overlapping
  // blast-radius emits `OrchestratorBlockedByDependency` (root cause) rather
  // than the less actionable `OrchestratorBlockedByBlastRadiusOverlap`.
  const depOpts: CheckDependencyReadinessOpts = { graph: opts.graph, taskId: opts.taskId };
  const dep = checkDependencyReadiness(depOpts);
  trace.push(dep);
  if (!dep.passed) return { passed: false, trace, failure: dep };

  // Filter 1.5 — blast-radius overlap detection (AISDLC-231). Runs AFTER
  // DependencyReadiness (so dep-blocked tasks report the dep failure, not
  // the overlap) and BEFORE Dispatchability so permanently non-dispatchable
  // tasks skip the blast-radius file-set computation entirely.
  //
  // Degrade-open: candidates with an empty or uncomputable blast-radius are
  // admitted unconditionally. Env overrides (AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS
  // and AI_SDLC_BLAST_RADIUS_OVERLAP_BYPASS_TASK) are checked inside the filter.
  const blastRadiusOpts: CheckBlastRadiusOverlapOpts = {
    ...opts.blastRadiusOverlapOpts,
    // taskId MUST come last — the adapter type is Omit<..., 'taskId'> but
    // the underlying CheckBlastRadiusOverlapOpts requires it; ensure the
    // candidate's own id always wins over any stray injected value.
    taskId: opts.taskId,
  };
  const blastRadius = checkBlastRadiusOverlap(blastRadiusOpts);
  trace.push(blastRadius);
  if (!blastRadius.passed) return { passed: false, trace, failure: blastRadius };

  // Filter 2 — dispatchability gate (AISDLC-243). Runs AFTER BlastRadiusOverlap
  // and BEFORE DoR so we don't spend time scanning the calibration log for
  // tasks permanently marked non-dispatchable (soak phases, operator-only
  // steps, investigation tasks). The filter reads a single boolean from the
  // pre-loaded frontmatter — no I/O.
  const dispatchabilityOpts: CheckDispatchabilityOpts = {
    taskId: opts.taskId,
    dispatchable: opts.taskDispatchable,
    dispatchableReason: opts.taskDispatchableReason,
  };
  const dispatchability = checkDispatchability(dispatchabilityOpts);
  trace.push(dispatchability);
  if (!dispatchability.passed) return { passed: false, trace, failure: dispatchability };

  // Filter 3 — DoR readiness.
  const dorOpts: CheckDorReadinessOpts = { taskId: opts.taskId };
  if (opts.taskLabels !== undefined) dorOpts.taskLabels = opts.taskLabels;
  if (opts.calibrationLogPath !== undefined) dorOpts.calibrationLogPath = opts.calibrationLogPath;
  if (opts.artifactsDir !== undefined) dorOpts.artifactsDir = opts.artifactsDir;
  const dor = checkDorReadiness(dorOpts);
  trace.push(dor);
  if (!dor.passed) return { passed: false, trace, failure: dor };

  // Filter 4 — external dependencies.
  const extOpts: CheckExternalDependenciesOpts = { graph: opts.graph, taskId: opts.taskId };
  if (opts.artifactsDir !== undefined) extOpts.artifactsDir = opts.artifactsDir;
  if (opts.clearedExternalKeys !== undefined) extOpts.clearedKeys = opts.clearedExternalKeys;
  const ext = checkExternalDependencies(extOpts);
  trace.push(ext);
  if (!ext.passed) return { passed: false, trace, failure: ext };

  // Filter 5 — operator-blocked gate (AISDLC-223). Runs after ExternalDeps per AC #3.
  const blockedOpts: CheckBlockedOpts = {
    taskId: opts.taskId,
    blocked: opts.taskBlocked,
  };
  const blocked = checkBlocked(blockedOpts);
  trace.push(blocked);
  if (!blocked.passed) return { passed: false, trace, failure: blocked };

  // Filter 6 — captures-pending gate (RFC-0024 §9.3 / AISDLC-269). Runs last
  // so all other gates short-circuit before the filesystem scan. Degrade-open:
  // only fires when AI_SDLC_EMERGENT_CAPTURE is set.
  const capturesPendingOpts: CheckCapturesPendingOpts = {
    taskId: opts.taskId,
    ...opts.capturesPendingOpts,
  };
  const capturesPending = checkCapturesPending(capturesPendingOpts);
  trace.push(capturesPending);
  if (!capturesPending.passed) return { passed: false, trace, failure: capturesPending };

  return { passed: true, trace, failure: null };
}

/**
 * Format a chain trace as the human-readable block specified in the
 * RFC-0015 Phase 3 task description (Part B). The loop emits this once
 * per evaluated candidate so operators can grep `[orchestrator] filter trace`
 * to see the admission decision tree without parsing event JSON.
 */
export function formatFilterTrace(taskId: string, result: FilterChainResult): string {
  const lines: string[] = [];
  lines.push(`[orchestrator] filter trace for ${taskId}:`);
  for (const r of result.trace) {
    if (r.passed) {
      lines.push(`  - ${humanFilterName(r.filter)}: passed`);
    } else {
      lines.push(`  - ${humanFilterName(r.filter)}: failed (${r.reason ?? 'no reason'})`);
    }
  }
  if (result.passed) {
    lines.push(`  → admitted`);
  } else if (result.failure) {
    lines.push(`  → skipped, ${terminalNote(result.failure)}`);
  } else {
    // Defensive — every `passed: false` chain has a `failure` set; this
    // branch only fires if a future refactor breaks that invariant.
    lines.push(`  → skipped, reason unknown`);
  }
  return lines.join('\n');
}

function humanFilterName(filter: FilterResult['filter']): string {
  switch (filter) {
    case 'OrphanParent':
      return 'Orphan-parent check';
    case 'AlreadyInFlight':
      return 'Already-in-flight check';
    case 'BlastRadiusOverlap':
      return 'Blast-radius overlap check';
    case 'DependencyReadiness':
      return 'Dependency check';
    case 'Dispatchability':
      return 'Dispatchability check';
    case 'DorReadiness':
      return 'DoR readiness';
    case 'ExternalDependencies':
      return 'External deps';
    case 'Blocked':
      return 'Operator-blocked check';
    case 'CapturesPending':
      return 'Captures-pending check (RFC-0024)';
  }
}

function terminalNote(failure: FilterResult): string {
  switch (failure.detail?.kind) {
    case 'already-in-flight':
      return `already in flight (${failure.detail.description})`;
    case 'blast-radius-overlap':
      return `blast-radius overlap with in-flight ${failure.detail.inFlightTaskId} (${failure.detail.overlap.slice(0, 3).join(', ')})`;
    case 'dependency-blocked':
      return 'awaiting dependency';
    case 'not-dispatchable':
      return `non-dispatchable: ${failure.detail.dispatchableReason}`;
    case 'dor-blocked':
      return 'awaiting DoR clarification';
    case 'awaiting-external':
      return 'awaiting external';
    case 'orphan-parent-needs-closure':
      return 'orphan parent needs closure';
    case 'blocked':
      return `operator-blocked: ${failure.reason ?? 'no reason'}`;
    case 'captures-pending':
      return `emergent captures pending triage for ${failure.detail.issueId} — run cli-capture list --pending`;
    default:
      return failure.reason ?? 'filter rejected';
  }
}
