import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKnowledgeConfig } from './config.js';
import {
  captureFact,
  captureFactForProject,
  classifyDocument,
  exportableEntries,
  readDataRoomEntries,
} from './data-room.js';
import { parseEntryFile, toEntry, validateEntryFields } from './entry.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { rebuildIndex, queryIndex } from './retrieval/service.js';
import { openKnowledgeStore } from './knowledge-store.js';
import { ingestMemoryForProject } from './ingest-memory.js';
import { validateKnowledge } from './store.js';
import { serializeNote } from '../memory-dream/notes.js';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));
const mk = () => (root = mkdtempSync(join(tmpdir(), 'dataroom-')));
const AGENT = 'agent:task:AISDLC-1456';

describe('dataRoomRoot config', () => {
  it('is unset by default and read from context.yaml', () => {
    mk();
    expect(loadKnowledgeConfig(root).dataRoomRoot).toBeNull();
    mkdirSync(join(root, '.ai-sdlc'));
    writeFileSync(join(root, '.ai-sdlc/context.yaml'), 'knowledge:\n  dataRoomRoot: ../room\n');
    expect(loadKnowledgeConfig(root).dataRoomRoot).toBe('../room');
  });
});

describe('authority by document kind', () => {
  it.each([
    ['msa-signed.md', 'signed', 'canonical', 0.95],
    ['q3-plan.md', 'plan', 'specialist', 0.85],
    ['investor-deck.md', 'deck', 'specialist', 0.7],
    ['notes.md', 'document', 'specialist', 0.7],
  ])('%s', (name, kind, authority, confidence) => {
    expect(classifyDocument(name)).toEqual({ kind, authority, confidence });
  });
});

describe('indexing', () => {
  it('indexes documents read-only at scope protected and never writes the room', async () => {
    mk();
    const room = join(root, 'room');
    mkdirSync(room);
    writeFileSync(join(room, 'msa-signed.md'), 'Acme pays net thirty days');
    writeFileSync(join(room, 'binary.bin'), 'x');
    mkdirSync(join(root, '.ai-sdlc'));
    writeFileSync(join(root, '.ai-sdlc/context.yaml'), 'knowledge:\n  dataRoomRoot: room\n');
    const entries = readDataRoomEntries(room);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scope: 'protected',
      authority: 'canonical',
      confidence: 0.95,
    });
    expect(entries[0].source).toBe('data-room:msa-signed.md');
    expect(validateEntryFields({ ...entries[0] }, DEFAULT_ONTOLOGY)).toEqual([]);

    const listing = () => JSON.stringify([readdirRec(room)]);
    const before = listing();
    const mtime = readFileSync(join(room, 'msa-signed.md'), 'utf-8');
    expect(await rebuildIndex(root)).toBe(1);
    const hits = await queryIndex(root, { text: 'net thirty days' });
    expect(hits[0]?.citations).toEqual(['data-room:msa-signed.md']);
    expect(listing()).toBe(before);
    expect(readFileSync(join(room, 'msa-signed.md'), 'utf-8')).toBe(mtime);
  });
});

function readdirRec(d: string): string[] {
  return readDataRoomEntries(d).map((e) => e.source);
}

describe('capture and export', () => {
  it('writes a protected entry with a citation in the protected root', async () => {
    mk();
    const prot = join(root, 'prot');
    const input = {
      id: 'fact-1',
      value: 'Payment is net 30',
      sourceDoc: 'msa-signed.md',
      observed: '2026-11-01',
      principal: AGENT,
    };
    const roots = { trackedRootAbs: join(root, 'kb'), protectedRootAbs: prot };
    const { file, status } = await captureFact({ backend: 'files' }, roots, input, root);
    expect(status).toBe('applied');
    // a second capture of the same id is rejected, never an overwrite
    expect(await captureFact({ backend: 'files' }, roots, input, root)).toMatchObject({
      status: 'rejected',
      file: '',
    });
    const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
    if (!('fields' in parsed)) throw new Error('parse');
    expect(validateEntryFields(parsed.fields, DEFAULT_ONTOLOGY)).toEqual([]);
    const e = toEntry(parsed.fields, parsed.body);
    expect(e.scope).toBe('protected');
    expect(e.source).toBe('data-room:msa-signed.md');
    expect(
      openKnowledgeStore({ backend: 'files', protectedRoot: prot }, root).list('protected'),
    ).toHaveLength(1);
  });

  it('writes <protectedRoot>/<trunk>/<id>.md through the CLI path and passes validate (AISDLC-1425)', async () => {
    mk();
    const { file } = await captureFactForProject(root, {
      id: 'fact-1',
      value: 'Payment is net 30',
      sourceDoc: 'msa-signed.md',
      observed: '2026-11-01',
      principal: AGENT,
    });
    expect(file).toBe(join(root, '.ai-sdlc/knowledge-protected/memory/fact-1.md'));
    expect(readFileSync(file, 'utf-8')).toContain('source: data-room:msa-signed.md');
    expect(validateKnowledge(root).errors).toEqual([]);
  });

  it('survives a memory re-ingest that supersedes notes gone from the folder (AISDLC-1425)', async () => {
    mk();
    const mem = join(root, '.claude/memory');
    mkdirSync(mem, { recursive: true });
    const note = (f: string): void =>
      writeFileSync(
        join(mem, f),
        serializeNote({ name: f, description: 'd', type: 'user', body: 'banana smoothie' }),
      );
    note('user_role.md');
    note('user_gone.md');
    await ingestMemoryForProject(root, mem, '2026-11-01', AGENT);
    await captureFactForProject(root, {
      id: 'fact-1',
      value: 'Payment is net 30',
      sourceDoc: 'msa-signed.md',
      observed: '2026-11-01',
      principal: AGENT,
    });
    rmSync(join(mem, 'user_gone.md'));
    const r = await ingestMemoryForProject(root, mem, '2026-11-02', AGENT);
    expect(r.superseded).toBe(1);
    const store = openKnowledgeStore(
      { backend: 'files', protectedRoot: join(root, '.ai-sdlc/knowledge-protected') },
      root,
    );
    const byStatus = Object.fromEntries(
      store
        .list({ scope: 'protected', trunk: 'memory' })
        .map((e) => [String(e.fields.source), e.fields.status]),
    );
    expect(byStatus['data-room:msa-signed.md']).toBeUndefined();
    expect(byStatus['.claude/memory/user_gone.md']).toBe('superseded');
    expect(byStatus['.claude/memory/user_role.md']).toBeUndefined();
    expect(validateKnowledge(root).errors).toEqual([]);
  });

  it('export excludes the protected partition by scope', () => {
    const out = exportableEntries([
      { id: 'a', scope: 'internal' },
      { id: 'b', scope: 'protected' },
      { id: 'c', scope: ' Protected ' },
      { id: 'd', scope: 'universal' },
    ]);
    expect(out.map((e) => e.id)).toEqual(['a', 'd']);
  });
});
