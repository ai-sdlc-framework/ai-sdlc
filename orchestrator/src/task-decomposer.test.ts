import { describe, it, expect } from 'vitest';
import {
  decomposeTask,
  validateTaskGraph,
  getExecutionLayers,
  type DecompositionContext,
  type TaskGraph,
} from './task-decomposer.js';
import type { ModuleGraph, ModuleInfo } from './analysis/types.js';

function makeContext(overrides: Partial<DecompositionContext> = {}): DecompositionContext {
  return {
    issueNumber: 42,
    issueTitle: 'Fix flaky tests',
    issueBody: '## Description\nTests are flaky.\n\n## Acceptance Criteria\n- Stable tests',
    complexity: 3,
    ...overrides,
  };
}

function makeModuleGraph(
  modules: ModuleInfo[],
  edges: { from: string; to: string }[] = [],
): ModuleGraph {
  return {
    modules,
    edges: edges.map((e) => ({ ...e, importCount: 1 })),
    externalDependencies: [],
    cycles: [],
  };
}

describe('decomposeTask', () => {
  it('returns single task for low complexity', () => {
    const graph = decomposeTask(makeContext({ complexity: 3 }));
    expect(graph.decomposed).toBe(false);
    expect(graph.subtasks).toHaveLength(1);
    expect(graph.subtasks[0].id).toBe('42-main');
    expect(graph.subtasks[0].concern).toBe('code');
  });

  it('does not decompose at exact threshold - 1', () => {
    const graph = decomposeTask(makeContext({ complexity: 5 }));
    expect(graph.decomposed).toBe(false);
    expect(graph.subtasks).toHaveLength(1);
  });

  it('decomposes by module boundary when complexity >= 6', () => {
    const modules: ModuleInfo[] = [
      { name: 'core', path: 'src/core', fileCount: 10, dependencies: [], dependents: ['api'] },
      { name: 'api', path: 'src/api', fileCount: 5, dependencies: ['core'], dependents: [] },
    ];
    const moduleGraph = makeModuleGraph(modules, [{ from: 'api', to: 'core' }]);

    const graph = decomposeTask(
      makeContext({
        complexity: 7,
        moduleGraph,
        affectedFiles: ['src/core/index.ts', 'src/api/handler.ts'],
      }),
    );

    expect(graph.decomposed).toBe(true);
    expect(graph.subtasks.length).toBeGreaterThanOrEqual(2);
    expect(graph.subtasks.some((t) => t.module === 'core')).toBe(true);
    expect(graph.subtasks.some((t) => t.module === 'api')).toBe(true);
  });

  it('respects module dependency ordering', () => {
    const modules: ModuleInfo[] = [
      { name: 'base', path: 'src/base', fileCount: 3, dependencies: [], dependents: ['mid'] },
      { name: 'mid', path: 'src/mid', fileCount: 5, dependencies: ['base'], dependents: ['top'] },
      { name: 'top', path: 'src/top', fileCount: 2, dependencies: ['mid'], dependents: [] },
    ];
    const moduleGraph = makeModuleGraph(modules, [
      { from: 'mid', to: 'base' },
      { from: 'top', to: 'mid' },
    ]);

    const graph = decomposeTask(
      makeContext({
        complexity: 8,
        moduleGraph,
        affectedFiles: ['src/base/a.ts', 'src/mid/b.ts', 'src/top/c.ts'],
      }),
    );

    expect(graph.decomposed).toBe(true);
    // The base module task should have no deps, mid should depend on base task
    const baseTask = graph.subtasks.find((t) => t.module === 'base')!;
    const midTask = graph.subtasks.find((t) => t.module === 'mid')!;
    const topTask = graph.subtasks.find((t) => t.module === 'top')!;

    expect(baseTask.dependsOn).toHaveLength(0);
    expect(midTask.dependsOn).toContain(baseTask.id);
    expect(topTask.dependsOn).toContain(midTask.id);
  });

  it('decomposes by concern when no module graph', () => {
    const graph = decomposeTask(
      makeContext({
        complexity: 7,
        affectedFiles: ['src/handler.ts', 'src/handler.test.ts', 'docs/README.md'],
      }),
    );

    expect(graph.decomposed).toBe(true);
    expect(graph.subtasks.some((t) => t.concern === 'code')).toBe(true);
    expect(graph.subtasks.some((t) => t.concern === 'test')).toBe(true);
    expect(graph.subtasks.some((t) => t.concern === 'docs')).toBe(true);
  });

  it('test subtask depends on code subtask', () => {
    const graph = decomposeTask(
      makeContext({
        complexity: 7,
        affectedFiles: ['src/handler.ts', 'src/handler.test.ts'],
      }),
    );

    const codeTask = graph.subtasks.find((t) => t.concern === 'code')!;
    const testTask = graph.subtasks.find((t) => t.concern === 'test')!;
    expect(testTask.dependsOn).toContain(codeTask.id);
  });

  it('respects custom complexity threshold', () => {
    const graph = decomposeTask(
      makeContext({
        complexity: 4,
        affectedFiles: ['src/a.ts', 'src/a.test.ts'],
      }),
      { complexityThreshold: 4 },
    );
    expect(graph.decomposed).toBe(true);
  });

  it('respects maxSubtasks limit', () => {
    const modules: ModuleInfo[] = Array.from({ length: 10 }, (_, i) => ({
      name: `mod${i}`,
      path: `src/mod${i}`,
      fileCount: 3,
      dependencies: [],
      dependents: [],
    }));
    const moduleGraph = makeModuleGraph(modules);

    const graph = decomposeTask(
      makeContext({
        complexity: 9,
        moduleGraph,
        affectedFiles: modules.map((m) => `${m.path}/index.ts`),
      }),
      { maxSubtasks: 4 },
    );

    expect(graph.subtasks.length).toBeLessThanOrEqual(4);
  });

  it('falls back to single task when only one module', () => {
    const modules: ModuleInfo[] = [
      { name: 'only', path: 'src/only', fileCount: 10, dependencies: [], dependents: [] },
    ];
    const moduleGraph = makeModuleGraph(modules);

    const graph = decomposeTask(
      makeContext({
        complexity: 7,
        moduleGraph,
        affectedFiles: ['src/only/a.ts'],
      }),
    );

    // Should fall through to concern-based or single task
    expect(graph.subtasks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('validateTaskGraph', () => {
  it('returns no errors for valid graph', () => {
    const graph = decomposeTask(makeContext({ complexity: 3 }));
    expect(validateTaskGraph(graph)).toEqual([]);
  });

  it('detects dangling dependency', () => {
    const graph: TaskGraph = {
      issueNumber: 1,
      issueTitle: 'test',
      complexity: 7,
      decomposed: true,
      subtasks: [
        {
          id: '1-1',
          title: 'A',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: ['nonexistent'],
        },
      ],
    };
    const errors = validateTaskGraph(graph);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('nonexistent');
  });

  it('detects cycles', () => {
    const graph: TaskGraph = {
      issueNumber: 1,
      issueTitle: 'test',
      complexity: 7,
      decomposed: true,
      subtasks: [
        {
          id: 'a',
          title: 'A',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: ['b'],
        },
        {
          id: 'b',
          title: 'B',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: ['a'],
        },
      ],
    };
    const errors = validateTaskGraph(graph);
    expect(errors.some((e) => e.includes('Cycle'))).toBe(true);
  });
});

describe('getExecutionLayers', () => {
  it('returns single layer for independent tasks', () => {
    const graph: TaskGraph = {
      issueNumber: 1,
      issueTitle: 'test',
      complexity: 7,
      decomposed: true,
      subtasks: [
        {
          id: 'a',
          title: 'A',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: [],
        },
        {
          id: 'b',
          title: 'B',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: [],
        },
      ],
    };
    const layers = getExecutionLayers(graph);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(2);
  });

  it('returns multiple layers for dependent tasks', () => {
    const graph: TaskGraph = {
      issueNumber: 1,
      issueTitle: 'test',
      complexity: 7,
      decomposed: true,
      subtasks: [
        {
          id: 'a',
          title: 'A',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: [],
        },
        {
          id: 'b',
          title: 'B',
          description: '',
          filePatterns: [],
          concern: 'test',
          estimatedComplexity: 1,
          dependsOn: ['a'],
        },
        {
          id: 'c',
          title: 'C',
          description: '',
          filePatterns: [],
          concern: 'docs',
          estimatedComplexity: 1,
          dependsOn: ['b'],
        },
      ],
    };
    const layers = getExecutionLayers(graph);
    expect(layers).toHaveLength(3);
    expect(layers[0].map((t) => t.id)).toEqual(['a']);
    expect(layers[1].map((t) => t.id)).toEqual(['b']);
    expect(layers[2].map((t) => t.id)).toEqual(['c']);
  });

  it('handles diamond dependencies', () => {
    const graph: TaskGraph = {
      issueNumber: 1,
      issueTitle: 'test',
      complexity: 7,
      decomposed: true,
      subtasks: [
        {
          id: 'a',
          title: 'A',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: [],
        },
        {
          id: 'b',
          title: 'B',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: ['a'],
        },
        {
          id: 'c',
          title: 'C',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: ['a'],
        },
        {
          id: 'd',
          title: 'D',
          description: '',
          filePatterns: [],
          concern: 'code',
          estimatedComplexity: 1,
          dependsOn: ['b', 'c'],
        },
      ],
    };
    const layers = getExecutionLayers(graph);
    expect(layers).toHaveLength(3);
    expect(layers[0]).toHaveLength(1); // a
    expect(layers[1]).toHaveLength(2); // b, c in parallel
    expect(layers[2]).toHaveLength(1); // d
  });
});
