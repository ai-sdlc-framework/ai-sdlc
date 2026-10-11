import { describe, expect, it } from 'vitest';

import { Reconciler, type TerminalHandle, type TerminalSpec } from './reconciler.js';

function setup(...args: [] | [string | undefined]) {
  const bin = args.length ? args[0] : '/repo/pipeline-cli/bin/cli-hierarchy.mjs';
  const created: TerminalSpec[] = [];
  const disposed: string[] = [];
  const handles = new Map<string, TerminalHandle>();
  let focus = false;
  let currentBin = bin;
  const r = new Reconciler(
    {
      create: (spec) => {
        created.push(spec);
        const h: TerminalHandle = { dispose: () => disposed.push(spec.name) };
        handles.set(spec.name, h);
        return h;
      },
    },
    { resolveBin: () => currentBin, focusNew: () => focus },
  );
  return {
    r,
    created,
    disposed,
    handles,
    setFocus: (f: boolean) => (focus = f),
    setBin: (b: string | undefined) => (currentBin = b),
  };
}

describe('Reconciler', () => {
  it('opens one terminal per agent running attach', () => {
    const t = setup();
    t.r.reconcile(['planner', 'executor-a'], { rosterWrite: true });
    expect(t.created.map((c) => c.name)).toEqual(['planner', 'executor-a']);
    expect(t.created[0]).toMatchObject({
      command: 'node',
      args: ['/repo/pipeline-cli/bin/cli-hierarchy.mjs', 'attach', 'planner'],
      focus: false,
    });
  });

  it('opens only the new agent on a roster add and never duplicates', () => {
    const t = setup();
    t.r.reconcile(['planner']);
    t.r.reconcile(['planner']);
    t.r.reconcile(['planner', 'executor-a']);
    expect(t.created.map((c) => c.name)).toEqual(['planner', 'executor-a']);
  });

  it('disposes the terminal of an agent removed from the roster', () => {
    const t = setup();
    t.r.reconcile(['planner', 'executor-a']);
    t.r.reconcile(['planner']);
    expect(t.disposed).toEqual(['executor-a']);
    expect(t.r.openNames()).toEqual(['planner']);
  });

  it('closeAll disposes everything (roster deleted)', () => {
    const t = setup();
    t.r.reconcile(['planner', 'executor-a']);
    t.r.closeAll();
    expect(t.disposed.sort()).toEqual(['executor-a', 'planner']);
    expect(t.r.openNames()).toEqual([]);
  });

  it('closeAll stays closed across a reconcile with the same names', () => {
    const t = setup();
    t.r.reconcile(['planner', 'executor-a'], { rosterWrite: true });
    t.r.closeAll();
    t.r.reconcile(['planner', 'executor-a']);
    expect(t.created).toHaveLength(2);
    expect(t.r.openNames()).toEqual([]);
    t.r.reconcile(['planner', 'executor-a'], { rosterWrite: true });
    expect(t.created).toHaveLength(4);
  });

  it('close events caused by closeAll are not owned by the reconciler', () => {
    const t = setup();
    t.r.reconcile(['planner']);
    const h = t.handles.get('planner') as TerminalHandle;
    t.r.closeAll();
    expect(t.r.onTerminalClosed(h)).toBe(false);
  });

  it('reports ownership of a user close', () => {
    const t = setup();
    t.r.reconcile(['planner']);
    expect(t.r.onTerminalClosed(t.handles.get('planner') as TerminalHandle)).toBe(true);
  });

  it('keeps a user-closed terminal closed across reconciles without a roster write', () => {
    const t = setup();
    t.r.reconcile(['planner'], { rosterWrite: true });
    t.r.onTerminalClosed(t.handles.get('planner') as TerminalHandle);
    t.r.reconcile(['planner']);
    t.r.reconcile(['planner']);
    expect(t.created).toHaveLength(1);
  });

  it('does not reopen a user-closed terminal until the next roster write', () => {
    const t = setup();
    t.r.reconcile(['planner', 'executor-a'], { rosterWrite: true });
    t.r.onTerminalClosed(t.handles.get('planner') as TerminalHandle);
    t.r.reconcile(['planner', 'executor-a']);
    expect(t.created).toHaveLength(2);
    t.r.reconcile(['planner', 'executor-a'], { rosterWrite: true });
    expect(t.created.map((c) => c.name)).toEqual(['planner', 'executor-a', 'planner']);
  });

  it('forgets a user-closed name that left the roster', () => {
    const t = setup();
    t.r.reconcile(['planner']);
    t.r.onTerminalClosed(t.handles.get('planner') as TerminalHandle);
    t.r.reconcile([]);
    t.r.reconcile(['planner']);
    expect(t.created).toHaveLength(2);
  });

  it('ignores a close event for an unknown handle', () => {
    const t = setup();
    t.r.reconcile(['planner']);
    t.r.onTerminalClosed({ dispose: () => {} });
    expect(t.r.openNames()).toEqual(['planner']);
  });

  it('openAll reopens user-closed agents', () => {
    const t = setup();
    t.r.reconcile(['planner']);
    t.r.onTerminalClosed(t.handles.get('planner') as TerminalHandle);
    t.r.openAll(['planner']);
    expect(t.created).toHaveLength(2);
  });

  it('opens nothing without a resolvable bin, then opens once it resolves', () => {
    const t = setup(undefined);
    t.r.reconcile(['planner']);
    expect(t.created).toHaveLength(0);
    t.setBin('/x/cli-hierarchy.mjs');
    t.r.reconcile(['planner']);
    expect(t.created).toHaveLength(1);
  });

  it('passes the focusNew setting and a custom node through', () => {
    const t = setup();
    t.setFocus(true);
    t.r.reconcile(['planner']);
    expect(t.created[0]?.focus).toBe(true);
  });

  it('uses the injected node executable', () => {
    const created: TerminalSpec[] = [];
    const r = new Reconciler(
      { create: (s) => (created.push(s), { dispose: () => {} }) },
      { resolveBin: () => '/b.mjs', focusNew: () => false, node: '/usr/bin/node' },
    );
    r.reconcile(['planner']);
    expect(created[0]?.command).toBe('/usr/bin/node');
  });
});
