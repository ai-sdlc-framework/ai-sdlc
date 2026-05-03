/**
 * RFC-0014 Phase 4 — critical-path loader + selector + Slack section tests.
 *
 * Covers AISDLC-167.4 ACs #1, #2, #5, #6, #7:
 *   - latest-snapshot resolution under `<artifactsDir>/_deps/`
 *   - enrichSnapshot joins snapshot rows with live graph titles + status +
 *     effectivePriority; surfaces dangling-edge warnings instead of crashing
 *   - selectCriticalPath sort + top-N + open-only filter
 *   - buildCriticalPathSlackSection renders blocks/markdown for the populated,
 *     empty-graph, and no-snapshot states (all three drive the digest's
 *     omit-vs-render-vs-hint branches)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCriticalPathDigest,
  buildCriticalPathSlackSection,
  enrichSnapshot,
  formatCriticalPathEntry,
  loadLatestSnapshot,
  selectCriticalPath,
  type EnrichedSnapshotRecord,
} from './critical-path.js';
import { writeSnapshot } from './snapshot.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
let artifactsDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  tmp = makeTmpProject();
  artifactsDir = join(tmp, 'artifacts');
  priorEnv = process.env.AI_SDLC_DEPS_COMPOSITION;
  // Suite-level: composition ON so writeSnapshot actually emits files.
  process.env.AI_SDLC_DEPS_COMPOSITION = '1';
});

afterEach(() => {
  cleanupTmpProject(tmp);
  if (priorEnv === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
  else process.env.AI_SDLC_DEPS_COMPOSITION = priorEnv;
});

/**
 * Build a 5-task chain A → B → C → D → E with a high-priority leaf at E so
 * the critical path inherits the high signal up to A.
 *
 *   A (medium, root) — depth 0, CPL 4
 *   B (medium)       — depth 1, CPL 3
 *   C (medium)       — depth 2, CPL 2
 *   D (medium)       — depth 3, CPL 1
 *   E (critical)     — depth 4, CPL 0
 *
 * Expected effectivePriority:
 *   A = max(medium, B.eff) = max(2, 4) = 4 (inherits from E via the chain)
 *   B = 4, C = 4, D = 4, E = 4 (its own base)
 *
 * Then a separate isolated leaf F (high, no edges) which qualifies as a
 * critical-path candidate ONLY when it has downstream — without we drop it
 * via the "true isolated leaf" filter in selectCriticalPath.
 */
function seedChainFixture(): void {
  writeTaskFile(tmp, { id: 'AISDLC-A', title: 'A root', priority: 'medium' });
  writeTaskFile(tmp, {
    id: 'AISDLC-B',
    title: 'B mid',
    priority: 'medium',
    dependencies: ['AISDLC-A'],
  });
  writeTaskFile(tmp, {
    id: 'AISDLC-C',
    title: 'C mid',
    priority: 'medium',
    dependencies: ['AISDLC-B'],
  });
  writeTaskFile(tmp, {
    id: 'AISDLC-D',
    title: 'D mid',
    priority: 'medium',
    dependencies: ['AISDLC-C'],
  });
  writeTaskFile(tmp, {
    id: 'AISDLC-E',
    title: 'E leaf',
    priority: 'critical',
    dependencies: ['AISDLC-D'],
  });
  writeTaskFile(tmp, { id: 'AISDLC-F', title: 'F isolated', priority: 'high' });
}

describe('loadLatestSnapshot', () => {
  it('returns null when the snapshot dir does not exist', () => {
    const r = loadLatestSnapshot({ workDir: tmp, artifactsDir });
    expect(r).toBeNull();
  });

  it('returns null when the snapshot dir is empty', () => {
    const dir = join(artifactsDir, '_deps');
    mkdirSync(dir, { recursive: true });
    const r = loadLatestSnapshot({ workDir: tmp, artifactsDir });
    expect(r).toBeNull();
  });

  it('picks the most recent snapshot when several tags coexist', () => {
    const dir = join(artifactsDir, '_deps');
    mkdirSync(dir, { recursive: true });
    const oldRolling = join(dir, 'snapshot.2026-04-01T00-00-00.000Z.rolling.jsonl');
    const newDispatch = join(dir, 'snapshot.2026-05-01T00-00-00.000Z.dispatch.jsonl');
    writeFileSync(
      oldRolling,
      JSON.stringify({
        id: 'AISDLC-OLD',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      }) + '\n',
    );
    writeFileSync(
      newDispatch,
      JSON.stringify({
        id: 'AISDLC-NEW',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      }) + '\n',
    );
    const r = loadLatestSnapshot({ workDir: tmp, artifactsDir });
    expect(r).not.toBeNull();
    expect(r!.tag).toBe('dispatch');
    expect(r!.records.map((x) => x.id)).toEqual(['AISDLC-NEW']);
  });

  it('filters by tag when one is specified', () => {
    const dir = join(artifactsDir, '_deps');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'snapshot.2026-04-01T00-00-00.000Z.rolling.jsonl'),
      JSON.stringify({
        id: 'AISDLC-OLD',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      }) + '\n',
    );
    writeFileSync(
      join(dir, 'snapshot.2026-05-01T00-00-00.000Z.dispatch.jsonl'),
      JSON.stringify({
        id: 'AISDLC-NEW',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      }) + '\n',
    );
    const r = loadLatestSnapshot({ workDir: tmp, artifactsDir, tag: 'rolling' });
    expect(r).not.toBeNull();
    expect(r!.tag).toBe('rolling');
  });

  it('skips malformed JSONL lines and counts them', () => {
    const dir = join(artifactsDir, '_deps');
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
        'not valid json',
        JSON.stringify({ id: 'missing-fields' }),
      ].join('\n') + '\n',
    );
    const r = loadLatestSnapshot({ workDir: tmp, artifactsDir });
    expect(r).not.toBeNull();
    expect(r!.records).toHaveLength(1);
    expect(r!.skipped).toBe(2);
  });
});

describe('enrichSnapshot', () => {
  it('joins snapshot rows with title + status + effectivePriority', () => {
    seedChainFixture();
    const snap = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    expect(snap.written).toBe(true);
    const loaded = loadLatestSnapshot({ workDir: tmp, artifactsDir });
    expect(loaded).not.toBeNull();
    const enriched = enrichSnapshot(loaded!.records, { workDir: tmp });
    const byId = new Map(enriched.map((e) => [e.id, e]));
    expect(byId.get('AISDLC-A')?.title).toBe('A root');
    expect(byId.get('AISDLC-A')?.basePriority).toBe(2); // medium
    expect(byId.get('AISDLC-A')?.effectivePriority).toBe(4); // inherits from E
    expect(byId.get('AISDLC-A')?.criticalPathLength).toBe(4);
    expect(byId.get('AISDLC-A')?.dependentCount).toBe(1);
    expect(byId.get('AISDLC-E')?.basePriority).toBe(4);
    expect(byId.get('AISDLC-E')?.effectivePriority).toBe(4);
    expect(byId.get('AISDLC-A')?.warnings).toEqual([]);
  });

  it('emits a warning for snapshot rows whose id is missing from the live graph', () => {
    // Synthesise a snapshot record for a task that doesn't exist on disk.
    const synthetic = [
      {
        id: 'AISDLC-GHOST',
        dependencies: [],
        dependents: [],
        depth: 0,
        criticalPathLength: 0,
        externalDependencies: [],
        lastModified: '',
      },
    ];
    const enriched = enrichSnapshot(synthetic, { workDir: tmp });
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.warnings).toHaveLength(1);
    expect(enriched[0]!.warnings[0]).toContain('AISDLC-GHOST');
    expect(enriched[0]!.title).toBe('');
    expect(enriched[0]!.effectiveStatus).toBe('');
  });
});

describe('selectCriticalPath', () => {
  function mk(over: Partial<EnrichedSnapshotRecord>): EnrichedSnapshotRecord {
    return {
      id: 'X',
      title: '',
      status: '',
      effectiveStatus: 'open',
      basePriority: 2,
      effectivePriority: 2,
      criticalPathLength: 0,
      dependentCount: 0,
      dependencies: [],
      dependents: [],
      lastModified: '',
      filePath: '',
      warnings: [],
      ...over,
    };
  }

  it('returns empty when only true isolated leaves exist (drives AC #2 omit branch)', () => {
    const enriched = [
      mk({
        id: 'A',
        criticalPathLength: 0,
        dependentCount: 0,
        basePriority: 2,
        effectivePriority: 2,
      }),
      mk({
        id: 'B',
        criticalPathLength: 0,
        dependentCount: 0,
        basePriority: 3,
        effectivePriority: 3,
      }),
    ];
    expect(selectCriticalPath(enriched)).toEqual([]);
  });

  it('orders by effectivePriority DESC → CPL DESC → recency DESC → id ASC', () => {
    const enriched = [
      mk({
        id: 'A',
        effectivePriority: 4,
        criticalPathLength: 4,
        dependentCount: 1,
        lastModified: '2026-05-01T00:00:00.000Z',
      }),
      mk({
        id: 'B',
        effectivePriority: 4,
        criticalPathLength: 4,
        dependentCount: 1,
        lastModified: '2026-04-01T00:00:00.000Z',
      }),
      mk({
        id: 'C',
        effectivePriority: 3,
        criticalPathLength: 5,
        dependentCount: 1,
        lastModified: '2026-05-02T00:00:00.000Z',
      }),
    ];
    const top = selectCriticalPath(enriched, { limit: 5 });
    expect(top.map((r) => r.id)).toEqual(['A', 'B', 'C']);
  });

  it('respects limit', () => {
    const enriched = Array.from({ length: 10 }, (_, i) =>
      mk({
        id: `T${i}`,
        effectivePriority: 4 - (i % 4),
        criticalPathLength: 5,
        dependentCount: 1,
      }),
    );
    expect(selectCriticalPath(enriched, { limit: 3 })).toHaveLength(3);
  });

  it('drops completed tasks by default (openOnly)', () => {
    const enriched = [
      mk({
        id: 'OPEN',
        effectivePriority: 3,
        criticalPathLength: 2,
        dependentCount: 1,
        effectiveStatus: 'open',
      }),
      mk({
        id: 'DONE',
        effectivePriority: 4,
        criticalPathLength: 3,
        dependentCount: 1,
        effectiveStatus: 'completed',
      }),
    ];
    const top = selectCriticalPath(enriched);
    expect(top.map((r) => r.id)).toEqual(['OPEN']);
  });

  it('keeps completed tasks when openOnly=false (dashboard wide-view mode)', () => {
    const enriched = [
      mk({
        id: 'DONE',
        effectivePriority: 4,
        criticalPathLength: 3,
        dependentCount: 1,
        effectiveStatus: 'completed',
      }),
    ];
    expect(selectCriticalPath(enriched, { openOnly: false })).toHaveLength(1);
  });
});

describe('buildCriticalPathDigest end-to-end', () => {
  it('returns top items by effectivePriority on a real chain fixture', () => {
    seedChainFixture();
    writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    const r = buildCriticalPathDigest({ workDir: tmp, artifactsDir, limit: 5 });
    expect(r).not.toBeNull();
    // A, B, C, D all have effectivePriority=4 (inherited from E). E itself is
    // a leaf — its CPL is 0 AND dependentCount is 0 — so it gets dropped by
    // the isolated-leaf filter. F is isolated entirely. Order among
    // A/B/C/D by CPL: A(4) > B(3) > C(2) > D(1).
    expect(r!.items.map((it) => it.id)).toEqual(['AISDLC-A', 'AISDLC-B', 'AISDLC-C', 'AISDLC-D']);
  });

  it('returns null when no snapshot exists (drives "insufficient data" hint)', () => {
    const r = buildCriticalPathDigest({ workDir: tmp, artifactsDir });
    expect(r).toBeNull();
  });
});

describe('formatCriticalPathEntry', () => {
  it('matches the AISDLC-167.4 spec format', () => {
    const item: EnrichedSnapshotRecord = {
      id: 'AISDLC-200',
      title: 'Foundation work',
      status: 'To Do',
      effectiveStatus: 'open',
      basePriority: 3,
      effectivePriority: 4,
      criticalPathLength: 7,
      dependentCount: 12,
      dependencies: [],
      dependents: [],
      lastModified: '',
      filePath: '',
      warnings: [],
    };
    expect(formatCriticalPathEntry(1, item)).toBe(
      '1. AISDLC-200 — Foundation work (chain length: 7, gates: 12 downstream)',
    );
  });

  it('falls back to "(no title)" when title is empty', () => {
    const item: EnrichedSnapshotRecord = {
      id: 'AISDLC-200',
      title: '',
      status: '',
      effectiveStatus: 'open',
      basePriority: 0,
      effectivePriority: 0,
      criticalPathLength: 0,
      dependentCount: 0,
      dependencies: [],
      dependents: [],
      lastModified: '',
      filePath: '',
      warnings: [],
    };
    expect(formatCriticalPathEntry(1, item)).toContain('(no title)');
  });
});

describe('buildCriticalPathSlackSection', () => {
  it('renders the populated section with blocks + markdown + fallbackSuffix', () => {
    seedChainFixture();
    writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    const sec = buildCriticalPathSlackSection({ workDir: tmp, artifactsDir, limit: 3 });
    expect(sec.state).toBe('rendered');
    expect(sec.blocks.length).toBeGreaterThan(0);
    expect(sec.items).toHaveLength(3);
    expect(sec.fallbackSuffix).toContain('critical path top 3');
    expect(sec.fallbackSuffix).toContain('AISDLC-A');
    expect(sec.markdown).toContain('## 🛤️ Critical Path');
    expect(sec.markdown).toContain('**AISDLC-A**');
    // Block text contains the formatted entry.
    const firstBlock = sec.blocks[0] as { type: string; text: { type: string; text: string } };
    expect(firstBlock.text.text).toContain('🛤️ Critical Path');
    expect(firstBlock.text.text).toContain('1. AISDLC-A');
  });

  it('returns omitted-empty-graph state when graph has no qualifying items (AC #2)', () => {
    // Only isolated leaves — selectCriticalPath drops them all.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'isolated', priority: 'medium' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'isolated2', priority: 'high' });
    writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    const sec = buildCriticalPathSlackSection({ workDir: tmp, artifactsDir });
    expect(sec.state).toBe('omitted-empty-graph');
    expect(sec.blocks).toEqual([]);
    expect(sec.markdown).toBe('');
    expect(sec.fallbackSuffix).toBe('');
  });

  it('returns omitted-no-snapshot with hint blocks when emitInsufficientDataHint is true', () => {
    const sec = buildCriticalPathSlackSection({
      workDir: tmp,
      artifactsDir,
      emitInsufficientDataHint: true,
    });
    expect(sec.state).toBe('omitted-no-snapshot');
    expect(sec.blocks.length).toBeGreaterThan(0);
    expect(sec.markdown).toContain('Insufficient data');
    expect(sec.markdown).toContain('cli-deps snapshot');
  });

  it('returns omitted-no-snapshot with empty blocks when emitInsufficientDataHint is false', () => {
    const sec = buildCriticalPathSlackSection({
      workDir: tmp,
      artifactsDir,
      emitInsufficientDataHint: false,
    });
    expect(sec.state).toBe('omitted-no-snapshot');
    expect(sec.blocks).toEqual([]);
    expect(sec.markdown).toBe('');
  });
});
