import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { renderGraph } from '../cli/workflow.js';
import { buildExecuteGraph, renderYaml } from './graph.js';
import { validateWorkflowDocument, validateWorkflowYaml, whenIdentifiers } from './validate.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = readFileSync(
  join(here, '..', '..', 'test', 'fixtures', 'workflow', 'execute-task.golden.yaml'),
  'utf8',
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fresh = (): any => load(golden);

describe('workflow validator', () => {
  it('accepts the golden default and the built graph', () => {
    expect(validateWorkflowYaml(golden)).toEqual({ ok: true, errors: [] });
    expect(validateWorkflowYaml(renderYaml(buildExecuteGraph())).ok).toBe(true);
    expect(renderGraph('yaml')).toBe(golden);
  });

  it('accepts string edges and frozen lists', () => {
    const doc = fresh();
    doc.spec.nodes.upkeep.frozen = ['no-skip'];
    doc.spec.edges.push('cleanup -> cleanup2');
    doc.spec.nodes.cleanup2 = { kind: 'human' };
    expect(validateWorkflowDocument(doc).ok).toBe(true);
  });

  it('rejects an anchor whose impl is an agent role', () => {
    const doc = fresh();
    doc.spec.nodes.gate = { kind: 'anchor', impl: 'developer' };
    const r = validateWorkflowDocument(doc);
    expect(r.ok).toBe(false);
    const doc2 = fresh();
    doc2.spec.nodes.gate = { kind: 'anchor', impl: 'custom-role' };
    doc2.spec.nodes.other = { kind: 'agent', role: 'custom-role' };
    expect(validateWorkflowDocument(doc2).errors.join()).toContain('anchor-impl-agent');
  });

  it('rejects a fanout without cap', () => {
    const doc = fresh();
    delete doc.spec.nodes.review.cap;
    const r = validateWorkflowDocument(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('schema');
  });

  it('rejects an undeclared loop', () => {
    const doc = fresh();
    delete doc.spec.edges.find((e: { loop?: unknown }) => e.loop).loop;
    expect(validateWorkflowDocument(doc).errors.join()).toContain('undeclared-loop');
  });

  it('rejects a when naming an identifier no upstream node outputs', () => {
    const doc = fresh();
    doc.spec.edges.find((e: { when?: string }) => e.when).when = 'verdictz == APPROVED';
    expect(validateWorkflowDocument(doc).errors.join()).toContain('when-identifier');
  });

  it('rejects unknown edge endpoints, unknown anchors and unparseable yaml', () => {
    const doc = fresh();
    doc.spec.edges.push({ from: 'nope', to: 'cleanup' });
    doc.spec.anchors = ['ghost'];
    const msg = validateWorkflowDocument(doc).errors.join();
    expect(msg).toContain('edge-endpoint');
    expect(msg).toContain('anchor-unknown');
    expect(validateWorkflowYaml('a: [').errors[0]).toContain('parse');
  });

  it('rejects an empty or unparseable when expression', () => {
    const doc = fresh();
    doc.spec.edges.find((e: { when?: string }) => e.when).when = ' ';
    expect(validateWorkflowDocument(doc).ok).toBe(false);
  });

  it('extracts identifiers from operands', () => {
    expect(whenIdentifiers("a.b == 'x' && !c || d contains e.f")).toEqual(['a.b', 'c', 'd', 'e.f']);
    expect(whenIdentifiers('x == APPROVED && true')).toEqual(['x']);
  });
});

describe('cli-workflow validate', () => {
  it('is wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    try {
      const { runWorkflowCli } = await import('../cli/workflow.js');
      let out = '';
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
      try {
        await runWorkflowCli(['validate', '--project-dir', dir]);
      } finally {
        process.stdout.write = orig;
      }
      expect(JSON.parse(out).state).toBe('missing');
    } finally {
      removeFixtureDir(dir);
    }
  });
});
