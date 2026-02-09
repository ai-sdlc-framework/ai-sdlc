/**
 * JSON file-based persistent memory backend.
 * Stores long-term and episodic memory tiers to disk.
 * Working and short-term memory remain in-memory by design.
 * <!-- Source: PRD Section 13 -->
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import type { MemoryEntry, LongTermMemory, EpisodicMemory } from './types.js';

interface FileMemoryStore {
  entries: Record<string, MemoryEntry>;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadStore(filePath: string): FileMemoryStore {
  if (!existsSync(filePath)) return { entries: {} };
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as FileMemoryStore;
}

function saveStore(filePath: string, store: FileMemoryStore): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Create a file-backed long-term memory store.
 * Entries persist across process restarts.
 */
export function createFileLongTermMemory(filePath: string): LongTermMemory {
  let store = loadStore(filePath);

  return {
    get(key: string): unknown | undefined {
      const entry = store.entries[key];
      return entry?.value;
    },

    set(key: string, value: unknown, metadata?: Record<string, string>): void {
      store.entries[key] = {
        id: crypto.randomUUID(),
        tier: 'long-term',
        key,
        value,
        createdAt: new Date().toISOString(),
        metadata,
      };
      saveStore(filePath, store);
    },

    delete(key: string): boolean {
      if (!(key in store.entries)) return false;
      delete store.entries[key];
      saveStore(filePath, store);
      return true;
    },

    search(prefix: string): MemoryEntry[] {
      // Reload from disk to pick up external changes
      store = loadStore(filePath);
      return Object.values(store.entries).filter((e) => e.key.startsWith(prefix));
    },

    keys(): string[] {
      store = loadStore(filePath);
      return Object.keys(store.entries);
    },
  };
}

interface EpisodicFileStore {
  entries: MemoryEntry[];
}

function loadEpisodicStore(filePath: string): EpisodicFileStore {
  if (!existsSync(filePath)) return { entries: [] };
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as EpisodicFileStore;
}

function saveEpisodicStore(filePath: string, store: EpisodicFileStore): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Create a file-backed episodic memory store.
 * Events persist across process restarts.
 */
export function createFileEpisodicMemory(filePath: string): EpisodicMemory {
  let store = loadEpisodicStore(filePath);

  return {
    append(event: { key: string; value: unknown; metadata?: Record<string, string> }): MemoryEntry {
      const entry: MemoryEntry = {
        id: crypto.randomUUID(),
        tier: 'episodic',
        key: event.key,
        value: event.value,
        createdAt: new Date().toISOString(),
        metadata: event.metadata,
      };
      store.entries.push(entry);
      saveEpisodicStore(filePath, store);
      return entry;
    },

    recent(limit: number): readonly MemoryEntry[] {
      store = loadEpisodicStore(filePath);
      return store.entries.slice(-limit);
    },

    search(key: string): readonly MemoryEntry[] {
      store = loadEpisodicStore(filePath);
      return store.entries.filter((e) => e.key === key);
    },
  };
}
