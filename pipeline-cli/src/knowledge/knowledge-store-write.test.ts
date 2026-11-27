/** Named async writes on the files backend (AISDLC-1455, DEC-0443). */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openKnowledgeStore,
  WRITE_KINDS,
  type KnowledgeStore,
  type WriteKind,
} from './knowledge-store.js';
import { readKnowledgeLog } from './log.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let root: string;
let store: KnowledgeStore;
const TRACKED = '.ai-sdlc/knowledge';
const ROOTS = {
  backend: 'files',
  trackedRoot: TRACKED,
  protectedRoot: '.ai-sdlc/knowledge-protected',
};
const HUMAN = 'human:a@example.com';
const AGENT = 'agent:task:AISDLC-1';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-write-'));
  store = openKnowledgeStore(ROOTS, root);
});
afterEach(() => removeFixtureDir(root));

const log = () => readKnowledgeLog(join(root, TRACKED));
const fields = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  trunk: 'systems',
  value: `secret value of ${id}`,
  contentHash: `hash-of-${id}`,
  confidence: 0.5,
  authority: 'inferred',
  ...extra,
});

describe('WriteKind', () => {
  it('is the closed set of eight named operations', () => {
    expect([...WRITE_KINDS]).toEqual([
      'confirm',
      'correct',
      'supersede',
      'promote',
      'reobserve',
      'refute',
      'reingest',
      'excise',
    ]);
  });

  it('rejects a kind outside the set and logs nothing', async () => {
    await store.create({ fields: fields('a'), body: '' }, { scope: 'tracked', principal: HUMAN });
    const r = await store.write('a', {
      kind: 'delete' as WriteKind,
      fields: {},
      principal: HUMAN,
    });
    expect(r).toMatchObject({ status: 'rejected', reason: "unknown write kind 'delete'" });
    expect(log()).toHaveLength(1);
  });
});

describe('create', () => {
  it('writes the entry, logs one created event with the principal, and refuses a duplicate', async () => {
    const r = await store.create(
      { fields: fields('a'), body: '\nB\n' },
      { scope: 'tracked', principal: AGENT },
    );
    expect(r).toEqual({ id: 'a', path: join('systems', 'a.md'), created: true, status: 'applied' });
    expect(store.get('a')?.body).toBe('\nB\n');
    expect(log()).toEqual([
      expect.objectContaining({ event: 'created', id: 'a', by: 'agent', principal: AGENT }),
    ]);
    const dup = await store.create(
      { fields: fields('a'), body: '' },
      { scope: 'tracked', principal: AGENT },
    );
    expect(dup).toMatchObject({ status: 'rejected', created: false, path: '' });
    expect(log()).toHaveLength(1);
  });
});

describe('write', () => {
  beforeEach(async () => {
    await store.create(
      { fields: fields('a'), body: '\nbody\n' },
      { scope: 'tracked', principal: HUMAN },
    );
  });

  it.each<[WriteKind, Record<string, unknown>, string]>([
    ['confirm', {}, 'confirmed'],
    ['correct', { value: 'new', contentHash: 'h2' }, 'corrected'],
    ['reobserve', { confidence: 0.6 }, 'reobserved'],
    ['refute', { authority: 'inferred' }, 'refuted'],
    ['promote', { authority: 'specialist', proof: 'test:x' }, 'promoted'],
    ['reingest', fields('a', { value: 'fresh' }), 'reingested'],
  ])('%s appends exactly one %s event with its principal', async (kind, f, event) => {
    const r = await store.write('a', { kind, fields: f, principal: HUMAN });
    expect(r).toEqual({
      id: 'a',
      path: join('systems', 'a.md'),
      created: false,
      status: 'applied',
    });
    const events = log().slice(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event, id: 'a', by: 'human', principal: HUMAN });
    const after = store.get('a')!;
    for (const [k, v] of Object.entries(f)) expect(after.fields[k]).toEqual(v);
    expect(after.body).toBe('\nbody\n');
  });

  it('confirm with no fields still logs', async () => {
    await store.write('a', { kind: 'confirm', fields: {}, principal: AGENT });
    expect(log().slice(1)).toEqual([
      expect.objectContaining({ event: 'confirmed', detail: 'no fields changed', by: 'agent' }),
    ]);
  });

  it('promote records from, to and proof', async () => {
    await store.write('a', {
      kind: 'promote',
      fields: { authority: 'specialist', proof: 'test:x' },
      principal: HUMAN,
    });
    expect(log()[1]).toMatchObject({ from: 'inferred', to: 'specialist', proof: 'test:x' });
  });

  it.each([{ authority: 'specialist' }, { proof: 'test:x' }, {}])(
    'promote without target authority and proof is rejected (%o)',
    async (f) => {
      const r = await store.write('a', { kind: 'promote', fields: f, principal: HUMAN });
      expect(r).toMatchObject({ status: 'rejected', created: false });
      expect(r.reason).toMatch(/authority and the proof/);
      expect(store.get('a')!.fields.authority).toBe('inferred');
      expect(log()).toHaveLength(1);
    },
  );

  it('excise is rejected with a reason on files', async () => {
    const r = await store.write('a', { kind: 'excise', fields: {}, principal: HUMAN });
    expect(r).toEqual({
      id: 'a',
      path: '',
      created: false,
      status: 'rejected',
      reason: 'the files backend does not support excise',
    });
    expect(store.get('a')).not.toBeNull();
  });

  it('a missing entry is rejected', async () => {
    const r = await store.write('nope', { kind: 'confirm', fields: {}, principal: HUMAN });
    expect(r).toMatchObject({ status: 'rejected', reason: "entry 'nope' not found" });
  });

  it('reingest replaces the body when given one', async () => {
    await store.write('a', {
      kind: 'reingest',
      fields: fields('a'),
      body: '\nnew\n',
      principal: AGENT,
    });
    expect(store.get('a')!.body).toBe('\nnew\n');
  });
});

describe('supersede is one call', () => {
  beforeEach(async () => {
    await store.create(
      { fields: fields('old'), body: '\nold\n' },
      { scope: 'tracked', principal: HUMAN },
    );
  });

  it('creates the new entry, marks the old one, and returns the new id and path', async () => {
    const r = await store.write('old', {
      kind: 'supersede',
      fields: fields('new', { relations: [{ type: 'relates', target: 'x' }] }),
      body: '\nnew\n',
      principal: HUMAN,
    });
    expect(r).toEqual({
      id: 'new',
      path: join('systems', 'new.md'),
      created: true,
      status: 'applied',
    });
    const created = store.get('new')!;
    expect(created.fields.supersedes).toBe('old');
    expect(created.fields.relations).toEqual([
      { type: 'relates', target: 'x' },
      { type: 'supersedes', target: 'old' },
    ]);
    expect(created.body).toBe('\nnew\n');
    expect(store.get('old')!.fields.status).toBe('superseded');
    expect(store.get('old')!.body).toBe('\nold\n');
    expect(log().slice(1)).toEqual([
      expect.objectContaining({ event: 'superseded', id: 'old', to: 'new', principal: HUMAN }),
    ]);
  });

  it.each([
    [{ trunk: 'systems' }, 'supersede requires the new entry id'],
    [{ id: 'old', trunk: 'systems' }, 'an entry cannot supersede itself'],
    [{ id: 'new' }, 'supersede requires the new trunk'],
    [{ id: 'old2', trunk: 'systems' }, undefined],
  ])('rejects bad new fields (%o)', async (f, reason) => {
    if (reason === undefined) {
      await store.create(
        { fields: fields('old2'), body: '' },
        { scope: 'tracked', principal: HUMAN },
      );
      const r = await store.write('old', { kind: 'supersede', fields: f, principal: HUMAN });
      expect(r.reason).toMatch(/exists/);
      return;
    }
    const r = await store.write('old', { kind: 'supersede', fields: f, principal: HUMAN });
    expect(r).toMatchObject({ status: 'rejected', reason });
  });
});

describe('protected entries', () => {
  it('log no value and no hash for any write', async () => {
    await store.create(
      { fields: fields('p', { scope: 'protected' }), body: '' },
      { scope: 'protected', principal: HUMAN },
    );
    await store.create(
      { fields: fields('t', { scope: 'protected' }), body: '' },
      { scope: 'tracked', principal: HUMAN },
    );
    await store.write('p', {
      kind: 'correct',
      fields: { value: 'the new secret', contentHash: 'secret-hash' },
      principal: HUMAN,
    });
    await store.write('t', { kind: 'confirm', fields: { confidence: 0.7 }, principal: HUMAN });
    await store.write('p', {
      kind: 'supersede',
      fields: fields('p2', { scope: 'protected', value: 'newer secret' }),
      principal: HUMAN,
    });
    const text = readFileSync(join(root, '.ai-sdlc/knowledge-log.jsonl'), 'utf-8');
    expect(text.trim().split('\n')).toHaveLength(5);
    for (const leak of [
      'secret value of',
      'hash-of-',
      'the new secret',
      'secret-hash',
      'newer secret',
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(log()[2].detail).toContain('protected; values not logged');
    expect(log()[0].detail).toBe('protected entry created');
  });
});
