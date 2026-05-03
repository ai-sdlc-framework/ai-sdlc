/**
 * Pre-dispatch filter chain composer (RFC-0015 Phase 3 / AISDLC-169.3).
 *
 * Walks the three filters in the order RFC §4.3 specifies and short-circuits
 * on the first failure. The chain is pure — it returns the trace + the
 * verdict; the loop is responsible for emitting the matching event +
 * requeueing the candidate for the next tick.
 *
 * Order is significant: dependency readiness is the cheapest check (in-memory
 * graph walk, ~µs) and the most common failure mode in practice, so it runs
 * first. DoR readiness is a single log file scan (~ms). External dependencies
 * is a single JSON file read + a frontmatter inspection (~µs). Reordering
 * would shift cost without changing semantics — the §4.3 order matches both
 * the cost ranking and the human reading order in the RFC, so we keep it.
 *
 * @module orchestrator/filters/chain
 */

import type { DependencyGraph } from '../../deps/dependency-graph.js';
import {
  checkDependencyReadiness,
  type CheckDependencyReadinessOpts,
} from './dependency-readiness.js';
import { checkDorReadiness, type CheckDorReadinessOpts } from './dor-readiness.js';
import {
  checkExternalDependencies,
  type CheckExternalDependenciesOpts,
} from './external-dependencies.js';
import type { FilterChainResult, FilterResult } from './types.js';

export interface RunFilterChainOpts {
  /** Pre-built graph — shared across all three filters in this tick. */
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
}

/**
 * Run the three filters in §4.3 order against a single candidate.
 * Short-circuits on the first failure but ALWAYS returns the partial trace
 * so the loop's event emission carries the prefix of cleared filters.
 */
export function runFilterChain(opts: RunFilterChainOpts): FilterChainResult {
  const trace: FilterResult[] = [];

  // Filter 1 — dependency readiness.
  const depOpts: CheckDependencyReadinessOpts = { graph: opts.graph, taskId: opts.taskId };
  const dep = checkDependencyReadiness(depOpts);
  trace.push(dep);
  if (!dep.passed) return { passed: false, trace, failure: dep };

  // Filter 2 — DoR readiness.
  const dorOpts: CheckDorReadinessOpts = { taskId: opts.taskId };
  if (opts.taskLabels !== undefined) dorOpts.taskLabels = opts.taskLabels;
  if (opts.calibrationLogPath !== undefined) dorOpts.calibrationLogPath = opts.calibrationLogPath;
  if (opts.artifactsDir !== undefined) dorOpts.artifactsDir = opts.artifactsDir;
  const dor = checkDorReadiness(dorOpts);
  trace.push(dor);
  if (!dor.passed) return { passed: false, trace, failure: dor };

  // Filter 3 — external dependencies.
  const extOpts: CheckExternalDependenciesOpts = { graph: opts.graph, taskId: opts.taskId };
  if (opts.artifactsDir !== undefined) extOpts.artifactsDir = opts.artifactsDir;
  if (opts.clearedExternalKeys !== undefined) extOpts.clearedKeys = opts.clearedExternalKeys;
  const ext = checkExternalDependencies(extOpts);
  trace.push(ext);
  if (!ext.passed) return { passed: false, trace, failure: ext };

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
    case 'DependencyReadiness':
      return 'Dependency check';
    case 'DorReadiness':
      return 'DoR readiness';
    case 'ExternalDependencies':
      return 'External deps';
  }
}

function terminalNote(failure: FilterResult): string {
  switch (failure.detail?.kind) {
    case 'dependency-blocked':
      return 'awaiting dependency';
    case 'dor-blocked':
      return 'awaiting DoR clarification';
    case 'awaiting-external':
      return 'awaiting external';
    default:
      return failure.reason ?? 'filter rejected';
  }
}
