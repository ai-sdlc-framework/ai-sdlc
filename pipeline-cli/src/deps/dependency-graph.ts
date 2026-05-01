/**
 * Dependency graph for backlog tasks.
 *
 * Builds an in-memory DAG of task IDs by reading every `.md` file under
 * `<workDir>/backlog/tasks/` (open) and `<workDir>/backlog/completed/` (closed)
 * and parsing the `dependencies:` YAML frontmatter. Edges point from a task
 * to each of its dependencies (X → Y means "X depends on Y; Y must be Done
 * before X can start").
 *
 * Powers `cli-deps` subcommands:
 *  - `frontier`  — open tasks whose every dependency is already in completed/
 *  - `blockers`  — transitive dependency closure (open tasks gating a target)
 *  - `impact`    — reverse-edge closure (open tasks unblocked by a target)
 *  - `validate`  — cycle detection + dangling-reference detection
 *  - `graph`     — emit mermaid / DOT for human inspection
 *
 * Pure: only reads from disk via `node:fs`. No git / network calls.
 *
 * @module deps/dependency-graph
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimpleYaml } from '../steps/01-validate.js';

export type TaskStatus = 'open' | 'completed';

export interface DependencyNode {
  /** Canonical (case-preserving) task ID, e.g. "AISDLC-100.1". */
  id: string;
  /** Whether the task file lives in `backlog/tasks/` (open) or `backlog/completed/` (completed). */
  status: TaskStatus;
  /** On-disk title from the frontmatter (best-effort; empty string if missing). */
  title: string;
  /** Outgoing edges — IDs this task depends on. */
  dependencies: string[];
  /** Path to the on-disk task file. */
  filePath: string;
}

export interface DependencyGraph {
  /** Map keyed by lowercase task ID for case-insensitive lookup. */
  nodes: Map<string, DependencyNode>;
  /** All open task IDs (lowercase). */
  openIds: string[];
  /** All completed task IDs (lowercase). */
  completedIds: string[];
}

export interface BuildOptions {
  workDir: string;
}

/**
 * Walk `backlog/tasks/` + `backlog/completed/`, parse every `.md` file's
 * frontmatter, and assemble a DependencyGraph. Files that don't parse are
 * silently skipped (with a warning if `onWarn` is provided) so a single
 * malformed task doesn't break the whole graph.
 */
export function buildDependencyGraph(
  opts: BuildOptions,
  onWarn?: (msg: string) => void,
): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  const openIds: string[] = [];
  const completedIds: string[] = [];

  const tasksDir = join(opts.workDir, 'backlog', 'tasks');
  const completedDir = join(opts.workDir, 'backlog', 'completed');

  for (const node of readDir(tasksDir, 'open', onWarn)) {
    const key = node.id.toLowerCase();
    nodes.set(key, node);
    openIds.push(key);
  }
  for (const node of readDir(completedDir, 'completed', onWarn)) {
    const key = node.id.toLowerCase();
    // If a duplicate ID exists in BOTH directories (rare data bug), prefer the
    // completed entry as the canonical source — this matches dispatch intent
    // (the frontier check needs to know "is it done?").
    nodes.set(key, node);
    completedIds.push(key);
  }

  return { nodes, openIds, completedIds };
}

function readDir(
  dir: string,
  status: TaskStatus,
  onWarn?: (msg: string) => void,
): DependencyNode[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: DependencyNode[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const filePath = join(dir, name);
    try {
      const node = parseTaskFrontmatter(filePath, status);
      if (node) out.push(node);
    } catch (err) {
      onWarn?.(`failed to parse ${filePath}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Parse the YAML frontmatter of a backlog task file and return a DependencyNode.
 * Returns null if the file lacks frontmatter or has no `id` field — those aren't
 * graph nodes and shouldn't poison the build.
 */
export function parseTaskFrontmatter(filePath: string, status: TaskStatus): DependencyNode | null {
  const raw = readFileSync(filePath, 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;
  const fm = parseSimpleYaml(fmMatch[1]);

  const id = String(fm.id ?? '').trim();
  if (!id) return null;

  const title = String(fm.title ?? '').trim();

  let dependencies: string[] = [];
  if (Array.isArray(fm.dependencies)) {
    dependencies = (fm.dependencies as unknown[])
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
  }

  return { id, status, title, dependencies, filePath };
}

// ── Frontier ──────────────────────────────────────────────────────────

export interface FrontierEntry {
  id: string;
  title: string;
  dependencies: string[];
}

/**
 * The frontier = open tasks whose every dependency points at a completed task
 * (or has no dependencies at all). These are the tasks that are ready to
 * dispatch right now.
 *
 * Dependency IDs that don't resolve to ANY known node count as "not satisfied"
 * — `validate` will surface them separately as dangling refs, but until the
 * data is fixed, the safe default is to block dispatch.
 */
export function frontier(graph: DependencyGraph): FrontierEntry[] {
  const out: FrontierEntry[] = [];
  for (const openId of graph.openIds) {
    const node = graph.nodes.get(openId);
    if (!node) continue;
    if (allDependenciesCompleted(node, graph)) {
      out.push({ id: node.id, title: node.title, dependencies: node.dependencies });
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return out;
}

function allDependenciesCompleted(node: DependencyNode, graph: DependencyGraph): boolean {
  for (const dep of node.dependencies) {
    const depNode = graph.nodes.get(dep.toLowerCase());
    if (!depNode || depNode.status !== 'completed') return false;
  }
  return true;
}

// ── Transitive blockers / impact ──────────────────────────────────────

/**
 * Walk the transitive forward-edge closure of `taskId` and return every OPEN
 * task that gates it (excluding the target itself).
 */
export function blockers(graph: DependencyGraph, taskId: string): DependencyNode[] {
  const start = graph.nodes.get(taskId.toLowerCase());
  if (!start) return [];
  const visited = new Set<string>();
  const stack: string[] = [...start.dependencies];
  const out: DependencyNode[] = [];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const key = next.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    const node = graph.nodes.get(key);
    if (!node) continue; // dangling ref — surfaced by validate
    if (node.status === 'open') out.push(node);
    for (const d of node.dependencies) stack.push(d);
  }
  out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return out;
}

/**
 * Walk the transitive REVERSE-edge closure of `taskId` and return every OPEN
 * task that would unblock if the target closes (excluding the target itself).
 */
export function impact(graph: DependencyGraph, taskId: string): DependencyNode[] {
  const start = graph.nodes.get(taskId.toLowerCase());
  if (!start) return [];
  // Build reverse adjacency once.
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependencies) {
      const key = dep.toLowerCase();
      const arr = reverse.get(key) ?? [];
      arr.push(node.id);
      reverse.set(key, arr);
    }
  }

  const visited = new Set<string>();
  const stack: string[] = [...(reverse.get(start.id.toLowerCase()) ?? [])];
  const out: DependencyNode[] = [];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const key = next.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    const node = graph.nodes.get(key);
    if (!node) continue;
    if (node.status === 'open') out.push(node);
    for (const d of reverse.get(key) ?? []) stack.push(d);
  }
  out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return out;
}

// ── Validation: cycles + dangling references ──────────────────────────

export interface DanglingRef {
  /** The task whose dependency list contains the bad reference. */
  source: string;
  /** The non-existent dependency ID. */
  missing: string;
}

export interface ValidateReport {
  ok: boolean;
  /** Each detected cycle as an ordered list of task IDs (closing the loop). */
  cycles: string[][];
  /** Dependency edges that point at IDs not present in either tasks/ or completed/. */
  dangling: DanglingRef[];
}

/**
 * Detect cycles in the graph using iterative DFS with a recursion stack, AND
 * flag dependency references that don't resolve to any known task.
 *
 * Cycles are reported as the path from the re-entered node back to itself,
 * e.g. `[A, B, C, A]` for `A → B → C → A`. The same cycle may surface multiple
 * times (once per starting point); we de-dupe by canonicalising each cycle to
 * the lexicographically smallest rotation.
 */
export function validate(graph: DependencyGraph): ValidateReport {
  const dangling: DanglingRef[] = [];
  for (const node of graph.nodes.values()) {
    for (const dep of node.dependencies) {
      if (!graph.nodes.has(dep.toLowerCase())) {
        dangling.push({ source: node.id, missing: dep });
      }
    }
  }

  const cycles: string[][] = [];
  const seenCycles = new Set<string>();
  const visited = new Set<string>();

  for (const startKey of graph.nodes.keys()) {
    if (visited.has(startKey)) continue;
    // Iterative DFS, tracking the current path so we can extract cycles.
    const path: string[] = [];
    const onPath = new Set<string>();
    type Frame = { key: string; iter: Iterator<string> };
    const stack: Frame[] = [
      {
        key: startKey,
        iter: depsIterator(graph, startKey),
      },
    ];
    onPath.add(startKey);
    path.push(startKey);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const next = top.iter.next();
      if (next.done) {
        onPath.delete(top.key);
        path.pop();
        visited.add(top.key);
        stack.pop();
        continue;
      }
      const childKey = next.value.toLowerCase();
      if (!graph.nodes.has(childKey)) {
        // Dangling — already recorded above; skip recursion.
        continue;
      }
      if (onPath.has(childKey)) {
        // Cycle: extract the slice of `path` from childKey onward, append the
        // closing node, and canonicalise.
        const idx = path.indexOf(childKey);
        const cyclePath = path.slice(idx).concat(childKey);
        const canon = canonicalCycleKey(cyclePath);
        if (!seenCycles.has(canon)) {
          seenCycles.add(canon);
          // Map keys back to canonical IDs.
          cycles.push(cyclePath.map((k) => graph.nodes.get(k)?.id ?? k));
        }
        continue;
      }
      if (visited.has(childKey)) {
        continue;
      }
      onPath.add(childKey);
      path.push(childKey);
      stack.push({ key: childKey, iter: depsIterator(graph, childKey) });
    }
  }

  return { ok: cycles.length === 0 && dangling.length === 0, cycles, dangling };
}

function depsIterator(graph: DependencyGraph, key: string): Iterator<string> {
  const node = graph.nodes.get(key);
  const deps = node ? node.dependencies : [];
  return deps[Symbol.iterator]();
}

function canonicalCycleKey(path: string[]): string {
  // Strip the trailing closing element (= path[0]); rotate the cycle to start
  // at the lexicographically smallest member so equivalent cycles dedupe.
  if (path.length < 2) return path.join('->');
  const open = path.slice(0, -1).map((k) => k.toLowerCase());
  let bestStart = 0;
  for (let i = 1; i < open.length; i++) {
    if (open[i] < open[bestStart]) bestStart = i;
  }
  const rotated = open.slice(bestStart).concat(open.slice(0, bestStart));
  return rotated.join('->');
}

// ── Graph emission (mermaid / DOT) ────────────────────────────────────

export type GraphFormat = 'mermaid' | 'dot';

/**
 * Emit the graph in human-inspectable form. Open tasks render with one style,
 * completed with another, so the operator can eyeball the frontier.
 */
export function renderGraph(graph: DependencyGraph, format: GraphFormat): string {
  if (format === 'mermaid') return renderMermaid(graph);
  return renderDot(graph);
}

function renderMermaid(graph: DependencyGraph): string {
  const lines: string[] = ['flowchart TD'];
  for (const node of sortedNodes(graph)) {
    const safe = mermaidId(node.id);
    const label = node.title ? `${node.id}<br/>${escapeMermaidLabel(node.title)}` : node.id;
    if (node.status === 'completed') {
      lines.push(`  ${safe}["${label}"]:::done`);
    } else {
      lines.push(`  ${safe}["${label}"]:::open`);
    }
  }
  for (const node of sortedNodes(graph)) {
    const from = mermaidId(node.id);
    for (const dep of node.dependencies) {
      const target = graph.nodes.get(dep.toLowerCase());
      const to = mermaidId(target?.id ?? dep);
      lines.push(`  ${from} --> ${to}`);
    }
  }
  lines.push('  classDef open fill:#fffbe6,stroke:#d4a017,color:#3a2c00;');
  lines.push('  classDef done fill:#e6f4ea,stroke:#1e7c2e,color:#0c3a14;');
  return lines.join('\n') + '\n';
}

function renderDot(graph: DependencyGraph): string {
  const lines: string[] = ['digraph deps {', '  rankdir=LR;'];
  for (const node of sortedNodes(graph)) {
    const style =
      node.status === 'completed'
        ? 'style=filled,fillcolor="#e6f4ea",color="#1e7c2e"'
        : 'style=filled,fillcolor="#fffbe6",color="#d4a017"';
    const label = node.title ? `${node.id}\\n${escapeDotLabel(node.title)}` : node.id;
    lines.push(`  "${node.id}" [label="${label}",${style}];`);
  }
  for (const node of sortedNodes(graph)) {
    for (const dep of node.dependencies) {
      const target = graph.nodes.get(dep.toLowerCase());
      lines.push(`  "${node.id}" -> "${target?.id ?? dep}";`);
    }
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

function sortedNodes(graph: DependencyGraph): DependencyNode[] {
  return Array.from(graph.nodes.values()).sort((a, b) =>
    a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
}

function mermaidId(id: string): string {
  // Mermaid node IDs cannot contain dots or hyphens cleanly; rewrite to underscores.
  return id.replace(/[^A-Za-z0-9]/g, '_');
}

function escapeMermaidLabel(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, ' ');
}

function escapeDotLabel(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// ── Pre-flight check (for `/ai-sdlc execute <task-id>`) ──────────────

export interface PreflightResult {
  ok: boolean;
  /** Reason why the task can't be dispatched (empty if ok). */
  reason: string;
  /** Open dependencies that gate this task (one entry per direct OR transitive blocker). */
  blockers: DependencyNode[];
  /** Dangling references on the target itself (subset of `validate().dangling`). */
  dangling: DanglingRef[];
}

/**
 * Refuse to start a task whose dependencies aren't all Done. Used by the
 * `cli-deps preflight` subcommand and by the `/ai-sdlc execute` Step 1 gate.
 *
 *  - Returns ok=false if the target has any open transitive dependency, OR if
 *    any direct dependency points at an unknown task.
 *  - Returns ok=true (with empty arrays) if the target's dependencies are all
 *    completed (frontier-style readiness).
 *  - Special case: if the target ID itself isn't in the graph (e.g. a typo),
 *    returns ok=false with reason 'unknown task'.
 */
export function preflight(graph: DependencyGraph, taskId: string): PreflightResult {
  const target = graph.nodes.get(taskId.toLowerCase());
  if (!target) {
    return { ok: false, reason: `unknown task ${taskId}`, blockers: [], dangling: [] };
  }
  if (target.status === 'completed') {
    return {
      ok: false,
      reason: `${target.id} is already in backlog/completed/ — already shipped`,
      blockers: [],
      dangling: [],
    };
  }
  const dangling: DanglingRef[] = [];
  for (const dep of target.dependencies) {
    if (!graph.nodes.has(dep.toLowerCase())) {
      dangling.push({ source: target.id, missing: dep });
    }
  }
  const openBlockers = blockers(graph, taskId);
  if (openBlockers.length === 0 && dangling.length === 0) {
    return { ok: true, reason: '', blockers: [], dangling: [] };
  }
  const reasons: string[] = [];
  if (openBlockers.length > 0) {
    reasons.push(
      `${openBlockers.length} dependency(ies) not yet Done: ${openBlockers
        .map((b) => b.id)
        .join(', ')}`,
    );
  }
  if (dangling.length > 0) {
    reasons.push(
      `${dangling.length} dangling dependency reference(s): ${dangling
        .map((d) => d.missing)
        .join(', ')}`,
    );
  }
  return {
    ok: false,
    reason: reasons.join('; '),
    blockers: openBlockers,
    dangling,
  };
}
