/**
 * Tests for the dependency-graph dashboard loader (AISDLC-167.4 / RFC-0014
 * Phase 4 §7.2).
 *
 * Hermetic — every test seeds a tmpdir of fixture files (snapshot JSONL +
 * a backlog/ skeleton for the live-graph join) and drives `loadDepsData()`
 * end to end, mirroring the AISDLC-162 dor-data loader test pattern.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDepsData, resolveArtifactsRoot } from './deps-data';

let tmp: string;
let savedEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'deps-dashboard-'));
  savedEnv = process.env.DEPS_SNAPSHOT_DIR;
  delete process.env.DEPS_SNAPSHOT_DIR;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.DEPS_SNAPSHOT_DIR;
  else process.env.DEPS_SNAPSHOT_DIR = savedEnv;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/**
 * Write a backlog task file in the shape `buildDependencyGraph` understands.
 * Mirrors the test helper from `pipeline-cli/src/__test-helpers/make-task.ts`
 * but lives here so the dashboard tests don't reach across package
 * boundaries for fixtures.
 */
function writeTask(opts: {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  dependencies?: string[];
  completed?: boolean;
}): void {
  const slug = opts.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const subdir = opts.completed ? 'completed' : 'tasks';
  mkdirSync(join(tmp, 'backlog', subdir), { recursive: true });
  const path = join(tmp, 'backlog', subdir, `${opts.id.toLowerCase()} - ${slug}.md`);
  const lines: string[] = ['---'];
  lines.push(`id: ${opts.id}`);
  lines.push(`title: '${opts.title}'`);
  lines.push(`status: ${opts.status ?? (opts.completed ? 'Done' : 'To Do')}`);
  if (opts.priority) lines.push(`priority: ${opts.priority}`);
  if (opts.dependencies && opts.dependencies.length > 0) {
    lines.push('dependencies:');
    for (const d of opts.dependencies) lines.push(`  - ${d}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push('Test fixture.');
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

function writeSnapshotFile(filename: string, records: object[]): string {
  const dir = join(tmp, 'artifacts', '_deps');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(
    path,
    records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : ''),
  );
  return path;
}

describe('resolveArtifactsRoot', () => {
  it('honors explicit artifactsDir first', () => {
    process.env.DEPS_SNAPSHOT_DIR = '/env/path';
    expect(resolveArtifactsRoot({ artifactsDir: '/explicit' })).toBe('/explicit');
  });

  it('falls back to DEPS_SNAPSHOT_DIR env var', () => {
    process.env.DEPS_SNAPSHOT_DIR = '/env/path';
    expect(resolveArtifactsRoot()).toBe('/env/path');
  });

  it('treats empty DEPS_SNAPSHOT_DIR as unset', () => {
    process.env.DEPS_SNAPSHOT_DIR = '';
    const root = resolveArtifactsRoot();
    expect(root.endsWith('artifacts')).toBe(true);
  });

  it('defaults to <cwd>/artifacts', () => {
    const root = resolveArtifactsRoot();
    expect(root).toBe(join(process.cwd(), 'artifacts'));
  });
});

describe('loadDepsData', () => {
  it('returns null when the artifacts root does not exist', () => {
    const result = loadDepsData({ artifactsDir: join(tmp, 'does-not-exist'), workDir: tmp });
    expect(result).toBeNull();
  });

  it('returns null when artifacts/_deps/ exists but is empty', () => {
    mkdirSync(join(tmp, 'artifacts', '_deps'), { recursive: true });
    const result = loadDepsData({ artifactsDir: join(tmp, 'artifacts'), workDir: tmp });
    expect(result).toBeNull();
  });

  it('loads the latest snapshot and joins it to the live graph', () => {
    writeTask({ id: 'AISDLC-A', title: 'A root', priority: 'medium' });
    writeTask({ id: 'AISDLC-B', title: 'B mid', priority: 'medium', dependencies: ['AISDLC-A'] });
    writeTask({
      id: 'AISDLC-C',
      title: 'C leaf',
      priority: 'critical',
      dependencies: ['AISDLC-B'],
    });
    writeSnapshotFile('snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl', [
      {
        id: 'AISDLC-A',
        dependencies: [],
        dependents: ['AISDLC-B'],
        depth: 0,
        criticalPathLength: 2,
        externalDependencies: [],
        lastModified: '',
      },
      {
        id: 'AISDLC-B',
        dependencies: ['AISDLC-A'],
        dependents: ['AISDLC-C'],
        depth: 1,
        criticalPathLength: 1,
        externalDependencies: [],
        lastModified: '',
      },
      {
        id: 'AISDLC-C',
        dependencies: ['AISDLC-B'],
        dependents: [],
        depth: 2,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      },
    ]);
    const result = loadDepsData({ artifactsDir: join(tmp, 'artifacts'), workDir: tmp });
    expect(result).not.toBeNull();
    expect(result!.totalRecords).toBe(3);
    expect(result!.skipped).toBe(0);
    expect(result!.snapshotTag).toBe('rolling');
    // enriched is sorted by dispatch order — A and B inherit critical from C
    // so they all share effectivePriority=4. CPL: A(2) > B(1) > C(0). C drops
    // off the criticalPath via the isolated-leaf filter.
    expect(result!.enriched.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B', 'AISDLC-C']);
    expect(result!.criticalPath.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B']);
    // Title + status came from the live graph.
    const a = result!.enriched.find((r) => r.id === 'AISDLC-A')!;
    expect(a.title).toBe('A root');
    expect(a.status).toBe('To Do');
  });

  it('picks the most recent snapshot when multiple exist (sorted by ISO ts)', () => {
    writeTask({ id: 'AISDLC-OLD', title: 'old' });
    writeTask({ id: 'AISDLC-NEW', title: 'new', priority: 'critical' });
    writeSnapshotFile('snapshot.2026-04-01T00-00-00.000Z.rolling.jsonl', [
      {
        id: 'AISDLC-OLD',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      },
    ]);
    writeSnapshotFile('snapshot.2026-05-01T00-00-00.000Z.dispatch.jsonl', [
      {
        id: 'AISDLC-NEW',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      },
    ]);
    const result = loadDepsData({ artifactsDir: join(tmp, 'artifacts'), workDir: tmp });
    expect(result).not.toBeNull();
    expect(result!.snapshotTag).toBe('dispatch');
    expect(result!.enriched.map((r) => r.id)).toEqual(['AISDLC-NEW']);
  });

  it('surfaces dangling-edge warnings for snapshot rows not in the live graph (AC #5)', () => {
    // Snapshot mentions AISDLC-GHOST but no on-disk task file exists for it.
    writeSnapshotFile('snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl', [
      {
        id: 'AISDLC-GHOST',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 1,
        externalDependencies: [],
        lastModified: '',
      },
    ]);
    const result = loadDepsData({ artifactsDir: join(tmp, 'artifacts'), workDir: tmp });
    expect(result).not.toBeNull();
    expect(result!.enriched).toHaveLength(1);
    expect(result!.enriched[0]!.warnings).toHaveLength(1);
    expect(result!.enriched[0]!.warnings[0]).toContain('AISDLC-GHOST');
  });

  it('respects the limit option for the highlighted critical path', () => {
    // Build a 5-task chain so 4 tasks qualify for the critical path. Limit 2
    // → only top 2 highlighted (A, B), the rest land in `enriched` only.
    for (const id of ['A', 'B', 'C', 'D'] as const) {
      writeTask({
        id: `AISDLC-${id}`,
        title: `task ${id}`,
        priority: 'medium',
        dependencies: id === 'A' ? [] : [`AISDLC-${String.fromCharCode(id.charCodeAt(0) - 1)}`],
      });
    }
    writeTask({
      id: 'AISDLC-E',
      title: 'task E',
      priority: 'critical',
      dependencies: ['AISDLC-D'],
    });
    writeSnapshotFile('snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl', [
      {
        id: 'AISDLC-A',
        dependencies: [],
        dependents: ['AISDLC-B'],
        depth: 0,
        criticalPathLength: 4,
        externalDependencies: [],
        lastModified: '',
      },
      {
        id: 'AISDLC-B',
        dependencies: ['AISDLC-A'],
        dependents: ['AISDLC-C'],
        depth: 1,
        criticalPathLength: 3,
        externalDependencies: [],
        lastModified: '',
      },
      {
        id: 'AISDLC-C',
        dependencies: ['AISDLC-B'],
        dependents: ['AISDLC-D'],
        depth: 2,
        criticalPathLength: 2,
        externalDependencies: [],
        lastModified: '',
      },
      {
        id: 'AISDLC-D',
        dependencies: ['AISDLC-C'],
        dependents: ['AISDLC-E'],
        depth: 3,
        criticalPathLength: 1,
        externalDependencies: [],
        lastModified: '',
      },
      {
        id: 'AISDLC-E',
        dependencies: ['AISDLC-D'],
        dependents: [],
        depth: 4,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      },
    ]);
    const result = loadDepsData({
      artifactsDir: join(tmp, 'artifacts'),
      workDir: tmp,
      limit: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.criticalPath).toHaveLength(2);
    expect(result!.criticalPath.map((r) => r.id)).toEqual(['AISDLC-A', 'AISDLC-B']);
    expect(result!.enriched).toHaveLength(5);
  });

  it('counts skipped malformed lines without crashing', () => {
    const dir = join(tmp, 'artifacts', '_deps');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({
          id: 'AISDLC-A',
          dependencies: [],
          dependents: [],
          depth: 0,
          criticalPathLength: 0,
          externalDependencies: [],
          lastModified: '',
        }),
        'not valid json at all',
        '{}',
      ].join('\n') + '\n',
    );
    const result = loadDepsData({ artifactsDir: join(tmp, 'artifacts'), workDir: tmp });
    expect(result).not.toBeNull();
    expect(result!.totalRecords).toBe(1);
    expect(result!.skipped).toBe(2);
  });
});
