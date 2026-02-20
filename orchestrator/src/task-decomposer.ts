/**
 * Task decomposition — splits complex issues into parallelizable subtasks
 * using deterministic rules based on module boundaries, file type, and concern.
 *
 * Design decision D1: Rule-based, not LLM-based. Complexity >= 6 triggers decomposition.
 */

import type { ModuleGraph, ModuleInfo } from './analysis/types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface SubTask {
  id: string;
  title: string;
  description: string;
  /** Module boundary this subtask targets, if any. */
  module?: string;
  /** File patterns this subtask should touch. */
  filePatterns: string[];
  /** Concern category. */
  concern: 'code' | 'test' | 'docs' | 'config' | 'refactor';
  /** Estimated relative complexity (1-5). */
  estimatedComplexity: number;
  /** IDs of subtasks this depends on. */
  dependsOn: string[];
}

export interface TaskGraph {
  issueNumber: number;
  issueTitle: string;
  complexity: number;
  subtasks: SubTask[];
  /** Whether decomposition was triggered. */
  decomposed: boolean;
}

export interface DecompositionContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  complexity: number;
  /** Module graph from codebase analysis. */
  moduleGraph?: ModuleGraph;
  /** Files mentioned or likely affected. */
  affectedFiles?: string[];
}

export interface DecompositionOptions {
  /** Minimum complexity score to trigger decomposition. Defaults to 6. */
  complexityThreshold?: number;
  /** Maximum subtasks to generate. Defaults to 8. */
  maxSubtasks?: number;
}

// ── Decomposition Engine ─────────────────────────────────────────────

const DEFAULT_COMPLEXITY_THRESHOLD = 6;
const DEFAULT_MAX_SUBTASKS = 8;

/**
 * Decompose an issue into a task graph of subtasks.
 * Returns a single-task graph if complexity is below threshold.
 */
export function decomposeTask(
  ctx: DecompositionContext,
  options: DecompositionOptions = {},
): TaskGraph {
  const threshold = options.complexityThreshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
  const maxSubtasks = options.maxSubtasks ?? DEFAULT_MAX_SUBTASKS;

  // Below threshold: no decomposition
  if (ctx.complexity < threshold) {
    return {
      issueNumber: ctx.issueNumber,
      issueTitle: ctx.issueTitle,
      complexity: ctx.complexity,
      decomposed: false,
      subtasks: [
        {
          id: `${ctx.issueNumber}-main`,
          title: ctx.issueTitle,
          description: ctx.issueBody,
          filePatterns: ['**/*'],
          concern: 'code',
          estimatedComplexity: ctx.complexity,
          dependsOn: [],
        },
      ],
    };
  }

  const subtasks: SubTask[] = [];
  let taskCounter = 0;

  const nextId = () => {
    taskCounter++;
    return `${ctx.issueNumber}-${taskCounter}`;
  };

  // Strategy 1: Split by module boundary
  if (ctx.moduleGraph && ctx.moduleGraph.modules.length > 1) {
    const affectedModules = findAffectedModules(ctx.moduleGraph, ctx.affectedFiles);
    if (affectedModules.length > 1) {
      // Order modules by dependency: upstream first
      const ordered = topologicalSort(affectedModules, ctx.moduleGraph);
      for (const mod of ordered) {
        if (subtasks.length >= maxSubtasks) break;
        const deps = findModuleDependencyTasks(mod, ordered, subtasks, ctx.moduleGraph);
        subtasks.push({
          id: nextId(),
          title: `Implement changes in ${mod.name}`,
          description: `Apply changes to module "${mod.name}" at ${mod.path}`,
          module: mod.name,
          filePatterns: [`${mod.path}/**/*`],
          concern: 'code',
          estimatedComplexity: Math.min(5, Math.ceil(ctx.complexity / ordered.length) + 1),
          dependsOn: deps,
        });
      }
    }
  }

  // Strategy 2: Split by concern (code vs test vs docs)
  if (subtasks.length === 0) {
    const concerns = classifyConcerns(ctx.issueBody, ctx.affectedFiles);
    for (const concern of concerns) {
      if (subtasks.length >= maxSubtasks) break;
      const deps =
        concern.concern === 'test'
          ? subtasks.filter((s) => s.concern === 'code').map((s) => s.id)
          : concern.concern === 'docs'
            ? subtasks.filter((s) => s.concern === 'code' || s.concern === 'test').map((s) => s.id)
            : [];
      subtasks.push({
        id: nextId(),
        ...concern,
        dependsOn: deps,
      });
    }
  }

  // Fallback: single task if strategies yielded nothing
  if (subtasks.length === 0) {
    subtasks.push({
      id: nextId(),
      title: ctx.issueTitle,
      description: ctx.issueBody,
      filePatterns: ['**/*'],
      concern: 'code',
      estimatedComplexity: ctx.complexity,
      dependsOn: [],
    });
  }

  return {
    issueNumber: ctx.issueNumber,
    issueTitle: ctx.issueTitle,
    complexity: ctx.complexity,
    decomposed: subtasks.length > 1,
    subtasks,
  };
}

/**
 * Validate a TaskGraph for consistency (no dangling deps, no cycles).
 */
export function validateTaskGraph(graph: TaskGraph): string[] {
  const errors: string[] = [];
  const ids = new Set(graph.subtasks.map((s) => s.id));

  for (const task of graph.subtasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Check for cycles
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const taskMap = new Map(graph.subtasks.map((s) => [s.id, s]));

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependsOn) {
        if (hasCycle(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const task of graph.subtasks) {
    visited.clear();
    visiting.clear();
    if (hasCycle(task.id)) {
      errors.push(`Cycle detected involving task "${task.id}"`);
      break;
    }
  }

  return errors;
}

/**
 * Get subtasks in execution order (respecting dependencies).
 * Returns layers: each layer contains tasks that can run in parallel.
 */
export function getExecutionLayers(graph: TaskGraph): SubTask[][] {
  const layers: SubTask[][] = [];
  const completed = new Set<string>();
  const remaining = new Map(graph.subtasks.map((s) => [s.id, s]));

  while (remaining.size > 0) {
    const layer: SubTask[] = [];
    for (const [_id, task] of remaining) {
      if (task.dependsOn.every((dep) => completed.has(dep))) {
        layer.push(task);
      }
    }
    if (layer.length === 0) break; // No progress = cycle
    for (const task of layer) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
    layers.push(layer);
  }

  return layers;
}

// ── Internal Helpers ──────────────────────────────────────────────────

function findAffectedModules(graph: ModuleGraph, files?: string[]): ModuleInfo[] {
  if (!files || files.length === 0) return graph.modules;

  return graph.modules.filter((mod) =>
    files.some((f) => f.startsWith(mod.path) || f.includes(`/${mod.name}/`)),
  );
}

function topologicalSort(modules: ModuleInfo[], graph: ModuleGraph): ModuleInfo[] {
  const nameSet = new Set(modules.map((m) => m.name));
  const adjacency = new Map<string, string[]>();

  for (const mod of modules) {
    adjacency.set(mod.name, []);
  }
  for (const edge of graph.edges) {
    if (nameSet.has(edge.from) && nameSet.has(edge.to)) {
      adjacency.get(edge.from)?.push(edge.to);
    }
  }

  const sorted: ModuleInfo[] = [];
  const visited = new Set<string>();
  const modMap = new Map(modules.map((m) => [m.name, m]));

  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of adjacency.get(name) ?? []) {
      visit(dep);
    }
    const mod = modMap.get(name);
    if (mod) sorted.push(mod);
  }

  for (const mod of modules) {
    visit(mod.name);
  }

  return sorted;
}

function findModuleDependencyTasks(
  mod: ModuleInfo,
  _orderedModules: ModuleInfo[],
  existingTasks: SubTask[],
  graph: ModuleGraph,
): string[] {
  const deps: string[] = [];
  for (const edge of graph.edges) {
    if (edge.from === mod.name) {
      const depTask = existingTasks.find((t) => t.module === edge.to);
      if (depTask) deps.push(depTask.id);
    }
  }
  return deps;
}

interface ConcernResult {
  title: string;
  description: string;
  filePatterns: string[];
  concern: SubTask['concern'];
  estimatedComplexity: number;
}

function classifyConcerns(issueBody: string, files?: string[]): ConcernResult[] {
  const results: ConcernResult[] = [];
  const hasTests = files?.some((f) => /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__'));
  const hasDocs = files?.some((f) => /\.(md|mdx|rst)$/.test(f) || f.startsWith('docs/'));
  const hasConfig = files?.some((f) => /\.(json|yaml|yml|toml)$/.test(f) && !f.includes('test'));

  // Code implementation subtask
  results.push({
    title: 'Implement code changes',
    description: `Implement the core changes described in the issue.\n\n${issueBody.slice(0, 500)}`,
    filePatterns: ['src/**/*'],
    concern: 'code',
    estimatedComplexity: 3,
  });

  // Test subtask
  if (hasTests || issueBody.toLowerCase().includes('test')) {
    results.push({
      title: 'Write/update tests',
      description: 'Write or update tests to cover the code changes.',
      filePatterns: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
      concern: 'test',
      estimatedComplexity: 2,
    });
  }

  // Docs subtask
  if (hasDocs || issueBody.toLowerCase().includes('document')) {
    results.push({
      title: 'Update documentation',
      description: 'Update documentation to reflect the changes.',
      filePatterns: ['docs/**/*', '**/*.md'],
      concern: 'docs',
      estimatedComplexity: 1,
    });
  }

  // Config subtask
  if (hasConfig) {
    results.push({
      title: 'Update configuration',
      description: 'Update configuration files as needed.',
      filePatterns: ['**/*.json', '**/*.yaml', '**/*.yml'],
      concern: 'config',
      estimatedComplexity: 1,
    });
  }

  return results;
}
