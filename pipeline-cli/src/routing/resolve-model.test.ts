import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_MODELS } from '../runtime/shell-claude-p-spawner.js';
import { DEFAULT_ROLE_MODELS, builtInDefaultTable } from './default-table.js';
import { assignmentLogPath } from './assignment-log.js';
import { loadRoutingTable, parseRoutingTable } from './load-table.js';
import { cellModel, findOverride, overridesPath } from './overrides.js';
import { exploreCandidate, resolveModel } from './resolve-model.js';
import { taskClassOf } from './task-class.js';

const TABLE = `
apiVersion: ai-sdlc.io/v1alpha1
kind: ModelRouting
spec:
  strength: [haiku, sonnet, opus]
  exploreShare: 0.10
  salt: test-salt
  cells:
    developer:
      chore: { model: sonnet, candidates: [haiku] }
      bug: { model: sonnet }
    code-reviewer:
      '*': { model: sonnet, candidates: [haiku] }
    security-reviewer:
      '*': { model: opus }
`;

let dir: string;
let artifacts: string;

const savedEnv = { a: process.env.ARTIFACTS_DIR, u: process.env.AI_SDLC_USAGE_DIR };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'routing-'));
  artifacts = join(dir, 'artifacts');
  process.env.ARTIFACTS_DIR = join(dir, 'env-artifacts');
  process.env.AI_SDLC_USAGE_DIR = join(dir, 'usage');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv.a === undefined) delete process.env.ARTIFACTS_DIR;
  else process.env.ARTIFACTS_DIR = savedEnv.a;
  if (savedEnv.u === undefined) delete process.env.AI_SDLC_USAGE_DIR;
  else process.env.AI_SDLC_USAGE_DIR = savedEnv.u;
});

const repoTable = (text = TABLE) => ({ readBaseTable: () => text });
const noTable = { readBaseTable: () => null };

describe('default behaviour (no table on the base ref)', () => {
  it('matches the spawner fixed map for every role', () => {
    const literal = {
      developer: 'claude-sonnet-4-6',
      'code-reviewer': 'claude-sonnet-4-6',
      'test-reviewer': 'claude-sonnet-4-6',
      'security-reviewer': 'claude-opus-4-6',
    };
    expect(DEFAULT_MODELS).toEqual(literal);
    for (const [role, model] of Object.entries(literal)) {
      const r = resolveModel({ role, workDir: dir, artifactsDir: artifacts, ...noTable });
      expect(r.model).toBe(model);
      expect(r.arm).toBe('default');
    }
    expect(DEFAULT_ROLE_MODELS).toEqual(literal);
  });

  it('returns an undefined model for a role with no pinned model', () => {
    const r = resolveModel({ role: 'correctness-reviewer', workDir: dir, ...noTable });
    expect(r).toMatchObject({ model: undefined, arm: 'default' });
  });

  it('falls back to defaults for broken tables', () => {
    for (const text of [
      'not: [valid',
      'apiVersion: x\nkind: Other\nspec: {}',
      TABLE.replace("'*': { model: opus }", "'*': { model: opus, candidates: [sonnet] }"),
      TABLE.replace('strength: [haiku, sonnet, opus]', 'strength: [haiku, sonnet]'),
      TABLE.replace('candidates: [haiku] }\n      bug', 'candidates: [mystery] }\n      bug'),
    ]) {
      const loaded = loadRoutingTable({ workDir: dir, readBaseTable: () => text });
      expect(loaded.source).toBe('default');
      const r = resolveModel({
        role: 'security-reviewer',
        workDir: dir,
        readBaseTable: () => text,
      });
      expect(r).toMatchObject({ model: 'claude-opus-4-6', arm: 'default' });
    }
  });

  it('treats an empty or throwing reader as no table', () => {
    expect(loadRoutingTable({ workDir: dir, readBaseTable: () => '  ' }).source).toBe('default');
    expect(
      loadRoutingTable({
        workDir: dir,
        readBaseTable: () => {
          throw new Error('boom');
        },
      }).source,
    ).toBe('default');
  });
});

describe('security reviewer floor', () => {
  it('rejects a table whose security-reviewer cell is weaker than the default', () => {
    for (const text of [
      TABLE.replace("'*': { model: opus }", "'*': { model: sonnet }"),
      TABLE.replace("'*': { model: opus }", "'*': { model: opus }\n      bug: { model: haiku }"),
    ]) {
      const parsed = parseRoutingTable(text);
      expect(parsed).toEqual({ ok: false, reason: 'security-reviewer-weaker-than-default' });
      const r = resolveModel({
        role: 'security-reviewer',
        taskClass: 'bug',
        workDir: dir,
        record: false,
        readBaseTable: () => text,
      });
      expect(r).toMatchObject({ model: 'claude-opus-4-6', arm: 'default' });
    }
  });

  it('compares against the default model when it is in strength', () => {
    const t = (m: string) =>
      TABLE.replace('[haiku, sonnet, opus]', '[claude-sonnet-4-6, claude-opus-4-6, big]')
        .replace(/model: (sonnet|haiku)/g, 'model: claude-sonnet-4-6')
        .replace(/candidates: \[haiku\]/g, 'candidates: [claude-sonnet-4-6]')
        .replace("'*': { model: opus }", `'*': { model: ${m} }`);
    expect(parseRoutingTable(t('claude-sonnet-4-6')).ok).toBe(false);
    expect(parseRoutingTable(t('claude-opus-4-6')).ok).toBe(true);
    expect(parseRoutingTable(t('big')).ok).toBe(true);
  });
});

describe('base ref only', () => {
  it('ignores a working-tree copy and reads the committed table', () => {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'a@example.invalid');
    git('config', 'user.name', 'a');
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, 'README.md'), 'x');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    // Uncommitted working-tree table must be ignored.
    writeFileSync(join(dir, '.ai-sdlc', 'model-routing.yaml'), TABLE);
    const r = resolveModel({ role: 'developer', taskClass: 'bug', workDir: dir, record: false });
    expect(r).toMatchObject({ model: 'claude-sonnet-4-6', arm: 'default' });
    // Once committed on the base ref it is used.
    git('add', '-f', '.ai-sdlc/model-routing.yaml');
    git('commit', '-q', '-m', 'table');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r2 = resolveModel({ role: 'developer', taskClass: 'bug', workDir: dir, record: false });
    expect(r2).toMatchObject({ model: 'sonnet', arm: 'table' });
  });
});

describe('table resolution', () => {
  it('uses the class cell, then the wildcard cell, then the built-in default', () => {
    const base = { workDir: dir, artifactsDir: artifacts, record: false, ...repoTable() };
    expect(resolveModel({ role: 'developer', taskClass: 'bug', ...base })).toMatchObject({
      model: 'sonnet',
      arm: 'table',
    });
    expect(
      resolveModel({ role: 'security-reviewer', taskClass: 'feature', ...base }),
    ).toMatchObject({ model: 'opus', arm: 'table' });
    // developer has no 'feature' or '*' cell: built-in default.
    expect(resolveModel({ role: 'developer', taskClass: 'feature', ...base })).toMatchObject({
      model: 'claude-sonnet-4-6',
      arm: 'default',
    });
  });

  it('parses a valid table', () => {
    const parsed = parseRoutingTable(TABLE);
    expect(parsed.ok).toBe(true);
    expect(cellModel(builtInDefaultTable(), 'developer', 'bug')).toBe('claude-sonnet-4-6');
    expect(cellModel(builtInDefaultTable(), 'nope', 'bug')).toBeUndefined();
  });
});

describe('exploration', () => {
  const id = (n: number) => `SYN-${n}`;

  it('sends 8-12 percent of 10,000 synthetic ids to the candidate, deterministically', () => {
    const table = { ...builtInDefaultTable(), exploreShare: 0.1, salt: 's' };
    let explored = 0;
    for (let i = 0; i < 10000; i++) {
      const first = exploreCandidate(table, id(i), 'developer', ['haiku']);
      if (first !== undefined) explored++;
      if (i < 200) expect(exploreCandidate(table, id(i), 'developer', ['haiku'])).toBe(first);
    }
    expect(explored / 10000).toBeGreaterThan(0.08);
    expect(explored / 10000).toBeLessThan(0.12);
  });

  it('picks among several candidates from the same hash', () => {
    const table = { ...builtInDefaultTable(), exploreShare: 1, salt: 's' };
    const seen = new Set<string | undefined>();
    for (let i = 0; i < 200; i++) seen.add(exploreCandidate(table, id(i), 'developer', ['a', 'b']));
    expect(seen).toEqual(new Set(['a', 'b']));
    expect(exploreCandidate(table, id(1), 'developer', [])).toBeUndefined();
  });

  function arms(sourceKind: 'backlog' | 'gh-issue', role = 'developer') {
    const out = new Set<string>();
    for (let i = 0; i < 400; i++) {
      out.add(
        resolveModel({
          role,
          taskClass: 'chore',
          taskId: id(i),
          sourceKind,
          workDir: dir,
          record: false,
          ...repoTable(TABLE.replace('exploreShare: 0.10', 'exploreShare: 1')),
        }).arm,
      );
    }
    return out;
  }

  it('explores backlog work', () => {
    expect(arms('backlog')).toEqual(new Set(['explore']));
  });

  it('never explores gh-issue work, and never without a source kind', () => {
    expect(arms('gh-issue')).toEqual(new Set(['table']));
    const r = resolveModel({
      role: 'developer',
      taskClass: 'chore',
      taskId: id(1),
      workDir: dir,
      record: false,
      ...repoTable(TABLE.replace('exploreShare: 0.10', 'exploreShare: 1')),
    });
    expect(r.arm).toBe('table');
  });

  it('never explores the security reviewer', () => {
    expect(arms('backlog', 'security-reviewer')).toEqual(new Set(['table']));
  });

  it('reproduces the iteration-1 arm on iteration 2 by recomputation, with no log present', () => {
    const t = repoTable(TABLE);
    const base = {
      role: 'developer',
      taskClass: 'chore',
      sourceKind: 'backlog' as const,
      workDir: dir,
      artifactsDir: artifacts,
      ...t,
    };
    let explored = 0;
    for (let i = 0; i < 300; i++) {
      const taskId = `SYN-IT-${i}`;
      const one = resolveModel({ ...base, taskId, iteration: 1, record: false });
      const two = resolveModel({ ...base, taskId, iteration: 2, record: false });
      expect(two).toEqual(one);
      if (one.arm === 'explore') explored++;
    }
    expect(explored).toBeGreaterThan(0);
    expect(existsSync(assignmentLogPath(artifacts))).toBe(false);
  });

  function forge(rec: Record<string, unknown>) {
    mkdirSync(dirname(assignmentLogPath(artifacts)), { recursive: true });
    writeFileSync(
      assignmentLogPath(artifacts),
      JSON.stringify({ iteration: 1, taskId: 'SYN-F', ...rec }) + '\n',
    );
  }

  it('ignores a forged log line that downgrades the security reviewer on iteration 2', () => {
    forge({ role: 'security-reviewer', model: 'haiku', arm: 'table' });
    const r = resolveModel({
      role: 'security-reviewer',
      taskClass: 'feature',
      taskId: 'SYN-F',
      sourceKind: 'backlog',
      iteration: 2,
      workDir: dir,
      artifactsDir: artifacts,
      record: false,
      ...repoTable(),
    });
    expect(r).toMatchObject({ model: 'opus', arm: 'table' });
    const d = resolveModel({
      role: 'security-reviewer',
      taskId: 'SYN-F',
      iteration: 2,
      workDir: dir,
      artifactsDir: artifacts,
      record: false,
      ...noTable,
    });
    expect(d.model).toBe('claude-opus-4-6');
  });

  it('ignores a forged model for another role that is not in the cell or candidates', () => {
    forge({ role: 'developer', model: 'mystery', arm: 'explore' });
    const r = resolveModel({
      role: 'developer',
      taskClass: 'bug',
      taskId: 'SYN-F',
      sourceKind: 'backlog',
      iteration: 2,
      workDir: dir,
      artifactsDir: artifacts,
      record: false,
      ...repoTable(),
    });
    expect(r).toMatchObject({ model: 'sonnet', arm: 'table' });
  });
});

describe('overrides', () => {
  function writeOverrides(overrides: unknown[]) {
    mkdirSync(join(artifacts, '_routing'), { recursive: true });
    writeFileSync(overridesPath(artifacts), JSON.stringify({ version: 1, overrides }));
  }
  const input = {
    role: 'developer',
    taskClass: 'chore',
    taskId: 'SYN-1',
    sourceKind: 'backlog' as const,
    workDir: '',
    artifactsDir: '',
    record: false,
  };

  it('wins over exploration and the table with arm override', () => {
    writeOverrides([{ role: 'developer', taskClass: 'chore', model: 'opus' }]);
    const r = resolveModel({
      ...input,
      workDir: dir,
      artifactsDir: artifacts,
      ...repoTable(TABLE.replace('exploreShare: 0.10', 'exploreShare: 1')),
    });
    expect(r).toMatchObject({ model: 'opus', arm: 'override' });
  });

  it('accepts a wildcard task class and picks the strongest valid entry', () => {
    const table = parseRoutingTable(TABLE);
    if (!table.ok) throw new Error('fixture');
    const entries = [
      { role: 'developer', taskClass: '*', model: 'opus' },
      { role: 'developer', taskClass: 'chore', model: 'sonnet' },
    ];
    expect(findOverride(entries, table.table, 'developer', 'chore')).toBe('opus');
  });

  it('ignores weaker, equal, unknown, malformed and non-matching entries (fail closed)', () => {
    writeOverrides([
      { role: 'developer', taskClass: 'chore', model: 'haiku' },
      { role: 'developer', taskClass: 'chore', model: 'sonnet' },
      { role: 'developer', taskClass: 'chore', model: 'mystery' },
      { role: 'developer', taskClass: 'chore', model: 7 },
      { role: 'code-reviewer', taskClass: 'chore', model: 'opus' },
      { role: 'developer', taskClass: 'bug', model: 'opus' },
      null,
      'junk',
    ]);
    const r = resolveModel({
      ...input,
      workDir: dir,
      artifactsDir: artifacts,
      ...repoTable(),
    });
    expect(r.arm).not.toBe('override');
    // A role with no cell never takes an override.
    const table = parseRoutingTable(TABLE);
    if (!table.ok) throw new Error('fixture');
    expect(
      findOverride([{ role: 'x', taskClass: '*', model: 'opus' }], table.table, 'x', 'bug'),
    ).toBeUndefined();
  });

  it('treats a missing or corrupt overrides file as empty', () => {
    mkdirSync(join(artifacts, '_routing'), { recursive: true });
    writeFileSync(overridesPath(artifacts), '{not json');
    const r = resolveModel({ ...input, workDir: dir, artifactsDir: artifacts, ...repoTable() });
    expect(r.arm).not.toBe('override');
  });
});

describe('assignment log', () => {
  it('appends one line per resolution with attribution only', () => {
    resolveModel({
      role: 'developer',
      taskClass: 'bug',
      taskId: 'SYN-1',
      iteration: 1,
      workDir: dir,
      artifactsDir: artifacts,
      now: () => new Date('2026-01-01T00:00:00Z'),
      ...repoTable(),
    });
    resolveModel({
      role: 'security-reviewer',
      taskId: 'SYN-1',
      workDir: dir,
      artifactsDir: artifacts,
      ...noTable,
    });
    const lines = readFileSync(assignmentLogPath(artifacts), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const rec = JSON.parse(lines[0]);
    expect(Object.keys(rec).sort()).toEqual(
      ['arm', 'iteration', 'model', 'reason', 'role', 'taskClass', 'taskId', 'ts'].sort(),
    );
    expect(rec).toMatchObject({
      taskId: 'SYN-1',
      role: 'developer',
      arm: 'table',
      model: 'sonnet',
    });
  });

  it('does not log without a task id or when record is false', () => {
    resolveModel({ role: 'developer', workDir: dir, artifactsDir: artifacts, ...noTable });
    resolveModel({
      role: 'developer',
      taskId: 'SYN-1',
      record: false,
      workDir: dir,
      artifactsDir: artifacts,
      ...noTable,
    });
    expect(() => readFileSync(assignmentLogPath(artifacts))).toThrow();
  });

  it('an unwritable log does not change the returned model', () => {
    const good = resolveModel({
      role: 'developer',
      taskClass: 'bug',
      taskId: 'SYN-1',
      workDir: dir,
      artifactsDir: join(dir, 'ok'),
      ...repoTable(),
    });
    // Artifacts path is a regular file, so mkdir/append must fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const bad = resolveModel({
      role: 'developer',
      taskClass: 'bug',
      taskId: 'SYN-1',
      workDir: dir,
      artifactsDir: blocker,
      ...repoTable(),
    });
    expect(bad).toEqual(good);
    // Nothing was created under the unwritable path, and the capability report was swallowed.
    expect(readFileSync(blocker, 'utf8')).toBe('x');
    expect(existsSync(join(blocker, '_routing', 'assignments.jsonl'))).toBe(false);
    expect(existsSync(join(blocker, '_capabilities'))).toBe(false);
  });

  it('reports the routing.table capability live or degraded without altering the result', () => {
    resolveModel({
      role: 'developer',
      taskClass: 'bug',
      taskId: 'SYN-1',
      workDir: dir,
      artifactsDir: artifacts,
      ...repoTable(),
    });
    resolveModel({
      role: 'developer',
      taskId: 'SYN-2',
      workDir: dir,
      artifactsDir: artifacts,
      ...noTable,
    });
    const state = JSON.parse(
      readFileSync(join(artifacts, '_capabilities', 'state.json'), 'utf8'),
    ) as {
      capabilities: Record<
        string,
        { counts: Record<string, number>; lastDegradedReason?: string; unregistered?: boolean }
      >;
    };
    const rec = state.capabilities['routing.table'];
    expect(rec.counts.live).toBe(1);
    expect(rec.counts.degraded).toBe(1);
    expect(rec.lastDegradedReason).toBe('default-table');
    expect(rec.unregistered).toBeUndefined();
  });
});

describe('taskClassOf', () => {
  it('reads the recorded class and defaults to uncategorized', () => {
    expect(taskClassOf('---\nid: X\nclass: bug\n---\nbody')).toBe('bug');
    expect(taskClassOf("---\nclass: 'Chore'\n---\n")).toBe('chore');
    expect(taskClassOf('---\nclass: nonsense\n---\n')).toBe('uncategorized');
    expect(taskClassOf('---\nid: X\n---\n')).toBe('uncategorized');
    expect(taskClassOf('no frontmatter')).toBe('uncategorized');
    expect(taskClassOf(undefined)).toBe('uncategorized');
  });
});
