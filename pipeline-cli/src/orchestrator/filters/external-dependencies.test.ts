/**
 * Filter 3 — External-dependency clearance (RFC-0015 Phase 3 / AISDLC-169.3).
 *
 * Covers:
 *   - No external deps → passed.
 *   - Only non-`manual` kinds → passed (informational only in v1).
 *   - One `manual` dep, no clearance → failed.
 *   - One `manual` dep, cleared via the in-process clearance set → passed.
 *   - One `manual` dep, cleared via the on-disk file → passed.
 *   - Mixed `manual` + non-`manual` deps surface the FULL list in the event
 *     payload (`detail.all`) regardless of which were blocking.
 *   - Missing graph node → passed (defensive).
 *   - Malformed clearance file → empty set (defense-in-depth: never silently admit).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkExternalDependencies } from './external-dependencies.js';
import type {
  DependencyGraph,
  DependencyNode,
  ExternalDependency,
} from '../../deps/dependency-graph.js';

function node(id: string, deps: ExternalDependency[]): DependencyNode {
  return {
    id,
    status: 'open',
    fileLocation: 'open',
    frontmatterStatus: 'To Do',
    priority: '',
    title: id,
    dependencies: [],
    externalDependencies: deps,
    lastModified: '2026-05-02T00:00:00Z',
    filePath: `/tmp/${id}.md`,
  };
}

function graph(nodes: DependencyNode[]): DependencyGraph {
  const map = new Map<string, DependencyNode>();
  const openIds: string[] = [];
  for (const n of nodes) {
    map.set(n.id.toLowerCase(), n);
    openIds.push(n.id.toLowerCase());
  }
  return { nodes: map, openIds, completedIds: [] };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'phase3-ext-'));
});

describe('checkExternalDependencies — pass paths', () => {
  it('passes when the task has no external deps', () => {
    const g = graph([node('AISDLC-A', [])]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A' });
    expect(r.passed).toBe(true);
  });

  it('passes when the task only has non-`manual` external deps', () => {
    const g = graph([
      node('AISDLC-A', [
        { id: 'npm-foo', description: 'foo v2', kind: 'npm-version' },
        { id: 'pr-bar', description: 'bar PR', kind: 'github-pr' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A' });
    expect(r.passed).toBe(true);
  });

  it('passes when an unknown task is asked about (defensive — no node)', () => {
    const g = graph([]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-MISSING' });
    expect(r.passed).toBe(true);
  });
});

describe('checkExternalDependencies — manual-kind gating', () => {
  it('fails when a manual external dep is present and uncleared', () => {
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A' });
    expect(r.passed).toBe(false);
    expect(r.detail?.kind).toBe('awaiting-external');
    if (r.detail?.kind === 'awaiting-external') {
      expect(r.detail.blocking).toEqual([
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]);
      expect(r.detail.all).toHaveLength(1);
    }
  });

  it('passes when the manual dep is in the in-process clearance set', () => {
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]),
    ]);
    const cleared = new Set(['aisdlc-a::sec-review']);
    const r = checkExternalDependencies({
      graph: g,
      taskId: 'AISDLC-A',
      clearedKeys: cleared,
    });
    expect(r.passed).toBe(true);
  });

  it('passes when the manual dep is cleared via the on-disk file', () => {
    const dir = join(tmp, 'art');
    mkdirSync(join(dir, '_orchestrator'), { recursive: true });
    writeFileSync(
      join(dir, '_orchestrator', 'cleared-external-deps.json'),
      JSON.stringify([{ taskId: 'AISDLC-A', externalDepId: 'sec-review' }]),
    );
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A', artifactsDir: dir });
    expect(r.passed).toBe(true);
  });

  it('clearance file taskId match is case-insensitive', () => {
    const dir = join(tmp, 'art');
    mkdirSync(join(dir, '_orchestrator'), { recursive: true });
    writeFileSync(
      join(dir, '_orchestrator', 'cleared-external-deps.json'),
      JSON.stringify([{ taskId: 'aisdlc-a', externalDepId: 'sec-review' }]),
    );
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A', artifactsDir: dir });
    expect(r.passed).toBe(true);
  });

  it('mixed manual + non-manual deps: surfaces the FULL list in detail.all but only blocking ones in detail.blocking', () => {
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
        { id: 'npm-foo', description: 'foo v2', kind: 'npm-version' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A' });
    expect(r.passed).toBe(false);
    if (r.detail?.kind === 'awaiting-external') {
      expect(r.detail.blocking).toHaveLength(1);
      expect(r.detail.blocking[0].id).toBe('sec-review');
      expect(r.detail.all).toHaveLength(2);
      expect(r.detail.all.map((d) => d.id).sort()).toEqual(['npm-foo', 'sec-review']);
    }
  });
});

describe('checkExternalDependencies — corrupt-file safety', () => {
  it('treats a malformed clearance file as empty (never silently admits)', () => {
    const dir = join(tmp, 'art');
    mkdirSync(join(dir, '_orchestrator'), { recursive: true });
    writeFileSync(join(dir, '_orchestrator', 'cleared-external-deps.json'), '{ not json');
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A', artifactsDir: dir });
    expect(r.passed).toBe(false);
  });

  it('treats a non-array clearance file as empty', () => {
    const dir = join(tmp, 'art');
    mkdirSync(join(dir, '_orchestrator'), { recursive: true });
    writeFileSync(
      join(dir, '_orchestrator', 'cleared-external-deps.json'),
      JSON.stringify({ taskId: 'AISDLC-A', externalDepId: 'sec-review' }),
    );
    const g = graph([
      node('AISDLC-A', [
        { id: 'sec-review', description: 'wait for security review', kind: 'manual' },
      ]),
    ]);
    const r = checkExternalDependencies({ graph: g, taskId: 'AISDLC-A', artifactsDir: dir });
    expect(r.passed).toBe(false);
  });
});
