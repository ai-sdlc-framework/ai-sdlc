/**
 * Filter 3 — External-dependency clearance (RFC-0015 §4.3 / Phase 3,
 * RFC-0014 §8 + Q3).
 *
 * Reads the candidate's `externalDependencies:` frontmatter (already parsed
 * into the dependency graph node by `buildDependencyGraph()`) and, per the
 * RFC §13 Q3 resolution embedded in the Phase 3 task description, gates
 * dispatch on entries with `kind: 'manual'` AND no operator-supplied
 * clearance signal. The other v1 kinds (`npm-version`, `github-pr`,
 * `url-head`, `other`) are surfaced in the event payload so operators can
 * see what the task is waiting on, but they do NOT block dispatch — the v1
 * resolver registry is "informational signal only" per RFC-0014 Q3.
 *
 * Operator clearance lives in `$ARTIFACTS_DIR/_orchestrator/cleared-external-deps.json`
 * — a JSON array of `{taskId, externalDepId}` records the operator
 * appends manually (or via a future `cli-orchestrator clear-external` CLI;
 * deferred to Phase 4 / AISDLC-169.4 alongside the events.jsonl writer).
 * Phase 3 reads the file when present and treats missing-file as
 * "nothing cleared" — the simplest possible v1 surface.
 *
 * Pure: reads the graph node + the clearance file. No git / network.
 *
 * @module orchestrator/filters/external-dependencies
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DependencyGraph,
  DependencyNode,
  ExternalDependency,
} from '../../deps/dependency-graph.js';
import type { FilterResult } from './types.js';

export interface CheckExternalDependenciesOpts {
  /** Pre-built dependency graph (shared across filters in the same tick). */
  graph: DependencyGraph;
  /** Candidate task ID. */
  taskId: string;
  /**
   * Optional override of `$ARTIFACTS_DIR`. When undefined the filter walks
   * `$ARTIFACTS_DIR` env or `./artifacts` — matches the convention used
   * everywhere else in the pipeline.
   */
  artifactsDir?: string;
  /**
   * Optional pre-loaded clearance set — tests + the Phase 4 future CLI
   * pass this directly so they don't have to round-trip through disk.
   * The set's elements are `<taskIdLower>::<externalDepId>` keys.
   */
  clearedKeys?: ReadonlySet<string>;
}

/**
 * Inspect the task's external deps + the operator clearance set and decide
 * whether the candidate should be admitted.
 */
export function checkExternalDependencies(opts: CheckExternalDependenciesOpts): FilterResult {
  const node = opts.graph.nodes.get(opts.taskId.toLowerCase());
  // Missing node = nothing to gate on (the dependency-readiness filter
  // already runs first and surfaces this as a blocker if relevant).
  if (!node) {
    return { filter: 'ExternalDependencies', passed: true };
  }

  const all = node.externalDependencies;
  if (all.length === 0) {
    return { filter: 'ExternalDependencies', passed: true };
  }

  const cleared = opts.clearedKeys ?? loadClearanceSet(opts.artifactsDir);
  const blocking = collectBlocking(node, all, cleared);

  if (blocking.length === 0) {
    return { filter: 'ExternalDependencies', passed: true };
  }

  const ids = blocking.map((d) => d.id).join(', ');
  return {
    filter: 'ExternalDependencies',
    passed: false,
    reason: `${blocking.length} manual external dep(s) unresolved: ${ids}`,
    detail: { kind: 'awaiting-external', blocking, all },
  };
}

function collectBlocking(
  node: DependencyNode,
  all: ExternalDependency[],
  cleared: ReadonlySet<string>,
): ExternalDependency[] {
  const out: ExternalDependency[] = [];
  for (const dep of all) {
    // v1 only gates on `manual` kind — other kinds are informational.
    if (dep.kind !== 'manual') continue;
    if (cleared.has(clearanceKey(node.id, dep.id))) continue;
    out.push(dep);
  }
  return out;
}

/** Stable composite key — task IDs are case-insensitive, dep IDs are not. */
function clearanceKey(taskId: string, externalDepId: string): string {
  return `${taskId.toLowerCase()}::${externalDepId}`;
}

interface ClearanceRecord {
  taskId: string;
  externalDepId: string;
}

function isClearanceRecord(value: unknown): value is ClearanceRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.taskId === 'string' && typeof v.externalDepId === 'string';
}

/**
 * Load the operator clearance set from
 * `<artifactsDir>/_orchestrator/cleared-external-deps.json`. Returns an
 * empty set when the file is missing OR malformed — a corrupt clearance
 * file should never silently admit a task it shouldn't, so the safe
 * default is "nothing cleared". (Operators see the file's malformed
 * state via the trace's blocking list; they can re-write the file to fix.)
 */
function loadClearanceSet(artifactsDir: string | undefined): ReadonlySet<string> {
  const base = artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
  const path = join(base, '_orchestrator', 'cleared-external-deps.json');
  if (!existsSync(path)) return new Set();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const out = new Set<string>();
  for (const entry of parsed) {
    if (!isClearanceRecord(entry)) continue;
    out.add(clearanceKey(entry.taskId, entry.externalDepId));
  }
  return out;
}
