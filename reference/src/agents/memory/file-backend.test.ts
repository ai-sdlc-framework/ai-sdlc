import { describe, it, expect, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFileLongTermMemory, createFileEpisodicMemory } from './file-backend.js';

const testDir = join(import.meta.dirname ?? '.', '..', '..', '..', '.test-tmp');
const ltmFile = join(testDir, 'ltm-test.json');
const episodicFile = join(testDir, 'episodic-test.json');

function cleanup() {
  for (const f of [ltmFile, episodicFile]) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {
      // ignore
    }
  }
}

afterEach(cleanup);

describe('createFileLongTermMemory', () => {
  it('stores and retrieves entries', () => {
    const mem = createFileLongTermMemory(ltmFile);

    mem.set('ts', 'TypeScript is great', { category: 'language' });
    mem.set('py', 'Python is also great', { category: 'language' });

    expect(mem.get('ts')).toBe('TypeScript is great');
    expect(mem.get('py')).toBe('Python is also great');
    expect(mem.keys()).toHaveLength(2);
  });

  it('persists across instances', () => {
    const mem1 = createFileLongTermMemory(ltmFile);
    mem1.set('persistent', { data: 'Persistent entry' });

    // Create new instance pointing to same file
    const mem2 = createFileLongTermMemory(ltmFile);
    expect(mem2.get('persistent')).toEqual({ data: 'Persistent entry' });
    expect(mem2.keys()).toHaveLength(1);
  });

  it('searches by prefix', () => {
    const mem = createFileLongTermMemory(ltmFile);
    mem.set('lang.ts', 'TypeScript');
    mem.set('lang.py', 'Python');
    mem.set('tool.vite', 'Vite');

    const results = mem.search('lang.');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key)).toContain('lang.ts');
    expect(results.map((r) => r.key)).toContain('lang.py');
  });

  it('deletes entries', () => {
    const mem = createFileLongTermMemory(ltmFile);
    mem.set('key1', 'value1');
    mem.set('key2', 'value2');

    expect(mem.delete('key1')).toBe(true);
    expect(mem.get('key1')).toBeUndefined();
    expect(mem.delete('nonexistent')).toBe(false);
    expect(mem.keys()).toHaveLength(1);
  });

  it('returns undefined for non-existent keys', () => {
    const mem = createFileLongTermMemory(ltmFile);
    expect(mem.get('missing')).toBeUndefined();
  });

  it('returns empty keys for non-existent file', () => {
    const mem = createFileLongTermMemory(ltmFile);
    expect(mem.keys()).toEqual([]);
  });
});

describe('createFileEpisodicMemory', () => {
  it('appends and retrieves events', () => {
    const mem = createFileEpisodicMemory(episodicFile);

    const e1 = mem.append({ key: 'step', value: 'Read file' });
    const e2 = mem.append({ key: 'step', value: 'Modify file' });

    expect(e1.tier).toBe('episodic');
    expect(e2.key).toBe('step');

    const recent = mem.recent(10);
    expect(recent).toHaveLength(2);
  });

  it('returns recent entries with limit', () => {
    const mem = createFileEpisodicMemory(episodicFile);

    mem.append({ key: 'a', value: 1 });
    mem.append({ key: 'b', value: 2 });
    mem.append({ key: 'c', value: 3 });

    const recent = mem.recent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].key).toBe('b');
    expect(recent[1].key).toBe('c');
  });

  it('searches by key', () => {
    const mem = createFileEpisodicMemory(episodicFile);

    mem.append({ key: 'step', value: 'Step 1' });
    mem.append({ key: 'error', value: 'Error occurred' });
    mem.append({ key: 'step', value: 'Step 2' });

    const results = mem.search('step');
    expect(results).toHaveLength(2);
  });

  it('persists across instances', () => {
    const mem1 = createFileEpisodicMemory(episodicFile);
    mem1.append({ key: 'persist', value: 'Persistent event' });

    const mem2 = createFileEpisodicMemory(episodicFile);
    const recent = mem2.recent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].value).toBe('Persistent event');
  });

  it('returns empty for non-existent file', () => {
    const mem = createFileEpisodicMemory(episodicFile);
    expect(mem.recent(10)).toEqual([]);
    expect(mem.search('anything')).toEqual([]);
  });
});
