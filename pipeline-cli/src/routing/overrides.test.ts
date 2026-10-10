import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRoutingTable } from './load-table.js';
import type { RoutingTable } from './default-table.js';
import {
  dropStaleOverrides,
  findOverride,
  overridesPath,
  readOverrideEntries,
  safeOverridesPath,
  writeOverride,
} from './overrides.js';

const TABLE = `
apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
spec:
  strength: [haiku, sonnet, opus]
  cells:
    developer:
      '*': { model: sonnet }
      chore: { model: haiku }
    security-reviewer:
      '*': { model: opus }
`;

let dir: string;
let artifacts: string;
let outside: string;
let table: RoutingTable;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'overrides-'));
  artifacts = join(dir, '.ai-sdlc', 'artifacts');
  outside = join(dir, 'outside');
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const parsed = parseRoutingTable(TABLE);
  if (!parsed.ok) throw new Error('fixture');
  table = parsed.table;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeOverride (strength-only)', () => {
  it('writes an override to a stronger model and records the table model it covers', () => {
    const r = writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'opus' });
    expect(r).toEqual({
      ok: true,
      override: { role: 'developer', taskClass: '*', model: 'opus', tableModel: 'sonnet' },
    });
    const file = JSON.parse(readFileSync(overridesPath(artifacts), 'utf8'));
    expect(file.overrides).toEqual([
      { role: 'developer', taskClass: '*', model: 'opus', tableModel: 'sonnet' },
    ]);
    expect(findOverride(readOverrideEntries(artifacts), table, 'developer', 'bug')).toBe('opus');
  });

  it('refuses a weaker or equal model and writes nothing', () => {
    for (const model of ['haiku', 'sonnet']) {
      const r = writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model });
      expect(r).toEqual({ ok: false, reason: 'model is not stronger than the table cell' });
    }
    expect(readOverrideEntries(artifacts)).toEqual([]);
  });

  it('refuses a model outside the strength order and a role with no cell', () => {
    expect(
      writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'mystery' }),
    ).toMatchObject({ ok: false, reason: 'model is not in the strength order' });
    expect(
      writeOverride(artifacts, table, { role: 'nobody', taskClass: '*', model: 'opus' }),
    ).toMatchObject({ ok: false, reason: 'no table cell for this role and class' });
  });

  it('replaces an earlier override for the same cell and keeps others', () => {
    writeOverride(artifacts, table, { role: 'developer', taskClass: 'chore', model: 'sonnet' });
    writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'sonnet' });
    writeOverride(artifacts, table, { role: 'developer', taskClass: 'chore', model: 'opus' });
    const entries = readOverrideEntries(artifacts) as Array<{ taskClass: string; model: string }>;
    expect(entries.map((e) => `${e.taskClass}:${e.model}`).sort()).toEqual(['chore:opus']);
  });

  it('creates the artifacts directory when it does not exist yet', () => {
    const fresh = join(dir, 'fresh', 'artifacts');
    expect(
      writeOverride(fresh, table, { role: 'developer', taskClass: '*', model: 'opus' }).ok,
    ).toBe(true);
  });

  it('refuses a symlinked _routing directory that leaves the artifacts directory', () => {
    symlinkSync(outside, join(artifacts, '_routing'));
    const r = writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'opus' });
    expect(r).toEqual({ ok: false, reason: 'path leaves the artifacts directory' });
    expect(() => readFileSync(join(outside, 'overrides.json'))).toThrow();
  });

  it('refuses a symlinked overrides.json that leaves the artifacts directory', () => {
    mkdirSync(join(artifacts, '_routing'));
    const target = join(outside, 'target.json');
    writeFileSync(target, '{"version":1,"overrides":[]}');
    symlinkSync(target, overridesPath(artifacts));
    const r = writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'opus' });
    expect(r).toEqual({ ok: false, reason: 'path leaves the artifacts directory' });
    expect(readFileSync(target, 'utf8')).toBe('{"version":1,"overrides":[]}');
  });

  it('refuses a dangling symlink and ignores an out-of-tree file on read', () => {
    mkdirSync(join(artifacts, '_routing'));
    symlinkSync(join(outside, 'missing.json'), overridesPath(artifacts));
    expect(safeOverridesPath(artifacts)).toEqual({ reason: 'path leaves the artifacts directory' });

    rmSync(overridesPath(artifacts));
    const target = join(outside, 'planted.json');
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        overrides: [{ role: 'developer', taskClass: '*', model: 'opus' }],
      }),
    );
    symlinkSync(target, overridesPath(artifacts));
    expect(readOverrideEntries(artifacts)).toEqual([]);
  });

  it('accepts a symlink that stays inside the artifacts directory', () => {
    mkdirSync(join(artifacts, 'real-routing'));
    symlinkSync(join(artifacts, 'real-routing'), join(artifacts, '_routing'));
    expect(
      writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'opus' }).ok,
    ).toBe(true);
  });

  it('reports an unwritable overrides file as a refusal, not a throw', () => {
    mkdirSync(overridesPath(artifacts), { recursive: true });
    const r = writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'opus' });
    expect(r.ok).toBe(false);
  });

  it('reports an uncreatable artifacts directory as a refusal', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(
      writeOverride(join(blocker, 'sub'), table, {
        role: 'developer',
        taskClass: '*',
        model: 'opus',
      }),
    ).toEqual({ ok: false, reason: 'could not create the artifacts directory' });
  });
});

describe('hand-edited overrides', () => {
  it('are ignored by the resolver when weaker, equal or unknown', () => {
    mkdirSync(join(artifacts, '_routing'));
    writeFileSync(
      overridesPath(artifacts),
      JSON.stringify({
        version: 1,
        overrides: [
          { role: 'developer', taskClass: '*', model: 'haiku' },
          { role: 'developer', taskClass: '*', model: 'sonnet' },
          { role: 'developer', taskClass: '*', model: 'mystery' },
        ],
      }),
    );
    expect(findOverride(readOverrideEntries(artifacts), table, 'developer', 'bug')).toBeUndefined();
  });
});

describe('dropStaleOverrides', () => {
  it('drops an override once its table cell changed, and keeps the rest', () => {
    writeOverride(artifacts, table, { role: 'developer', taskClass: '*', model: 'opus' });
    const changed: RoutingTable = {
      ...table,
      cells: { ...table.cells, developer: { ...table.cells.developer, '*': { model: 'haiku' } } },
    };
    expect(dropStaleOverrides(artifacts, table)).toEqual([]);
    const dropped = dropStaleOverrides(artifacts, changed);
    expect(dropped).toEqual([
      { role: 'developer', taskClass: '*', model: 'opus', tableModel: 'sonnet' },
    ]);
    expect(readOverrideEntries(artifacts)).toEqual([]);
  });

  it('drops an override whose cell no longer exists', () => {
    writeOverride(artifacts, table, { role: 'developer', taskClass: 'chore', model: 'opus' });
    const { developer: _gone, ...rest } = table.cells;
    expect(dropStaleOverrides(artifacts, { ...table, cells: rest })).toHaveLength(1);
  });

  it('leaves hand-written entries without a recorded table model alone', () => {
    mkdirSync(join(artifacts, '_routing'));
    const entry = { role: 'developer', taskClass: '*', model: 'opus' };
    writeFileSync(overridesPath(artifacts), JSON.stringify({ version: 1, overrides: [entry, 7] }));
    expect(dropStaleOverrides(artifacts, table)).toEqual([]);
    expect(readOverrideEntries(artifacts)).toEqual([entry, 7]);
  });

  it('does nothing when the file is missing or the path leaves the directory', () => {
    expect(dropStaleOverrides(artifacts, table)).toEqual([]);
    mkdirSync(join(artifacts, '_routing'));
    const target = join(outside, 'x.json');
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        overrides: [{ role: 'developer', taskClass: '*', model: 'opus', tableModel: 'haiku' }],
      }),
    );
    symlinkSync(target, overridesPath(artifacts));
    expect(dropStaleOverrides(artifacts, table)).toEqual([]);
  });
});
