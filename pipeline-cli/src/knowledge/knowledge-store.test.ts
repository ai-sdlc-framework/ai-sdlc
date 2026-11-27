import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesKnowledgeStore, openKnowledgeStore, type StoreScope } from './knowledge-store.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-store-'));
});
afterEach(() => removeFixtureDir(root));

const ROOTS = {
  backend: 'files',
  trackedRoot: '.ai-sdlc/knowledge',
  protectedRoot: '.ai-sdlc/knowledge-protected',
};
const P = 'agent:task:AISDLC-1456';
const fields = (id: string, trunk = 'systems'): Record<string, unknown> => ({
  id,
  trunk,
  value: `value of ${id}`,
  confidence: 0.5,
});

describe('openKnowledgeStore', () => {
  it('returns the files implementation unconditionally', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    expect(store).toBeInstanceOf(FilesKnowledgeStore);
    expect(store.kind).toBe('files');
  });
});

describe.each<[StoreScope, string]>([
  ['tracked', '.ai-sdlc/knowledge'],
  ['protected', '.ai-sdlc/knowledge-protected'],
])('FilesKnowledgeStore on the %s root', (scope, dir) => {
  it('create writes <trunk>/<id>.md, then rejects a second create', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    expect(
      await store.create({ fields: fields('a'), body: '\nbody\n' }, { scope, principal: P }),
    ).toEqual({
      id: 'a',
      path: join('systems', 'a.md'),
      created: true,
      status: 'applied',
    });
    const text = readFileSync(join(root, dir, 'systems/a.md'), 'utf-8');
    expect(text).toBe(
      '---\nid: a\ntrunk: systems\nvalue: value of a\nconfidence: 0.5\n---\n\nbody\n',
    );
    expect(
      (await store.create({ fields: fields('a'), body: '' }, { scope, principal: P })).status,
    ).toBe('rejected');
  });

  it('create honours an explicit path', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    expect(
      (
        await store.create(
          { fields: fields('x'), body: 'B\n' },
          { scope, path: 'x.md', principal: P },
        )
      ).path,
    ).toBe('x.md');
    expect(readFileSync(join(root, dir, 'x.md'), 'utf-8')).toContain('id: x');
  });

  it('get returns fields, body, scope and path; null for a missing id', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    await store.create(
      { fields: fields('a', 'process'), body: '\nhello\n' },
      { scope, principal: P },
    );
    expect(store.get('a', { scope })).toEqual({
      fields: fields('a', 'process'),
      body: '\nhello\n',
      scope,
      path: join('process', 'a.md'),
    });
    expect(store.get('a')?.scope).toBe(scope);
    expect(store.get('missing', { scope })).toBeNull();
    expect(store.get('missing')).toBeNull();
  });

  it('get by path reads that location; null when missing or unparseable', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    await store.create({ fields: fields('a'), body: '' }, { scope, principal: P });
    expect(store.get('a', { scope, path: join('systems', 'a.md') })?.fields.id).toBe('a');
    expect(store.get('a', { scope, path: 'nope.md' })).toBeNull();
    mkdirSync(join(root, dir, 'bad'), { recursive: true });
    writeFileSync(join(root, dir, 'bad/b.md'), 'no frontmatter');
    expect(store.get('b', { scope, path: 'bad/b.md' })).toBeNull();
    expect(() => store.get('a', { path: 'x.md' })).toThrow(/requires a scope/);
  });

  it('write edits in place and keeps the body; rejected for a missing id', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    await store.create({ fields: fields('a'), body: '\nkeep\n' }, { scope, principal: P });
    const r = await store.write('a', {
      kind: 'confirm',
      fields: { confidence: 0.9 },
      principal: P,
    });
    expect(r.status).toBe('applied');
    expect(store.get('a', { scope })).toMatchObject({
      fields: { ...fields('a'), confidence: 0.9 },
      body: '\nkeep\n',
    });
    expect(
      (await store.write('missing', { kind: 'confirm', fields: {}, principal: P }, { scope }))
        .status,
    ).toBe('rejected');
  });

  it('list returns parseable entries directly under a trunk', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    expect(store.list({ scope, trunk: 'memory' })).toEqual([]);
    await store.create({ fields: fields('m1', 'memory'), body: '' }, { scope, principal: P });
    writeFileSync(join(root, dir, 'memory/junk.md'), 'no frontmatter');
    writeFileSync(join(root, dir, 'memory/notes.txt'), 'x');
    expect(store.list({ scope, trunk: 'memory' }).map((e) => e.fields.id)).toEqual(['m1']);
  });
});

describe('FilesKnowledgeStore roots', () => {
  it('searches tracked before protected and only the configured roots', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    await store.create({ fields: fields('dup'), body: 'p' }, { scope: 'protected', principal: P });
    await store.create({ fields: fields('dup'), body: 't' }, { scope: 'tracked', principal: P });
    expect(store.get('dup')?.scope).toBe('tracked');
    const protectedOnly = openKnowledgeStore(
      { backend: 'files', protectedRoot: join(root, ROOTS.protectedRoot) },
      root,
    );
    expect(protectedOnly.get('dup')?.scope).toBe('protected');
    expect(() => protectedOnly.get('dup', { scope: 'tracked' })).toThrow(/no tracked root/);
  });
});

describe('FilesKnowledgeStore list(scope) and listRaw(scope)', () => {
  it('lists every entry of a root recursively in path order, skipping unparseable files', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    expect(store.list('tracked')).toEqual([]);
    await store.create(
      { fields: fields('b', 'systems'), body: '' },
      { scope: 'tracked', principal: P },
    );
    await store.create(
      { fields: fields('a', 'memory'), body: '' },
      { scope: 'tracked', principal: P },
    );
    await store.create({ fields: fields('p'), body: '' }, { scope: 'protected', principal: P });
    writeFileSync(join(root, ROOTS.trackedRoot, 'systems/junk.md'), 'no frontmatter');
    expect(store.list('tracked').map((e) => e.path)).toEqual(['memory/a.md', 'systems/b.md']);
    expect(store.list('protected').map((e) => e.fields.id)).toEqual(['p']);
    expect(store.list('all').map((e) => [e.scope, e.fields.id])).toEqual([
      ['tracked', 'a'],
      ['tracked', 'b'],
      ['protected', 'p'],
    ]);
  });

  it('listRaw reports the parse error of an unparseable file', async () => {
    const store = openKnowledgeStore(ROOTS, root);
    await store.create({ fields: fields('a'), body: '' }, { scope: 'tracked', principal: P });
    writeFileSync(join(root, ROOTS.trackedRoot, 'systems/junk.md'), 'no frontmatter');
    const raw = store.listRaw('all');
    expect(raw.map((r) => r.path)).toEqual(['systems/a.md', 'systems/junk.md']);
    expect(raw[1]!.parsed).toEqual({ error: 'missing YAML frontmatter' });
  });

  it('all covers only the configured roots', async () => {
    const tracked = join(root, ROOTS.trackedRoot);
    const store = openKnowledgeStore({ backend: 'files', trackedRoot: tracked }, root);
    await store.create({ fields: fields('a'), body: '' }, { scope: 'tracked', principal: P });
    expect(store.list('all').map((e) => e.fields.id)).toEqual(['a']);
    expect(() => store.listRaw('protected')).toThrow(/no protected root/);
  });
});
