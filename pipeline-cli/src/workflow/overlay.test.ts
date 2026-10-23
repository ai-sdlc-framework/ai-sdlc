import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromBase, WorkflowRefusal } from './engine.js';
import { EXECUTE_IMPLS } from './execute-host.js';
import { buildExecuteGraph, renderYaml } from './graph.js';
import { applyOverlay, decisionLookup, FROZEN_SET, type OverlayContext } from './overlay.js';
import type { Runner } from '../runtime/exec.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const ctx: OverlayContext = { decisionExists: (id) => id === 'DEC-0100' };
const ext = { name: 'mine', extends: 'ai-sdlc/execute-task@1' };
const overlay = (spec: unknown, meta: object = {}): unknown => ({
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'Workflow',
  metadata: { ...ext, ...meta },
  spec,
});

describe('frozen set', () => {
  it('every cited enforcer exists in the repo (AC-5)', () => {
    for (const e of FROZEN_SET) {
      expect(e.enforcers.length).toBeGreaterThan(0);
      for (const f of e.enforcers)
        expect(existsSync(join(repoRoot, f)), `${e.id}: ${f}`).toBe(true);
    }
  });
});

describe('allowed overrides (AC-1)', () => {
  it('lowers loop.max, changes lenses and removes the hygiene node', () => {
    const r = applyOverlay(
      overlay({
        remove: ['upkeep'],
        nodes: { plan: { with: { lenses: ['correctness', 'security'] } } },
        edges: [{ from: 'iterate', to: 'develop', loop: { max: 1 } }],
      }),
      ctx,
    );
    expect(r.errors).toEqual([]);
    const doc = r.doc!;
    expect(Object.keys(doc.spec.nodes)).not.toContain('upkeep');
    expect(doc.spec.edges.find((e) => e.loop)?.loop?.max).toBe(1);
    expect(doc.spec.nodes.plan.with).toEqual({ lenses: ['correctness', 'security'] });
    const base = buildExecuteGraph();
    expect(Object.keys(doc.spec.nodes).length).toBe(Object.keys(base.spec.nodes).length - 1);
  });

  it('bridges a removed mid-chain node and logs a staged promotion', () => {
    const r = applyOverlay(
      overlay({
        remove: ['siblings'],
        nodes: { plan: { with: { lenses: ['staged', 'security'] } } },
      }),
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.doc!.spec.edges).toContainEqual({ from: 'ship', to: 'cleanup' });
    expect(r.notes.join()).toContain('RFC-0052 OQ-2');
  });

  it('adds nodes and edges and lowers a fanout cap', () => {
    const r = applyOverlay(
      overlay({
        nodes: { extra: { kind: 'step', impl: 'cleanup-task' }, review: { cap: 2 } },
        edges: ['cleanup -> extra'],
      }),
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.doc!.spec.nodes.review.cap).toBe(2);
    expect(r.doc!.spec.nodes.extra).toBeDefined();
  });
});

describe('refused overrides cite the enforcer (AC-2)', () => {
  const refused = (spec: unknown, rule: string, enforcer: string): void => {
    const r = applyOverlay(overlay(spec), ctx);
    expect(r.ok).toBe(false);
    const line = r.errors.find((e) => e.startsWith(rule));
    expect(line, r.errors.join('\n')).toBeDefined();
    expect(line).toContain(enforcer);
  };
  it('edits aggregate', () =>
    refused(
      { nodes: { aggregate: { impl: 'finalize-task' } } },
      'frozen-node',
      'pipeline-cli/src/steps/08-aggregate-verdicts.ts',
    ));
  it('removes aggregate', () =>
    refused(
      { remove: ['aggregate'] },
      'frozen-node',
      'pipeline-cli/src/steps/08-aggregate-verdicts.ts',
    ));
  it('raises a fanout cap', () =>
    refused(
      { nodes: { review: { cap: 9 } } },
      'cap-ceiling',
      'pipeline-cli/src/workflow/engine.ts',
    ));
  it('raises the loop max', () =>
    refused(
      { edges: [{ from: 'iterate', to: 'develop', loop: { max: 9 } }] },
      'cap-ceiling',
      'pipeline-cli/src/steps/09-iterate.ts',
    ));
  it('loosens expect', () =>
    refused(
      { nodes: { review: { expect: 'quorum(2)' } } },
      'fanout-join',
      'pipeline-cli/src/workflow/engine.ts',
    ));
  it('removes the last anchor before ship, even under a decision', () => {
    const r = applyOverlay(overlay({ remove: ['aggregate'] }, { decisions: ['DEC-0100'] }), ctx);
    const line = r.errors.find((e) => e.startsWith('last-anchor'));
    expect(line).toContain('pipeline-cli/src/workflow/engine.ts');
  });
  it('declares an agent as an anchor', () =>
    refused(
      { nodes: { guard: { kind: 'anchor', impl: 'developer' } } },
      'agent-anchor',
      'spec/schemas/workflow.schema.json',
    ));
  it('touches a frozen node under a with key', () =>
    refused(
      { nodes: { plan: { with: { 'base-branch-config': false } } } },
      'frozen-knob',
      'pipeline-cli/src/routing/load-table.ts',
    ));
  it('drops the security lens', () =>
    refused(
      { nodes: { plan: { with: { lenses: ['correctness'] } } } },
      'lenses',
      'reviewer-set.ts',
    ));
  it('refuses an unknown extends target', () => {
    const r = applyOverlay({ metadata: { name: 'x', extends: 'other@1' }, spec: {} }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('decision records (AC-3)', () => {
  const touch = { nodes: { aggregate: { impl: 'finalize-task' } } };
  it('accepts a frozen touch that names a decision on the base branch', () => {
    const r = applyOverlay(overlay(touch, { decisions: ['DEC-0100'] }), ctx);
    expect(r.ok).toBe(true);
    expect(r.notes.join()).toContain('DEC-0100');
  });
  it('refuses an id that resolves only in the working tree', () => {
    const r = applyOverlay(overlay(touch, { decisions: ['DEC-9999'] }), ctx);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('decision-unresolved');
  });
  it('builds the lookup from base-branch event names and the legacy log', () => {
    const has = decisionLookup(
      ['2026__DEC-0007__decision-opened__ab.json'],
      '{"decisionId":"DEC-0008"}',
    );
    expect([has('DEC-0007'), has('DEC-0008'), has('DEC-0009')]).toEqual([true, true, false]);
  });
});

describe('engine load from the base branch', () => {
  const run = (docText: string, events: string[]): Runner =>
    (async (cmd: string, args: string[]) => {
      const a = args.join(' ');
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (a.startsWith('rev-parse')) return ok('c'.repeat(40));
      if (a.includes('workflow.yaml')) return ok(docText);
      if (a.startsWith('ls-tree')) return ok(events.join('\n'));
      return { code: 1, stdout: '', stderr: '' };
    }) as unknown as Runner;
  const load = (text: string, events: string[] = []) =>
    loadWorkflowFromBase({
      runner: run(text, events),
      workDir: '.',
      baseRef: 'origin/main',
      knownImpls: EXECUTE_IMPLS,
    });

  it('applies an overlay and the golden order drops the removed node', async () => {
    const text = `apiVersion: ai-sdlc.io/v1alpha1
kind: Workflow
metadata: { name: mine, extends: ai-sdlc/execute-task@1 }
spec:
  remove: [upkeep]
  edges:
    - { from: iterate, to: develop, loop: { max: 1 } }
`;
    const wf = await load(text);
    const base = await load(renderYaml(buildExecuteGraph()));
    expect(wf.order[0]).toBe('validate');
    expect(wf.order).toEqual(base.order.filter((n) => n !== 'upkeep'));
    expect(wf.edges.find((e) => e.loop)?.loop?.max).toBe(1);
  });

  it('refuses a frozen touch and accepts it under a base-branch decision', async () => {
    const touch = (decisions: string) => `apiVersion: ai-sdlc.io/v1alpha1
kind: Workflow
metadata: { name: mine, extends: ai-sdlc/execute-task@1${decisions} }
spec:
  nodes:
    aggregate: { kind: step, impl: aggregate-verdicts, inputs: 'local:x' }
`;
    await expect(load(touch(''))).rejects.toBeInstanceOf(WorkflowRefusal);
    await expect(load(touch(', decisions: [DEC-0042]'))).rejects.toThrow('decision-unresolved');
    const wf = await load(touch(', decisions: [DEC-0042]'), [
      '.ai-sdlc/_decisions/events/t__DEC-0042__decision-opened__x.json',
    ]);
    expect((wf.nodes.aggregate as { inputs?: string }).inputs).toBe('local:x');
  });
});
