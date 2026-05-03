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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimpleYaml } from '../steps/01-validate.js';

export type TaskStatus = 'open' | 'completed';

/**
 * RFC-0014 §8 + Q3 resolution — kinds of external (non-backlog) dependencies a
 * task may declare. Pure signal in v1; the dispatcher does NOT block on them.
 *
 * Future v2 may add a resolver registry that turns each kind into a poll, at
 * which point `resolverHint` becomes the resolver-specific argument (e.g. the
 * npm package name for `npm-version`). For v1 the hint is a free-form string.
 */
export type ExternalDependencyKind = 'npm-version' | 'github-pr' | 'url-head' | 'manual' | 'other';

export interface ExternalDependency {
  /** Stable identifier for the external dep (e.g. "npm-foo-2.0"). */
  id: string;
  /** Human-readable description ("wait for foo v2 to publish"). */
  description: string;
  /** Kind of external dep — one of the five v1 enum values. */
  kind: ExternalDependencyKind;
  /** Optional resolver-specific argument (registry URL, PR number, etc.). */
  resolverHint?: string;
}

export interface DependencyNode {
  /** Canonical (case-preserving) task ID, e.g. "AISDLC-100.1". */
  id: string;
  /**
   * Effective dispatch status. A task is `'completed'` if EITHER its file lives
   * in `backlog/completed/`, OR it lives in `backlog/tasks/` but has
   * `status: Done` in frontmatter (a stale entry that hasn't been moved yet —
   * see AISDLC-153). Pure file-location signal lives on `fileLocation`.
   */
  status: TaskStatus;
  /** Where the file actually lives on disk, regardless of status field. */
  fileLocation: TaskStatus;
  /** Raw `status:` value from frontmatter (best-effort; empty if missing). */
  frontmatterStatus: string;
  /**
   * Raw `priority:` value from frontmatter, lowercased + trimmed. Empty string
   * when the field is absent. Per RFC-0014 §5.2 this is the per-task
   * `priority(T)` signal the Phase 2 dispatcher consumes via
   * `effectivePriority`. Surfacing as a string (not a numeric weight) keeps
   * the parser dumb — the weight mapping lives in `deps/effective-priority.ts`
   * so it can evolve without forcing a frontmatter rewrite.
   */
  priority: string;
  /** On-disk title from the frontmatter (best-effort; empty string if missing). */
  title: string;
  /** Outgoing edges — IDs this task depends on. */
  dependencies: string[];
  /**
   * RFC-0014 §8 + Q3 — out-of-graph blockers ("wait for npm v2 to publish",
   * "wait for upstream PR to merge", etc.). Surfaced in the snapshot artifact +
   * (Phase 3) the DoR comment + `cli-deps blockers`. Empty array when the task
   * declares none. Dispatcher behaviour is unchanged in v1; pure signal.
   */
  externalDependencies: ExternalDependency[];
  /**
   * File mtime as ISO-8601 (when the on-disk task file was last touched).
   * Best-effort; empty string if the stat failed. Used by the snapshot
   * artifact's `lastModified` field for recency tie-break heuristics.
   */
  lastModified: string;
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
 *
 * Stale entries (file in `backlog/tasks/` but `status: Done` in frontmatter,
 * AISDLC-153) are reclassified as `completed` for dispatch purposes and
 * surface a one-line warning via `onWarn`. The file location is preserved on
 * `fileLocation` so callers can still report on the on-disk picture.
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
    if (isDoneStatus(node.frontmatterStatus)) {
      // Stale entry — frontmatter says Done but file hasn't been moved.
      // Reclassify as completed so the frontier doesn't re-dispatch it, and
      // surface a warning so the operator can `git mv` + commit when they
      // get a chance.
      const reclassified: DependencyNode = { ...node, status: 'completed' };
      nodes.set(key, reclassified);
      completedIds.push(key);
      onWarn?.(
        `stale task: ${node.id} has status: ${node.frontmatterStatus} but file is still in backlog/tasks/ — ` +
          `move with: git mv "${node.filePath}" backlog/completed/`,
      );
    } else {
      nodes.set(key, node);
      openIds.push(key);
    }
  }
  for (const node of readDir(completedDir, 'completed', onWarn)) {
    const key = node.id.toLowerCase();
    // If a duplicate ID exists in BOTH directories (rare data bug), prefer the
    // completed entry as the canonical source — this matches dispatch intent
    // (the frontier check needs to know "is it done?"). If the open-side entry
    // was reclassified above, we also drop it from completedIds before re-adding
    // to keep the list dedup'd.
    if (nodes.has(key)) {
      const idx = completedIds.indexOf(key);
      if (idx >= 0) completedIds.splice(idx, 1);
    }
    nodes.set(key, node);
    completedIds.push(key);
  }

  return { nodes, openIds, completedIds };
}

/**
 * Backlog.md status values that mean "this task is done". Case-insensitive +
 * trims whitespace. We accept the canonical 'Done' plus a couple of common
 * synonyms operators sometimes type by hand.
 */
function isDoneStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === 'done' || s === 'completed' || s === 'shipped';
}

function readDir(
  dir: string,
  fileLocation: TaskStatus,
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
      const node = parseTaskFrontmatter(filePath, fileLocation);
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
 *
 * The `fileLocation` argument records where the file actually lives. The
 * returned node's `status` mirrors `fileLocation` here; `buildDependencyGraph`
 * is responsible for reclassifying stale entries (file in tasks/ but
 * frontmatter `status: Done`) per AISDLC-153.
 */
export function parseTaskFrontmatter(
  filePath: string,
  fileLocation: TaskStatus,
): DependencyNode | null {
  const raw = readFileSync(filePath, 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;
  const fmRaw = fmMatch[1];
  const fm = parseSimpleYaml(fmRaw);

  const id = String(fm.id ?? '').trim();
  if (!id) return null;

  const title = String(fm.title ?? '').trim();
  const frontmatterStatus = String(fm.status ?? '').trim();
  // RFC-0014 Phase 2 — surface the raw `priority:` frontmatter value so the
  // dispatcher comparator can read it without re-walking disk. Lowercased +
  // trimmed; empty string when absent. Numeric weight mapping lives in
  // `deps/effective-priority.ts`.
  const priority = String(fm.priority ?? '')
    .trim()
    .toLowerCase();

  let dependencies: string[] = [];
  if (Array.isArray(fm.dependencies)) {
    dependencies = (fm.dependencies as unknown[])
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
  }

  // `externalDependencies:` is a list of nested objects which `parseSimpleYaml`
  // can't represent — re-parse this single key with a focused walker. Empty
  // array when the field is absent.
  const externalDependencies = parseExternalDependenciesBlock(fmRaw);

  // mtime — best-effort; if the stat fails (file vanished mid-walk per the
  // RFC-0014 Q6 "best-effort consistency" contract) we degrade to '' rather
  // than crashing the whole snapshot.
  let lastModified = '';
  try {
    lastModified = statSync(filePath).mtime.toISOString();
  } catch {
    // ignore — surfaced as empty string in the snapshot
  }

  return {
    id,
    status: fileLocation,
    fileLocation,
    frontmatterStatus,
    priority,
    title,
    dependencies,
    externalDependencies,
    lastModified,
    filePath,
  };
}

/**
 * RFC-0014 §8 + Q3 — parse the `externalDependencies:` frontmatter block.
 *
 * `parseSimpleYaml` only handles flat scalars + lists of scalars; it can't
 * represent a list of objects. Rather than overhaul that helper (which is
 * shared by every step in the pipeline) we re-walk the raw frontmatter looking
 * specifically for the `externalDependencies:` block and parse its child
 * mappings. Format expected:
 *
 *     externalDependencies:
 *       - id: npm-foo-2.0
 *         description: 'wait for foo v2 to publish'
 *         kind: npm-version
 *         resolverHint: registry.npmjs.org/foo
 *       - id: pr-bar-123
 *         description: 'wait for upstream PR'
 *         kind: github-pr
 *
 * Returns `[]` when the block is absent or empty. Drops entries that lack
 * `id` / `description` / `kind` (best-effort tolerance — a malformed entry
 * shouldn't break the whole snapshot). Unknown `kind` values fall back to
 * `'other'` so we don't silently throw away data.
 */
export function parseExternalDependenciesBlock(fmRaw: string): ExternalDependency[] {
  const lines = fmRaw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^externalDependencies\s*:\s*$/.test(line)) break;
    i++;
  }
  if (i >= lines.length) return [];
  i++; // step past the `externalDependencies:` opener

  const out: ExternalDependency[] = [];
  // Accumulate each in-progress entry as a free-form string map; we narrow to
  // the typed shape only when we push it via `pushIfValid`. Avoids fighting
  // TS's `keyof ExternalDependency` indexed-write narrowing.
  let current: Record<string, string> | null = null;
  let baseIndent = -1;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (baseIndent === -1) baseIndent = indent;
    // Dedent below baseIndent OR a top-level (non-indented) key signals the
    // block has ended — push the in-progress entry and stop.
    if (indent < baseIndent) break;

    const itemMatch = line.match(/^(\s*)-\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (itemMatch) {
      // New item opener: `- key: value`
      if (current) pushIfValid(current, out);
      current = {};
      current[itemMatch[2]] = stripFmQuotes(itemMatch[3]);
      continue;
    }
    const kvMatch = line.match(/^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kvMatch && current) {
      current[kvMatch[1]] = stripFmQuotes(kvMatch[2]);
      continue;
    }
    // Unrecognised line — treat as block terminator (the next top-level frontmatter key).
    break;
  }
  if (current) pushIfValid(current, out);
  return out;
}

function pushIfValid(entry: Record<string, string>, out: ExternalDependency[]): void {
  const id = (entry.id ?? '').trim();
  const description = (entry.description ?? '').trim();
  const kindRaw = (entry.kind ?? '').trim();
  if (!id || !description || !kindRaw) return;
  const kind: ExternalDependencyKind = isKnownKind(kindRaw) ? kindRaw : 'other';
  const resolverHint = entry.resolverHint ? entry.resolverHint.trim() : undefined;
  const built: ExternalDependency = { id, description, kind };
  if (resolverHint) built.resolverHint = resolverHint;
  out.push(built);
}

function isKnownKind(value: string): value is ExternalDependencyKind {
  return (
    value === 'npm-version' ||
    value === 'github-pr' ||
    value === 'url-head' ||
    value === 'manual' ||
    value === 'other'
  );
}

function stripFmQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
