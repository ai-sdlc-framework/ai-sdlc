/**
 * cli-deps-corpus aggregator tests (AISDLC-167.5 / RFC-0014 §11 Phase 5).
 *
 * Hermetic — no real `gh run download`. Each test seeds a tmpdir of
 * synthetic snapshot JSONL files (and optionally an overrides.jsonl) and
 * drives the aggregator end-to-end. The CLI router is tested in-process
 * via `buildDepsCorpusCli()` with stdout/stderr captured (mirrors
 * `dor-corpus.test.ts` conventions).
 *
 * Coverage matrix per AISDLC-167.5 Part D:
 *   - Empty corpus → recommendation 'insufficient-data'
 *   - All-agree corpus + zero overrides → 'safe-to-promote'
 *   - Mixed agree/disagree drops dispatch agreement below threshold → 'continue-soak'
 *   - Override-spike scenario triggers 'continue-soak' even with high agreement
 *   - Schema validation: malformed snapshot entries are skipped + counted
 *   - Multi-file corpus is glued together
 *   - `--format table` renders human-readable output
 *   - CLI surface end-to-end with auto-detected overrides.jsonl
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateDispatchCorpus,
  buildDepsCorpusCli,
  compareTopPicks,
  findSnapshotFiles,
  isValidSnapshotRecord,
  loadSnapshotCorpus,
  type LoadedSnapshot,
} from './deps-corpus.js';
import type { SnapshotRecord } from '../deps/snapshot.js';
import type { OverrideEntry } from '../deps/override-log.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'deps-corpus-cli-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli', ...args];
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stdoutJson(): unknown {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * Build a minimal SnapshotRecord. Only fields the aggregator consumes
 * are populated by default; tests override per-record fields as needed.
 */
function record(opts: {
  id: string;
  dependencies?: string[];
  dependents?: string[];
  depth?: number;
  criticalPathLength?: number;
  lastModified?: string;
}): SnapshotRecord {
  return {
    id: opts.id,
    dependencies: opts.dependencies ?? [],
    dependents: opts.dependents ?? [],
    depth: opts.depth ?? 0,
    criticalPathLength: opts.criticalPathLength ?? 0,
    externalDependencies: [],
    lastModified: opts.lastModified ?? '2026-05-01T00:00:00.000Z',
  };
}

/**
 * Write a snapshot file under `tmp/_deps/` matching the canonical
 * `snapshot.<iso>.<tag>.jsonl` naming. Returns the absolute path.
 */
function writeSnapshotFile(name: string, records: SnapshotRecord[]): string {
  const dir = join(tmp, '_deps');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return path;
}

/**
 * Write an `overrides.jsonl` file under `tmp/_deps/`. Returns the path.
 */
function writeOverrideFile(entries: OverrideEntry[]): string {
  const dir = join(tmp, '_deps');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'overrides.jsonl');
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return path;
}

/**
 * Build a 50-snapshot corpus where every snapshot's records all-agree
 * on the top pick (composition + baseline both pick `AISDLC-AAA`,
 * which is id-ASC AND has the highest CPL).
 */
function buildAgreeingCorpus(n: number): LoadedSnapshot[] {
  const out: LoadedSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const path = writeSnapshotFile(
      `snapshot.2026-05-02T10-${String(i).padStart(2, '0')}-00.000Z.rolling.jsonl`,
      [
        record({ id: 'AISDLC-AAA', criticalPathLength: 5 }),
        record({ id: 'AISDLC-BBB', criticalPathLength: 1 }),
        record({ id: 'AISDLC-CCC', criticalPathLength: 0 }),
      ],
    );
    out.push({
      path,
      isoTimestamp: `2026-05-02T10-${String(i).padStart(2, '0')}-00.000Z`,
      records: [
        record({ id: 'AISDLC-AAA', criticalPathLength: 5 }),
        record({ id: 'AISDLC-BBB', criticalPathLength: 1 }),
        record({ id: 'AISDLC-CCC', criticalPathLength: 0 }),
      ],
    });
  }
  return out;
}

describe('isValidSnapshotRecord', () => {
  it('accepts a well-formed snapshot record', () => {
    expect(isValidSnapshotRecord(record({ id: 'AISDLC-A' }))).toBe(true);
  });
  it('rejects nullish / non-object', () => {
    expect(isValidSnapshotRecord(null)).toBe(false);
    expect(isValidSnapshotRecord(42)).toBe(false);
    expect(isValidSnapshotRecord('hi')).toBe(false);
  });
  it('rejects missing required fields', () => {
    expect(isValidSnapshotRecord({})).toBe(false);
    expect(isValidSnapshotRecord({ id: 'A', dependencies: [] })).toBe(false);
  });
  it('tolerates unknown extra fields', () => {
    const r = record({ id: 'AISDLC-A' }) as SnapshotRecord & { extra: number };
    r.extra = 99;
    expect(isValidSnapshotRecord(r)).toBe(true);
  });
});

describe('compareTopPicks (pure)', () => {
  it('empty records → vacuous agree', () => {
    const r = compareTopPicks([]);
    expect(r.agree).toBe(true);
    expect(r.baselineTopId).toBe('');
    expect(r.compositionTopId).toBe('');
  });

  it('agreement when id-ASC top also has highest CPL', () => {
    const records = [
      record({ id: 'AISDLC-A', criticalPathLength: 5 }),
      record({ id: 'AISDLC-B', criticalPathLength: 0 }),
    ];
    const r = compareTopPicks(records);
    expect(r.baselineTopId).toBe('AISDLC-A');
    expect(r.compositionTopId).toBe('AISDLC-A');
    expect(r.agree).toBe(true);
  });

  it('disagreement when composition prefers a high-CPL leaf with lower id-ASC rank', () => {
    const records = [
      record({ id: 'AISDLC-001', criticalPathLength: 0 }),
      record({ id: 'AISDLC-999', criticalPathLength: 8 }),
    ];
    const r = compareTopPicks(records);
    expect(r.baselineTopId).toBe('AISDLC-001');
    expect(r.compositionTopId).toBe('AISDLC-999');
    expect(r.agree).toBe(false);
  });

  it('only considers records with no remaining dependencies (frontier proxy)', () => {
    // AISDLC-1 has highest CPL but DEPENDS on something — it's not in
    // the proxy frontier; the comparator should only see AISDLC-2 + AISDLC-3.
    const records = [
      record({ id: 'AISDLC-1', criticalPathLength: 9, dependencies: ['AISDLC-X'] }),
      record({ id: 'AISDLC-2', criticalPathLength: 3 }),
      record({ id: 'AISDLC-3', criticalPathLength: 1 }),
    ];
    const r = compareTopPicks(records);
    expect(r.baselineTopId).toBe('AISDLC-2');
    expect(r.compositionTopId).toBe('AISDLC-2');
    expect(r.agree).toBe(true);
  });

  it('falls back to all records when nothing is "ready" (everyone has deps)', () => {
    const records = [
      record({ id: 'AISDLC-A', criticalPathLength: 9, dependencies: ['x'] }),
      record({ id: 'AISDLC-B', criticalPathLength: 1, dependencies: ['x'] }),
    ];
    const r = compareTopPicks(records);
    expect(r.baselineTopId).toBe('AISDLC-A');
    expect(r.compositionTopId).toBe('AISDLC-A');
  });
});

describe('aggregateDispatchCorpus (pure)', () => {
  it('empty corpus → insufficient-data', () => {
    const r = aggregateDispatchCorpus([]);
    expect(r.aggregate.snapshotCount).toBe(0);
    expect(r.aggregate.recommendation).toBe('insufficient-data');
    expect(r.aggregate.dispatchAgreementRate).toBe(0);
  });

  it('small corpus (below minSnapshots) → insufficient-data even when 100% agree', () => {
    const snapshots = buildAgreeingCorpus(5);
    const r = aggregateDispatchCorpus(snapshots);
    expect(r.aggregate.snapshotCount).toBe(5);
    expect(r.aggregate.dispatchAgreementRate).toBe(1);
    expect(r.aggregate.recommendation).toBe('insufficient-data');
  });

  it('large all-agree corpus + zero overrides → safe-to-promote', () => {
    const snapshots = buildAgreeingCorpus(50);
    const r = aggregateDispatchCorpus(snapshots);
    expect(r.aggregate.snapshotCount).toBe(50);
    expect(r.aggregate.dispatchAgreementRate).toBe(1);
    expect(r.aggregate.recommendation).toBe('safe-to-promote');
    expect(r.aggregate.reason).toContain('flip AI_SDLC_DEPS_COMPOSITION');
  });

  it('mixed agreement (90% < 95% threshold) → continue-soak', () => {
    // 50 snapshots; first 5 have a disagreement (composition picks
    // AISDLC-Z because it has high CPL, baseline picks AISDLC-A by id).
    const snapshots = buildAgreeingCorpus(50);
    for (let i = 0; i < 5; i++) {
      snapshots[i]!.records = [
        record({ id: 'AISDLC-A', criticalPathLength: 0 }),
        record({ id: 'AISDLC-Z', criticalPathLength: 9 }),
      ];
    }
    const r = aggregateDispatchCorpus(snapshots);
    expect(r.aggregate.dispatchAgreementRate).toBeCloseTo(45 / 50, 5);
    expect(r.aggregate.recommendation).toBe('continue-soak');
    expect(r.aggregate.reason).toContain('dispatchAgreementRate');
  });

  it('override-spike triggers continue-soak even with high agreement', () => {
    const snapshots = buildAgreeingCorpus(50);
    const overrides: OverrideEntry[] = [];
    // 10 overrides → rate = 10/50 = 20% > 10% threshold
    for (let i = 0; i < 10; i++) {
      overrides.push({
        schemaVersion: 1,
        ts: `2026-05-02T11:0${i}:00.000Z`,
        snapshotPath: snapshots[i]!.path,
        dispatcherTopId: 'AISDLC-AAA',
        operatorPickedId: 'AISDLC-BBB',
        ranking: [{ id: 'AISDLC-AAA', position: 1 }],
      });
    }
    const r = aggregateDispatchCorpus(snapshots, { overrides });
    expect(r.aggregate.recommendation).toBe('continue-soak');
    expect(r.aggregate.reason).toContain('override rate');
    expect(r.aggregate.overrides.matchedToCorpus).toBe(10);
    expect(r.aggregate.overrides.rate).toBeCloseTo(0.2, 5);
  });

  it('respects --min-snapshots override (lowers floor)', () => {
    const snapshots = buildAgreeingCorpus(5);
    const r = aggregateDispatchCorpus(snapshots, { minSnapshots: 3 });
    expect(r.aggregate.recommendation).toBe('safe-to-promote');
  });

  it('respects --correctness-threshold (raising it can flip recommendation)', () => {
    const snapshots = buildAgreeingCorpus(50);
    // Inject one disagreement → 49/50 = 98%. Raising threshold to 99%
    // forces continue-soak.
    snapshots[0]!.records = [
      record({ id: 'AISDLC-A', criticalPathLength: 0 }),
      record({ id: 'AISDLC-Z', criticalPathLength: 9 }),
    ];
    const r = aggregateDispatchCorpus(snapshots, { correctnessThreshold: 0.99 });
    expect(r.aggregate.recommendation).toBe('continue-soak');
  });

  it('falls back to total override count when no overrides match the corpus', () => {
    const snapshots = buildAgreeingCorpus(50);
    const overrides: OverrideEntry[] = [
      {
        schemaVersion: 1,
        ts: '2026-05-02T11:00:00.000Z',
        snapshotPath: '/some/foreign/snapshot.jsonl',
        dispatcherTopId: 'AISDLC-AAA',
        operatorPickedId: 'AISDLC-BBB',
        ranking: [{ id: 'AISDLC-AAA', position: 1 }],
      },
    ];
    const r = aggregateDispatchCorpus(snapshots, { overrides });
    // matchedToCorpus = 0 → fallback rate = total/snapshotCount = 1/50 = 2%
    expect(r.aggregate.overrides.matchedToCorpus).toBe(0);
    expect(r.aggregate.overrides.rate).toBeCloseTo(1 / 50, 5);
    // 2% < 10% threshold → still safe-to-promote
    expect(r.aggregate.recommendation).toBe('safe-to-promote');
  });

  it('per-snapshot rows preserve the snapshot order (calendar order)', () => {
    const snapshots = buildAgreeingCorpus(3);
    const r = aggregateDispatchCorpus(snapshots);
    expect(r.perSnapshot.map((p) => p.isoTimestamp)).toEqual(snapshots.map((s) => s.isoTimestamp));
  });
});

describe('findSnapshotFiles + loadSnapshotCorpus', () => {
  it('returns empty array for missing root', () => {
    expect(findSnapshotFiles(join(tmp, 'never-existed'))).toEqual([]);
  });

  it('recurses into subdirectories (gh run download layout)', () => {
    const sub = join(tmp, 'artifact-1');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl'),
      JSON.stringify(record({ id: 'AISDLC-A' })) + '\n',
      'utf8',
    );
    const sub2 = join(tmp, 'artifact-2');
    mkdirSync(sub2, { recursive: true });
    writeFileSync(
      join(sub2, 'snapshot.2026-05-02T11-00-00.000Z.rolling.jsonl'),
      JSON.stringify(record({ id: 'AISDLC-B' })) + '\n',
      'utf8',
    );
    const files = findSnapshotFiles(tmp);
    expect(files).toHaveLength(2);
  });

  it('skips overrides.jsonl in the snapshot scan', () => {
    mkdirSync(join(tmp, '_deps'), { recursive: true });
    writeFileSync(join(tmp, '_deps', 'overrides.jsonl'), '{}\n', 'utf8');
    writeFileSync(
      join(tmp, '_deps', 'snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl'),
      JSON.stringify(record({ id: 'AISDLC-A' })) + '\n',
      'utf8',
    );
    const files = findSnapshotFiles(tmp);
    expect(files.some((f) => f.endsWith('overrides.jsonl'))).toBe(false);
    expect(files.some((f) => f.endsWith('rolling.jsonl'))).toBe(true);
  });

  it('skips malformed lines and counts them in skippedLines', () => {
    const path = writeSnapshotFile('snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl', []);
    writeFileSync(
      path,
      [
        JSON.stringify(record({ id: 'AISDLC-A' })),
        '{ not json',
        JSON.stringify({ malformed: true }),
        JSON.stringify(record({ id: 'AISDLC-B' })),
      ].join('\n'),
      'utf8',
    );
    const r = loadSnapshotCorpus([path]);
    expect(r.snapshots).toHaveLength(1);
    expect(r.snapshots[0]!.records).toHaveLength(2);
    expect(r.skippedLines).toBe(2);
    expect(r.skippedFiles).toBe(0);
  });

  it('skips an entirely-malformed file as a skippedFile', () => {
    const path = writeSnapshotFile('snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl', []);
    writeFileSync(path, '{ not json\n{ also not json\n', 'utf8');
    const r = loadSnapshotCorpus([path]);
    expect(r.snapshots).toHaveLength(0);
    expect(r.skippedFiles).toBe(1);
  });

  it('treats an empty file as a skippedFile', () => {
    const path = writeSnapshotFile('snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl', []);
    writeFileSync(path, '', 'utf8');
    const r = loadSnapshotCorpus([path]);
    expect(r.snapshots).toHaveLength(0);
    expect(r.skippedFiles).toBe(1);
  });
});

describe('cli-deps-corpus router', () => {
  it('aggregate emits a JSON envelope with the recommendation', async () => {
    // Materialise 50 snapshot files on disk so the CLI's full path is exercised.
    for (let i = 0; i < 50; i++) {
      writeSnapshotFile(
        `snapshot.2026-05-02T10-${String(i).padStart(2, '0')}-00.000Z.rolling.jsonl`,
        [
          record({ id: 'AISDLC-AAA', criticalPathLength: 5 }),
          record({ id: 'AISDLC-BBB', criticalPathLength: 1 }),
        ],
      );
    }
    setArgv('aggregate', tmp);
    await buildDepsCorpusCli().parseAsync();
    const r = stdoutJson() as {
      aggregate: { recommendation: string; snapshotCount: number };
      perSnapshot: unknown[];
    };
    expect(r.aggregate.recommendation).toBe('safe-to-promote');
    expect(r.aggregate.snapshotCount).toBe(50);
    expect(r.perSnapshot).toHaveLength(50);
  });

  it('aggregate auto-detects overrides.jsonl in the input dir', async () => {
    for (let i = 0; i < 50; i++) {
      writeSnapshotFile(
        `snapshot.2026-05-02T10-${String(i).padStart(2, '0')}-00.000Z.rolling.jsonl`,
        [record({ id: 'AISDLC-AAA', criticalPathLength: 5 })],
      );
    }
    const overrides: OverrideEntry[] = [];
    for (let i = 0; i < 8; i++) {
      overrides.push({
        schemaVersion: 1,
        ts: `2026-05-02T11:0${i}:00.000Z`,
        snapshotPath: '',
        dispatcherTopId: 'AISDLC-AAA',
        operatorPickedId: 'AISDLC-BBB',
        ranking: [{ id: 'AISDLC-AAA', position: 1 }],
      });
    }
    writeOverrideFile(overrides);

    setArgv('aggregate', tmp);
    await buildDepsCorpusCli().parseAsync();
    const r = stdoutJson() as {
      aggregate: { overrides: { total: number }; recommendation: string };
    };
    expect(r.aggregate.overrides.total).toBe(8);
    // 8/50 = 16% > 10% → continue-soak (override-rate gate fires)
    expect(r.aggregate.recommendation).toBe('continue-soak');
  });

  it('aggregate --format table renders an ASCII summary', async () => {
    writeSnapshotFile('snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl', [
      record({ id: 'AISDLC-AAA', criticalPathLength: 1 }),
    ]);
    setArgv('aggregate', tmp, '--format', 'table');
    await buildDepsCorpusCli().parseAsync();
    const text = stdoutText();
    expect(text).toContain('snapshot');
    expect(text).toContain('Recommendation:');
    expect(text).toContain('insufficient-data');
  });

  it('aggregate accepts an explicit --overrides-file', async () => {
    for (let i = 0; i < 50; i++) {
      writeSnapshotFile(
        `snapshot.2026-05-02T10-${String(i).padStart(2, '0')}-00.000Z.rolling.jsonl`,
        [record({ id: 'AISDLC-AAA', criticalPathLength: 5 })],
      );
    }
    const overrideDir = join(tmp, 'elsewhere');
    mkdirSync(overrideDir, { recursive: true });
    const overrideFile = join(overrideDir, 'my-overrides.jsonl');
    writeFileSync(
      overrideFile,
      JSON.stringify({
        schemaVersion: 1,
        ts: '2026-05-02T11:00:00.000Z',
        snapshotPath: '',
        dispatcherTopId: 'AISDLC-AAA',
        operatorPickedId: 'AISDLC-CCC',
        ranking: [{ id: 'AISDLC-AAA', position: 1 }],
      }) + '\n',
      'utf8',
    );

    setArgv('aggregate', tmp, '--overrides-file', overrideFile);
    await buildDepsCorpusCli().parseAsync();
    const r = stdoutJson() as { aggregate: { overrides: { total: number } } };
    expect(r.aggregate.overrides.total).toBe(1);
  });

  it('respects --min-snapshots / --correctness-threshold / --override-threshold', async () => {
    writeSnapshotFile('snapshot.2026-05-02T10-00-00.000Z.rolling.jsonl', [
      record({ id: 'AISDLC-AAA', criticalPathLength: 1 }),
    ]);
    setArgv(
      'aggregate',
      tmp,
      '--min-snapshots',
      '1',
      '--correctness-threshold',
      '0.5',
      '--override-threshold',
      '0.5',
    );
    await buildDepsCorpusCli().parseAsync();
    const r = stdoutJson() as { aggregate: { recommendation: string } };
    expect(r.aggregate.recommendation).toBe('safe-to-promote');
  });
});
