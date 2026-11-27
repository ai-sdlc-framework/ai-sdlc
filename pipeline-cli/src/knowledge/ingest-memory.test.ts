import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDream } from '../memory-dream/apply.js';
import { metaPathFor } from '../memory-dream/run.js';
import { readMemoryFolder, serializeNote } from '../memory-dream/notes.js';
import { parseEntryFile } from './entry.js';
import {
  ingestMemoryForProject,
  memoryEntryId,
  MEMORY_TRUNK,
  reingestAfterSwap,
} from './ingest-memory.js';
import {
  KnowledgeBackendError,
  registerKnowledgeBackend,
  type KnowledgeStore,
  type StoredEntry,
} from './knowledge-store.js';
import { readLedger } from './retrieval/ledger.js';
import { queryIndex, rebuildIndex, recordHarnessRecall } from './retrieval/service.js';
import { checkKnowledgeScope } from './scope-check.js';
import { findProtectedCitations, validateKnowledge } from './store.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
let mem: string;
const protectedMem = (): string => join(dir, '.ai-sdlc/knowledge-protected/memory');

function note(file: string, type: string, body = 'banana smoothie preference'): void {
  writeFileSync(
    join(mem, file),
    serializeNote({ name: file.replace('.md', ''), description: `about ${file}`, type, body }),
  );
}

function entry(file: string): Record<string, unknown> {
  const p = parseEntryFile(
    readFileSync(join(protectedMem(), `${memoryEntryId(file)}.md`), 'utf-8'),
  );
  if (!('fields' in p)) throw new Error('unparseable');
  return p.fields;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ingest-memory-'));
  mem = join(dir, '.claude/memory');
  mkdirSync(mem, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.ai-sdlc/knowledge-protected/\n.claude/memory/\n');
  note('user_role.md', 'user');
  note('feedback_rule.md', 'feedback');
  note('project_x.md', 'project');
  note('reference_y.md', 'reference');
  writeFileSync(join(mem, 'MEMORY.md'), '- [a](user_role.md) — a\n');
});
afterEach(() => removeFixtureDir(dir));

describe('ingestMemoryForProject', () => {
  it('turns every note into a protected memory entry cited to the note file', async () => {
    const r = await ingestMemoryForProject(dir, mem, '2026-10-29');
    expect(r.created).toBe(4);
    for (const f of ['user_role.md', 'feedback_rule.md', 'project_x.md', 'reference_y.md']) {
      const e = entry(f);
      expect(e.trunk).toBe('memory');
      expect(e.scope).toBe('protected');
      expect(e.source).toBe(`.claude/memory/${f}`);
    }
    expect(validateKnowledge(dir).errors).toEqual([]);
    expect((await ingestMemoryForProject(dir, mem, '2026-10-29')).unchanged).toBe(4);
  });

  it.each([
    ['user_role.md', 'specialist', 'operator'],
    ['feedback_rule.md', 'specialist', 'operator'],
    ['project_x.md', 'inferred', undefined],
    ['reference_y.md', 'inferred', undefined],
  ])('maps %s to %s', async (file, authority, proof) => {
    await ingestMemoryForProject(dir, mem, '2026-10-29');
    const e = entry(file);
    expect(e.authority).toBe(authority);
    expect(e.proof).toBe(proof);
  });

  it('updates a changed note with supersedes and skips invalid notes', async () => {
    await ingestMemoryForProject(dir, mem, '2026-10-29');
    note('user_role.md', 'user', 'changed body');
    writeFileSync(join(mem, 'broken.md'), 'no frontmatter');
    const r = await ingestMemoryForProject(dir, mem, '2026-10-30');
    expect(r.updated).toBe(1);
    expect(r.skipped).toBe(1);
    expect(String(entry('user_role.md').supersedes)).toContain('memory-user-role@');
  });

  it('re-ingests under the dream lock after a swap and supersedes removed notes', async () => {
    await ingestMemoryForProject(dir, mem, '2026-10-29');
    const out = join(dir, '.claude/memory.dream-out');
    mkdirSync(out);
    for (const f of ['user_role.md', 'feedback_rule.md', 'reference_y.md']) {
      writeFileSync(join(out, f), readFileSync(join(mem, f)));
    }
    writeFileSync(join(out, 'MEMORY.md'), '');
    const snapshot = Object.fromEntries(readMemoryFolder(mem).notes.map((n) => [n.file, n.hash]));
    writeFileSync(metaPathFor(out), JSON.stringify({ inputDir: mem, snapshot }));
    let lockSeen = false;
    await applyDream({
      outputDir: out,
      afterSwap: (live) => {
        lockSeen = existsSync(`${live}.dream.lock`);
        return reingestAfterSwap(dir)(live);
      },
    });
    expect(lockSeen).toBe(true);
    expect(entry('project_x.md').status).toBe('superseded');
    expect(entry('user_role.md').status).toBeUndefined();
  });

  it('does not re-ingest when the memory trunk was never created', async () => {
    await reingestAfterSwap(dir)(mem);
    expect(existsSync(protectedMem())).toBe(false);
  });
});

describe('ledger and scope', () => {
  it('marks harness-recalled notes loaded so the engine does not inject them again', async () => {
    await ingestMemoryForProject(dir, mem, '2026-10-29');
    await rebuildIndex(dir);
    expect(recordHarnessRecall(dir, 's1', mem, ['user_role.md'])).toBe(1);
    expect(recordHarnessRecall(dir, 's1', mem, ['user_role.md'])).toBe(0);
    expect(readLedger(dir, 's1').some((r) => r.moment === 'harness-recall')).toBe(true);
    const hits = await queryIndex(dir, { text: 'banana smoothie', sessionId: 's1' });
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain('memory-user-role');
    expect(ids).toContain('memory-project-x');
  });

  it('excludes superseded entries from the index', async () => {
    await ingestMemoryForProject(dir, mem, '2026-10-29');
    rmSync(join(mem, 'project_x.md'));
    await ingestMemoryForProject(dir, mem, '2026-10-30');
    await rebuildIndex(dir);
    const ids = (await queryIndex(dir, { text: 'banana smoothie' })).map((h) => h.id);
    expect(ids).not.toContain('memory-project-x');
    expect(ids).toContain('memory-user-role');
  });

  it('keeps memory out of the tracked root and flags citations in a PR body', async () => {
    await ingestMemoryForProject(dir, mem, '2026-10-29');
    expect(checkKnowledgeScope(dir)).toEqual([]);
    expect(existsSync(join(dir, '.ai-sdlc/knowledge/memory'))).toBe(false);
    expect(findProtectedCitations(dir, 'see memory-user-role for details')).toEqual([
      'memory-user-role',
    ]);
    expect(findProtectedCitations(dir, 'nothing here')).toEqual([]);
  });
});

/** An in-memory protected root, keyed by path, registered as a non-files backend (DEC-0427). */
function memoryStore(entries: Map<string, StoredEntry>): KnowledgeStore {
  const inTrunk = (trunk: string): StoredEntry[] =>
    [...entries.values()].filter((e) => e.path.startsWith(`${trunk}/`));
  return {
    kind: 'in-memory',
    get: (id, opts) =>
      (opts?.path
        ? entries.get(opts.path)
        : [...entries.values()].find((e) => e.fields.id === id)) ?? null,
    list: (scope) => (typeof scope === 'object' ? inTrunk(scope.trunk) : [...entries.values()]),
    listRaw: () => [],
    create: (entry, opts) => {
      const id = String(entry.fields.id);
      const path = opts.path ?? `${String(entry.fields.trunk)}/${id}.md`;
      entries.set(path, { ...entry, scope: opts.scope, path });
      return Promise.resolve({ id, path, created: true, status: 'applied' });
    },
    write: (id, op) => {
      const e = [...entries.values()].find((x) => x.fields.id === id);
      if (!e || op.kind !== 'reingest') throw new Error(`unexpected write ${op.kind} ${id}`);
      entries.set(e.path, { ...e, fields: op.fields, body: op.body ?? e.body });
      return Promise.resolve({ id, path: e.path, created: false, status: 'applied' });
    },
  };
}

const stored = (id: string): StoredEntry => ({
  fields: { id, trunk: MEMORY_TRUNK, contentHash: 'old', source: '.claude/memory/old.md' },
  body: '\nold\n',
  scope: 'protected',
  path: `${MEMORY_TRUNK}/${id}.md`,
});

function useBackend(name: string, backendModule?: string): void {
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  const mod = backendModule ? `\n  backendModule: ${backendModule}` : '';
  writeFileSync(join(dir, '.ai-sdlc/context.yaml'), `knowledge:\n  backend: ${name}${mod}\n`);
}

describe('reingestAfterSwap on a non-files backend (AISDLC-1426)', () => {
  const entries = new Map<string, StoredEntry>();
  registerKnowledgeBackend('in-memory-1426', () => memoryStore(entries));
  beforeEach(() => entries.clear());

  it('re-ingests through the backend when it holds memory entries and no folder exists', async () => {
    useBackend('in-memory-1426');
    entries.set(`${MEMORY_TRUNK}/memory-old.md`, stored('memory-old'));
    await reingestAfterSwap(dir)(mem);
    expect(existsSync(protectedMem())).toBe(false);
    expect(entries.get(`${MEMORY_TRUNK}/memory-user-role.md`)?.fields.authority).toBe('specialist');
    expect(entries.size).toBe(5);
    expect(entries.get(`${MEMORY_TRUNK}/memory-old.md`)?.fields.status).toBe('superseded');
  });

  it('sets exit code 1 when the backend rejects a re-ingest write', async () => {
    registerKnowledgeBackend('rejecting-1456', () => ({
      ...memoryStore(entries),
      create: async (e) => ({
        id: String(e.fields.id),
        path: '',
        created: false,
        status: 'rejected',
        reason: 'read-only replica',
      }),
    }));
    useBackend('rejecting-1456');
    entries.set(`${MEMORY_TRUNK}/memory-old.md`, stored('memory-old'));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await reingestAfterSwap(dir)(mem);
      expect(process.exitCode).toBe(1);
    } finally {
      err.mockRestore();
      process.exitCode = 0;
    }
  });

  it('writes nothing when the backend holds no memory entries', async () => {
    useBackend('in-memory-1426');
    await reingestAfterSwap(dir)(mem);
    expect(entries.size).toBe(0);
  });

  it('throws KnowledgeBackendError for an unregistered backend', async () => {
    useBackend('unregistered-1426');
    await expect(reingestAfterSwap(dir)(mem)).rejects.toThrow(KnowledgeBackendError);
  });

  it('resolves backendModule from the project, not the working directory', async () => {
    const pkgDir = join(dir, 'node_modules/ai-sdlc-fixture-1426');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      '{"name":"ai-sdlc-fixture-1426","main":"index.js"}',
    );
    writeFileSync(
      join(pkgDir, 'index.js'),
      `exports.roots = [];\nexports.registerKnowledgeBackends = (r) => r.registerKnowledgeBackend('module-1426', (cfg, ctx) => { exports.roots.push(ctx.projectRoot); return { kind: 'module', get: () => null, list: () => [], listRaw: () => [], create: async (e) => ({ id: String(e.fields.id), path: 'x', created: true, status: 'applied' }), write: async (id) => ({ id, path: '', created: false, status: 'rejected', reason: 'unused' }) }; });\n`,
    );
    useBackend('module-1426', 'ai-sdlc-fixture-1426');
    expect(process.cwd()).not.toBe(dir);
    const r = await ingestMemoryForProject(dir, mem, '2026-11-26');
    expect(r.created).toBe(4);
    const req = createRequire(join(dir, 'package.json'));
    expect((req('ai-sdlc-fixture-1426') as { roots: string[] }).roots).toEqual([dir]);
  });
});
