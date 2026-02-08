/**
 * In-memory implementation of the 5-tier agent memory model.
 */

import crypto from 'node:crypto';
import type {
  AgentMemory,
  WorkingMemory,
  ShortTermMemory,
  LongTermMemory,
  SharedMemory,
  EpisodicMemory,
  MemoryEntry,
} from './types.js';

function createWorkingMemory(): WorkingMemory {
  const store = new Map<string, unknown>();
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    delete: (key) => store.delete(key),
    clear: () => store.clear(),
    keys: () => Array.from(store.keys()),
  };
}

interface TTLEntry {
  value: unknown;
  expiresAt: number;
}

function createShortTermMemory(): ShortTermMemory {
  const store = new Map<string, TTLEntry>();

  function isExpired(entry: TTLEntry): boolean {
    return Date.now() > entry.expiresAt;
  }

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete: (key) => store.delete(key),
    keys() {
      // Clean up expired entries
      for (const [key, entry] of store) {
        if (isExpired(entry)) store.delete(key);
      }
      return Array.from(store.keys());
    },
  };
}

function createLongTermMemory(): LongTermMemory {
  const store = new Map<string, MemoryEntry>();

  return {
    get(key) {
      return store.get(key)?.value;
    },
    set(key, value, metadata) {
      store.set(key, {
        id: crypto.randomUUID(),
        tier: 'long-term',
        key,
        value,
        createdAt: new Date().toISOString(),
        metadata,
      });
    },
    delete: (key) => store.delete(key),
    search(prefix) {
      const results: MemoryEntry[] = [];
      for (const [key, entry] of store) {
        if (key.startsWith(prefix)) results.push(entry);
      }
      return results;
    },
    keys: () => Array.from(store.keys()),
  };
}

function createSharedMemory(): SharedMemory {
  const store = new Map<string, Map<string, unknown>>();

  function getNamespace(ns: string): Map<string, unknown> {
    let map = store.get(ns);
    if (!map) {
      map = new Map();
      store.set(ns, map);
    }
    return map;
  }

  return {
    get: (ns, key) => getNamespace(ns).get(key),
    set: (ns, key, value) => {
      getNamespace(ns).set(key, value);
    },
    delete: (ns, key) => getNamespace(ns).delete(key),
    keys: (ns) => Array.from(getNamespace(ns).keys()),
  };
}

function createEpisodicMemory(): EpisodicMemory {
  const entries: MemoryEntry[] = [];

  return {
    append(event) {
      const entry: MemoryEntry = {
        id: crypto.randomUUID(),
        tier: 'episodic',
        key: event.key,
        value: event.value,
        createdAt: new Date().toISOString(),
        metadata: event.metadata,
      };
      entries.push(entry);
      return entry;
    },
    recent(limit) {
      return entries.slice(-limit);
    },
    search(key) {
      return entries.filter((e) => e.key === key);
    },
  };
}

/**
 * Create a complete in-memory agent memory with all 5 tiers.
 */
export function createAgentMemory(): AgentMemory {
  return {
    working: createWorkingMemory(),
    shortTerm: createShortTermMemory(),
    longTerm: createLongTermMemory(),
    shared: createSharedMemory(),
    episodic: createEpisodicMemory(),
  };
}
