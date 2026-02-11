import { describe, it, expect } from 'vitest';
import { createInMemoryMemoryStore } from './memory-store.js';

describe('InMemoryMemoryStore', () => {
  it('writes and reads a value', async () => {
    const store = createInMemoryMemoryStore();
    await store.write('key-1', { data: 'hello' });
    const result = await store.read('key-1');
    expect(result).toEqual({ data: 'hello' });
  });

  it('returns undefined for missing keys', async () => {
    const store = createInMemoryMemoryStore();
    const result = await store.read('nonexistent');
    expect(result).toBeUndefined();
  });

  it('overwrites existing values', async () => {
    const store = createInMemoryMemoryStore();
    await store.write('key-1', 'first');
    await store.write('key-1', 'second');
    expect(await store.read('key-1')).toBe('second');
    expect(store.size()).toBe(1);
  });

  it('deletes a value', async () => {
    const store = createInMemoryMemoryStore();
    await store.write('key-1', 'value');
    await store.delete('key-1');
    expect(await store.read('key-1')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('lists all keys', async () => {
    const store = createInMemoryMemoryStore();
    await store.write('agent:memory:1', 'a');
    await store.write('agent:memory:2', 'b');
    await store.write('config:setting', 'c');
    const keys = await store.list();
    expect(keys).toHaveLength(3);
    expect(keys).toContain('agent:memory:1');
    expect(keys).toContain('config:setting');
  });

  it('lists keys with prefix filter', async () => {
    const store = createInMemoryMemoryStore();
    await store.write('agent:memory:1', 'a');
    await store.write('agent:memory:2', 'b');
    await store.write('config:setting', 'c');
    const keys = await store.list('agent:');
    expect(keys).toHaveLength(2);
    expect(keys).toContain('agent:memory:1');
    expect(keys).toContain('agent:memory:2');
  });

  it('tracks size correctly', async () => {
    const store = createInMemoryMemoryStore();
    expect(store.size()).toBe(0);
    await store.write('a', 1);
    await store.write('b', 2);
    expect(store.size()).toBe(2);
    await store.delete('a');
    expect(store.size()).toBe(1);
  });

  it('handles various value types', async () => {
    const store = createInMemoryMemoryStore();
    await store.write('string', 'hello');
    await store.write('number', 42);
    await store.write('array', [1, 2, 3]);
    await store.write('null', null);
    expect(await store.read('string')).toBe('hello');
    expect(await store.read('number')).toBe(42);
    expect(await store.read('array')).toEqual([1, 2, 3]);
    expect(await store.read('null')).toBeNull();
  });
});
