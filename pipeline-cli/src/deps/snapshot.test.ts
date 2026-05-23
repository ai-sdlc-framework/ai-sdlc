/**
 * RFC-0014 Phase 1 — snapshot writer + GC + inspect tests.
 *
 * Hermetic: every test builds an isolated tmp project root, points the
 * snapshot writer at a tmp `artifactsDir`, and asserts on the on-disk
 * artifact + the in-memory record set. The composition feature flag
 * `AI_SDLC_DEPS_COMPOSITION` is forced ON in the suite-level beforeEach so
 * the writer actually emits files; the OFF case has its own dedicated test.
 */

import _Ajv2020 from 'ajv/dist/2020.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDependencyGraph } from './dependency-graph.js';
import {
  computeSnapshotRecords,
  gcRollingSnapshots,
  inspectSnapshots,
  isCompositionEnabled,
  resolveSnapshotDir,
  writeSnapshot,
} from './snapshot.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

// CJS default-export interop — matches `reference/src/core/validate-schemas.ts`.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

let tmp: string;
let artifactsDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  tmp = makeTmpProject();
  artifactsDir = join(tmp, 'artifacts');
  priorEnv = process.env.AI_SDLC_DEPS_COMPOSITION;
  process.env.AI_SDLC_DEPS_COMPOSITION = '1';
});

afterEach(() => {
  cleanupTmpProject(tmp);
  if (priorEnv === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
  else process.env.AI_SDLC_DEPS_COMPOSITION = priorEnv;
});

/**
 * Write a backlog task file with an `externalDependencies:` frontmatter block
 * appended. The base `writeTaskFile` helper doesn't model nested-object lists
 * (intentionally — `parseSimpleYaml` doesn't either), so we synthesise the
 * extension here against the file the helper produced.
 */
function appendExternalDeps(
  workDir: string,
  taskId: string,
  externals: Array<{
    id: string;
    description: string;
    kind: string;
    resolverHint?: string;
  }>,
): void {
  const slug = taskId.toLowerCase();
  const dirCandidates = ['tasks', 'completed'];
  let path = '';
  for (const sub of dirCandidates) {
    const dir = join(workDir, 'backlog', sub);
    if (!existsSync(dir)) continue;
    const guessed = readdirSync(dir).find((f) => f.toLowerCase().startsWith(`${slug} -`));
    if (guessed) {
      path = join(dir, guessed);
      break;
    }
  }
  if (!path) throw new Error(`no on-disk file for ${taskId}`);
  const raw = readFileSync(path, 'utf8');
  const fmEnd = raw.indexOf('\n---\n');
  if (fmEnd < 0) throw new Error(`malformed frontmatter in ${path}`);
  const fmRaw = raw.slice(4, fmEnd); // skip leading "---\n"
  const rest = raw.slice(fmEnd);
  const lines: string[] = ['externalDependencies:'];
  for (const e of externals) {
    lines.push(`  - id: '${e.id}'`);
    lines.push(`    description: '${e.description}'`);
    lines.push(`    kind: ${e.kind}`);
    if (e.resolverHint) lines.push(`    resolverHint: '${e.resolverHint}'`);
  }
  const newFm = `${fmRaw}\n${lines.join('\n')}`;
  writeFileSync(path, `---\n${newFm}${rest}`, 'utf8');
}

describe('isCompositionEnabled (post-AISDLC-410 default-ON)', () => {
  it('treats unset / empty / random non-falsy value as ON (post-promotion default)', () => {
    expect(isCompositionEnabled({})).toBe(true);
    for (const v of ['', 'whatever', '2', 'enabled']) {
      expect(isCompositionEnabled({ AI_SDLC_DEPS_COMPOSITION: v })).toBe(true);
    }
  });

  it('treats off / 0 / false / no (any case) as OFF (operator opt-out)', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'FALSE', 'no', 'NO']) {
      expect(isCompositionEnabled({ AI_SDLC_DEPS_COMPOSITION: v })).toBe(false);
    }
  });

  it('treats 1 / true / yes / on (any case) as ON (backward-compat truthy)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
      expect(isCompositionEnabled({ AI_SDLC_DEPS_COMPOSITION: v })).toBe(true);
    }
  });
});

describe('writeSnapshot — feature flag OFF (operator opt-out)', () => {
  it('returns written=false and does not touch disk when AI_SDLC_DEPS_COMPOSITION=off', () => {
    const prior = process.env.AI_SDLC_DEPS_COMPOSITION;
    process.env.AI_SDLC_DEPS_COMPOSITION = 'off';
    try {
      writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
      const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
      expect(r.written).toBe(false);
      expect(r.bytes).toBe(0);
      expect(existsSync(r.path)).toBe(false);
      expect(existsSync(resolveSnapshotDir({ workDir: tmp, artifactsDir }))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.AI_SDLC_DEPS_COMPOSITION;
      else process.env.AI_SDLC_DEPS_COMPOSITION = prior;
    }
  });
});

describe('computeSnapshotRecords — graph projection', () => {
  it('computes depth + criticalPathLength on a 5-task chain', () => {
    // A → B → C → D → E (each task depends on the previous)
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, { id: 'AISDLC-D', title: 'd', dependencies: ['AISDLC-C'] });
    writeTaskFile(tmp, { id: 'AISDLC-E', title: 'e', dependencies: ['AISDLC-D'] });
    const g = buildDependencyGraph({ workDir: tmp });
    const recs = computeSnapshotRecords(g);
    expect(recs.map((r) => r.id)).toEqual([
      'AISDLC-A',
      'AISDLC-B',
      'AISDLC-C',
      'AISDLC-D',
      'AISDLC-E',
    ]);
    const byId = new Map(recs.map((r) => [r.id, r]));
    // depth = longest BACKWARD chain (number of hops via `dependencies`)
    expect(byId.get('AISDLC-A')?.depth).toBe(0);
    expect(byId.get('AISDLC-B')?.depth).toBe(1);
    expect(byId.get('AISDLC-C')?.depth).toBe(2);
    expect(byId.get('AISDLC-D')?.depth).toBe(3);
    expect(byId.get('AISDLC-E')?.depth).toBe(4);
    // criticalPathLength = longest FORWARD chain via reverse edges
    expect(byId.get('AISDLC-A')?.criticalPathLength).toBe(4);
    expect(byId.get('AISDLC-E')?.criticalPathLength).toBe(0);
    // dependents are the immediate reverse-edge children
    expect(byId.get('AISDLC-A')?.dependents).toEqual(['AISDLC-B']);
    expect(byId.get('AISDLC-E')?.dependents).toEqual([]);
  });

  it('computes mixed depths in a diamond graph', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D    →  D depends on B+C, both depend on A
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, { id: 'AISDLC-C', title: 'c', dependencies: ['AISDLC-A'] });
    writeTaskFile(tmp, {
      id: 'AISDLC-D',
      title: 'd',
      dependencies: ['AISDLC-B', 'AISDLC-C'],
    });
    const g = buildDependencyGraph({ workDir: tmp });
    const recs = computeSnapshotRecords(g);
    const byId = new Map(recs.map((r) => [r.id, r]));
    expect(byId.get('AISDLC-A')?.depth).toBe(0);
    expect(byId.get('AISDLC-D')?.depth).toBe(2);
    expect(byId.get('AISDLC-A')?.criticalPathLength).toBe(2);
    // D's dependents list is empty; both B and C list D
    expect(byId.get('AISDLC-A')?.dependents.sort()).toEqual(['AISDLC-B', 'AISDLC-C']);
    expect(byId.get('AISDLC-D')?.dependents).toEqual([]);
  });

  it('survives a cycle without infinite recursion', () => {
    // A ↔ B (cycle); cli-deps validate flags it separately, but the snapshot
    // writer must still produce a finite depth/CPL.
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a', dependencies: ['AISDLC-B'] });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const g = buildDependencyGraph({ workDir: tmp });
    const recs = computeSnapshotRecords(g);
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(Number.isFinite(r.depth)).toBe(true);
      expect(Number.isFinite(r.criticalPathLength)).toBe(true);
    }
  });
});

describe('writeSnapshot — emits JSONL artifact', () => {
  it('writes one record per node when the flag is ON', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    expect(r.written).toBe(true);
    expect(r.recordCount).toBe(2);
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toMatch(/\/_deps\/snapshot\..+\.rolling\.jsonl$/);
    const lines = readFileSync(r.path, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].id).toBe('AISDLC-A');
    expect(parsed[0].externalDependencies).toEqual([]); // empty when not declared
    expect(parsed[1].dependencies).toEqual(['AISDLC-A']);
  });

  it('serialises externalDependencies for each of the 5 enum values', () => {
    writeTaskFile(tmp, { id: 'AISDLC-X', title: 'x' });
    appendExternalDeps(tmp, 'AISDLC-X', [
      {
        id: 'npm-foo-2.0',
        description: 'wait for foo v2',
        kind: 'npm-version',
        resolverHint: 'foo',
      },
      { id: 'pr-bar-7', description: 'wait for bar PR #7', kind: 'github-pr' },
      { id: 'url-baz', description: 'wait for baz URL HEAD 200', kind: 'url-head' },
      { id: 'op-qux', description: 'manual ack from ops', kind: 'manual' },
      { id: 'misc', description: 'something else', kind: 'other' },
    ]);
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    expect(r.written).toBe(true);
    const line = readFileSync(r.path, 'utf8').trim();
    const rec = JSON.parse(line) as { externalDependencies: Array<{ kind: string; id: string }> };
    expect(rec.externalDependencies.map((e) => e.kind).sort()).toEqual([
      'github-pr',
      'manual',
      'npm-version',
      'other',
      'url-head',
    ]);
    const npm = rec.externalDependencies.find((e) => e.kind === 'npm-version');
    expect(npm?.id).toBe('npm-foo-2.0');
    expect((npm as { resolverHint?: string }).resolverHint).toBe('foo');
  });

  it('normalises an unknown kind to "other" without dropping the entry', () => {
    writeTaskFile(tmp, { id: 'AISDLC-Y', title: 'y' });
    appendExternalDeps(tmp, 'AISDLC-Y', [
      { id: 'mystery', description: 'unknown kind', kind: 'made-up-kind' },
    ]);
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    const rec = JSON.parse(readFileSync(r.path, 'utf8').trim());
    expect(rec.externalDependencies).toHaveLength(1);
    expect(rec.externalDependencies[0].kind).toBe('other');
  });

  it('writes empty file body for an empty graph', () => {
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    expect(r.recordCount).toBe(0);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('');
  });
});

describe('writeSnapshot — best-effort consistency (RFC-0014 Q6)', () => {
  it('survives a task file deleted mid-walk; consumer can still validate dangling edges', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    // Build the graph, then delete A's file before serialising. The graph
    // still has both nodes (A was read into memory before the delete), so the
    // snapshot is internally consistent — exactly what the contract promises.
    const g = buildDependencyGraph({ workDir: tmp });
    const aPath = g.nodes.get('aisdlc-a')?.filePath;
    expect(aPath).toBeDefined();
    if (aPath) unlinkSync(aPath);
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir, graph: g });
    expect(r.written).toBe(true);
    const lines = readFileSync(r.path, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    // If we now rebuild the graph, A is gone — `cli-deps validate` reports
    // B's dependency as dangling (the consumer-side check the contract
    // promises).
    const after = buildDependencyGraph({ workDir: tmp });
    expect(after.nodes.has('aisdlc-a')).toBe(false);
    expect(after.nodes.get('aisdlc-b')?.dependencies).toEqual(['AISDLC-A']);
  });
});

describe('gcRollingSnapshots', () => {
  it('trims rolling-tagged files older than 30d (default cutoff) and keeps event-tagged forever', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'snapshot.2025-01-01T00-00-00.000Z.rolling.jsonl');
    const fresh = join(dir, 'snapshot.2026-04-30T00-00-00.000Z.rolling.jsonl');
    const oldDispatch = join(dir, 'snapshot.2025-01-01T00-00-00.000Z.dispatch.jsonl');
    const oldCalibration = join(dir, 'snapshot.2025-01-01T00-00-00.000Z.calibration.jsonl');
    writeFileSync(old, '');
    writeFileSync(
      fresh,
      '{"id":"X","dependencies":[],"dependents":[],"depth":0,"criticalPathLength":0,"externalDependencies":[],"lastModified":""}\n',
    );
    writeFileSync(oldDispatch, '');
    writeFileSync(oldCalibration, '');
    const longAgo = new Date('2025-01-01T00:00:00.000Z').getTime() / 1000;
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldDispatch, longAgo, longAgo);
    utimesSync(oldCalibration, longAgo, longAgo);
    const now = new Date('2026-05-02T00:00:00.000Z');
    utimesSync(fresh, now.getTime() / 1000, now.getTime() / 1000);

    const r = gcRollingSnapshots({ workDir: tmp, artifactsDir, now: () => now });
    expect(r.trimmed).toEqual([old]);
    expect(r.kept.sort()).toEqual([fresh, oldCalibration, oldDispatch].sort());
    expect(r.bytesFreed).toBe(0); // empty file
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(oldDispatch)).toBe(true);
    expect(existsSync(oldCalibration)).toBe(true);
  });

  it('counts bytesFreed against the on-disk file size', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'snapshot.2025-01-01T00-00-00.000Z.rolling.jsonl');
    const payload = 'x'.repeat(1024);
    writeFileSync(old, payload);
    const longAgo = new Date('2025-01-01T00:00:00.000Z').getTime() / 1000;
    utimesSync(old, longAgo, longAgo);
    const now = new Date('2026-05-02T00:00:00.000Z');
    const r = gcRollingSnapshots({ workDir: tmp, artifactsDir, now: () => now });
    expect(r.trimmed).toEqual([old]);
    expect(r.bytesFreed).toBe(1024);
  });

  it('preserves a zero-byte rolling file under the age cap (does not crash on stat==0)', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    const fresh = join(dir, 'snapshot.2026-04-30T00-00-00.000Z.rolling.jsonl');
    writeFileSync(fresh, '');
    const now = new Date('2026-05-01T00:00:00.000Z');
    utimesSync(fresh, now.getTime() / 1000 - 60, now.getTime() / 1000 - 60); // 1 min ago
    const r = gcRollingSnapshots({ workDir: tmp, artifactsDir, now: () => now });
    expect(r.trimmed).toEqual([]);
    expect(r.kept).toEqual([fresh]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('returns empty result when the snapshot dir does not exist', () => {
    const r = gcRollingSnapshots({ workDir: tmp, artifactsDir });
    expect(r).toEqual({ trimmed: [], kept: [], bytesFreed: 0 });
  });

  it('respects a custom maxAgeDays', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    const sevenDaysAgo = join(dir, 'snapshot.2026-04-25T00-00-00.000Z.rolling.jsonl');
    writeFileSync(sevenDaysAgo, '');
    const ts = new Date('2026-04-25T00:00:00.000Z').getTime() / 1000;
    utimesSync(sevenDaysAgo, ts, ts);
    const now = new Date('2026-05-02T00:00:00.000Z');

    // 30d cutoff → kept
    const a = gcRollingSnapshots({ workDir: tmp, artifactsDir, now: () => now });
    expect(a.trimmed).toEqual([]);
    expect(a.kept).toEqual([sevenDaysAgo]);

    // 3d cutoff → trimmed
    const b = gcRollingSnapshots({
      workDir: tmp,
      artifactsDir,
      now: () => now,
      maxAgeDays: 3,
    });
    expect(b.trimmed).toEqual([sevenDaysAgo]);
  });
});

describe('inspectSnapshots', () => {
  it('lists every snapshot when no tag filter is set, sorted by timestamp', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    const f1 = join(dir, 'snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl');
    const f2 = join(dir, 'snapshot.2026-05-02T00-00-00.000Z.dispatch.jsonl');
    const f3 = join(dir, 'snapshot.2026-05-03T00-00-00.000Z.calibration.jsonl');
    writeFileSync(f3, '{}\n{}\n');
    writeFileSync(f1, '{}\n');
    writeFileSync(f2, '{}\n{}\n{}\n');
    const list = inspectSnapshots({ workDir: tmp, artifactsDir });
    expect(list.map((e) => e.tag)).toEqual(['rolling', 'dispatch', 'calibration']);
    expect(list[0].recordCount).toBe(1);
    expect(list[1].recordCount).toBe(3);
    expect(list[2].recordCount).toBe(2);
  });

  it('filters to a single tag when --tag is set', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl'), '{}\n');
    writeFileSync(join(dir, 'snapshot.2026-05-02T00-00-00.000Z.dispatch.jsonl'), '{}\n');
    const list = inspectSnapshots({ workDir: tmp, artifactsDir, tag: 'dispatch' });
    expect(list.map((e) => e.tag)).toEqual(['dispatch']);
  });

  it('reports recordCount=0 for a zero-byte file without crashing', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.2026-05-01T00-00-00.000Z.rolling.jsonl'), '');
    const list = inspectSnapshots({ workDir: tmp, artifactsDir });
    expect(list).toHaveLength(1);
    expect(list[0].recordCount).toBe(0);
    expect(list[0].size).toBe(0);
  });

  it('skips files whose suffix is not a known SnapshotTag', () => {
    const dir = resolveSnapshotDir({ workDir: tmp, artifactsDir });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshot.2026-05-01T00-00-00.000Z.weirdtag.jsonl'), '{}\n');
    writeFileSync(join(dir, 'snapshot.2026-05-02T00-00-00.000Z.rolling.jsonl'), '{}\n');
    const list = inspectSnapshots({ workDir: tmp, artifactsDir });
    expect(list.map((e) => e.tag)).toEqual(['rolling']);
  });
});

describe('schema validation', () => {
  it('a real snapshot fixture validates against deps-snapshot.v1.schema.json', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    writeTaskFile(tmp, { id: 'AISDLC-B', title: 'b', dependencies: ['AISDLC-A'] });
    appendExternalDeps(tmp, 'AISDLC-B', [
      { id: 'npm-x-1.0', description: 'wait for x v1', kind: 'npm-version' },
    ]);
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    const lines = readFileSync(r.path, 'utf8').split('\n').filter(Boolean);
    const records = lines.map((l) => JSON.parse(l));

    // Resolve the schema relative to this test file. We're at
    // pipeline-cli/src/deps/snapshot.test.ts → up four → repo root → spec/schemas.
    const schemaPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'spec',
      'schemas',
      'deps-snapshot.v1.schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    for (const rec of records) {
      const ok = validate(rec);
      if (!ok) throw new Error(`schema mismatch: ${JSON.stringify(validate.errors)}`);
      expect(ok).toBe(true);
    }
  });

  it('a record missing externalDependencies fails the schema (required field)', () => {
    const schemaPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'spec',
      'schemas',
      'deps-snapshot.v1.schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const bad = {
      id: 'AISDLC-A',
      dependencies: [],
      dependents: [],
      depth: 0,
      criticalPathLength: 0,
      lastModified: '',
    };
    expect(validate(bad)).toBe(false);
  });

  it('a record with kind=invalid-enum fails the schema', () => {
    const schemaPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'spec',
      'schemas',
      'deps-snapshot.v1.schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const bad = {
      id: 'AISDLC-A',
      dependencies: [],
      dependents: [],
      depth: 0,
      criticalPathLength: 0,
      externalDependencies: [{ id: 'x', description: 'y', kind: 'whatever' }],
      lastModified: '',
    };
    expect(validate(bad)).toBe(false);
  });
});

describe('snapshot file size reporting', () => {
  it('records bytes written on success', () => {
    writeTaskFile(tmp, { id: 'AISDLC-A', title: 'a' });
    const r = writeSnapshot('rolling', { workDir: tmp, artifactsDir });
    expect(r.bytes).toBeGreaterThan(0);
    const onDisk = statSync(r.path).size;
    expect(r.bytes).toBe(onDisk);
  });
});
