import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderGraph } from '../cli/workflow.js';
import { DEFAULT_MAX_ITERATIONS } from '../steps/09-iterate.js';
import { buildExecuteGraph, MACHINE_STEPS, renderMermaid, renderYaml } from './graph.js';

const here = dirname(fileURLToPath(import.meta.url));
// Numbered step files the Machine never visits (no metadata by design).
const NOT_VISITED = new Set(['00-sweep.ts', '00-5-sync-parent.ts', '11-late-rebase.ts']);

describe('workflow graph', () => {
  it('step ids equal the node impls the Machine visits', () => {
    const ids = MACHINE_STEPS.map((s) => s.id).sort();
    const impls = Object.values(buildExecuteGraph().spec.nodes)
      .filter((n) => n.kind === 'step')
      .map((n) => n.impl)
      .sort();
    expect(impls).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every numbered step file exports metadata unless explicitly not visited', () => {
    const dir = join(here, '..', 'steps');
    const files = readdirSync(dir).filter((f) => /^\d.*\.ts$/.test(f) && !f.endsWith('.test.ts'));
    const withMeta = files.filter((f) => readFileSync(join(dir, f), 'utf8').includes('StepMeta'));
    const without = files.filter((f) => !withMeta.includes(f));
    expect(new Set(without)).toEqual(NOT_VISITED);
    expect(withMeta).toHaveLength(MACHINE_STEPS.length);
  });

  it('carries the loop cap and reviewer fan-out', () => {
    const doc = buildExecuteGraph();
    expect(doc.spec.edges.find((e) => e.loop)?.loop).toEqual({ max: DEFAULT_MAX_ITERATIONS });
    expect(doc.spec.nodes.review.kind).toBe('fanout');
  });

  it('yaml matches the golden file', () => {
    const golden = readFileSync(
      join(here, '..', '..', 'test', 'fixtures', 'workflow', 'execute-task.golden.yaml'),
      'utf8',
    );
    expect(renderYaml(buildExecuteGraph())).toBe(golden);
  });

  it('renders mermaid and selects format', () => {
    const m = renderMermaid(buildExecuteGraph());
    expect(m.startsWith('flowchart TD')).toBe(true);
    expect(m).toContain('loop max');
    expect(renderGraph('mermaid')).toBe(m);
    expect(renderGraph('yaml')).toBe(renderYaml(buildExecuteGraph()));
  });
});
