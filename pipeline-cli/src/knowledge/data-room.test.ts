import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKnowledgeConfig } from './config.js';
import {
  captureFact,
  classifyDocument,
  exportableEntries,
  readDataRoomEntries,
} from './data-room.js';
import { parseEntryFile, toEntry, validateEntryFields } from './entry.js';
import { DEFAULT_ONTOLOGY } from './ontology.js';
import { rebuildIndex, queryIndex } from './retrieval/service.js';
import { readEntries } from './store.js';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));
const mk = () => (root = mkdtempSync(join(tmpdir(), 'dataroom-')));

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
  it('writes a protected entry with a citation in the protected root', () => {
    mk();
    const prot = join(root, 'prot');
    const file = captureFact(prot, {
      id: 'fact-1',
      value: 'Payment is net 30',
      sourceDoc: 'msa-signed.md',
      observed: '2026-11-01',
    });
    const parsed = parseEntryFile(readFileSync(file, 'utf-8'));
    if (!('fields' in parsed)) throw new Error('parse');
    expect(validateEntryFields(parsed.fields, DEFAULT_ONTOLOGY)).toEqual([]);
    const e = toEntry(parsed.fields, parsed.body);
    expect(e.scope).toBe('protected');
    expect(e.source).toBe('data-room:msa-signed.md');
    expect(readEntries(prot)).toHaveLength(1);
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
