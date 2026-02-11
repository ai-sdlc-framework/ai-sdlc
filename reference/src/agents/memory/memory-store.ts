/**
 * In-memory MemoryStore implementation for testing.
 * Provides a Map-backed key-value store implementing the MemoryStore interface.
 */

import type { MemoryStore } from './types.js';

export interface InMemoryMemoryStore extends MemoryStore {
  /** Get the count of stored entries (for testing). */
  size(): number;
}

/**
 * Create an in-memory MemoryStore backed by a Map.
 */
export function createInMemoryMemoryStore(): InMemoryMemoryStore {
  const store = new Map<string, unknown>();

  return {
    async read(key: string): Promise<unknown | undefined> {
      return store.get(key);
    },

    async write(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },

    async delete(key: string): Promise<void> {
      store.delete(key);
    },

    async list(prefix?: string): Promise<string[]> {
      const keys = Array.from(store.keys());
      if (!prefix) return keys;
      return keys.filter((k) => k.startsWith(prefix));
    },

    size(): number {
      return store.size;
    },
  };
}
