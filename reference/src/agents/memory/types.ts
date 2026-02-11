/**
 * Agent memory types from PRD Section 13.3.
 *
 * Five-tier memory model:
 * 1. Working — ephemeral, current task context
 * 2. Short-term — TTL-based, recent interactions
 * 3. Long-term — persistent, learned patterns
 * 4. Shared — cross-agent shared state
 * 5. Episodic — append-only, event history
 */

export type MemoryTier = 'working' | 'short-term' | 'long-term' | 'shared' | 'episodic';

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  key: string;
  value: unknown;
  createdAt: string;
  expiresAt?: string;
  metadata?: Record<string, string>;
}

export interface WorkingMemory {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
}

export interface ShortTermMemory {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  delete(key: string): boolean;
  keys(): string[];
}

export interface LongTermMemory {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, metadata?: Record<string, string>): void;
  delete(key: string): boolean;
  search(prefix: string): MemoryEntry[];
  keys(): string[];
}

export interface SharedMemory {
  get(namespace: string, key: string): unknown | undefined;
  set(namespace: string, key: string, value: unknown): void;
  delete(namespace: string, key: string): boolean;
  keys(namespace: string): string[];
}

export interface EpisodicMemory {
  append(event: { key: string; value: unknown; metadata?: Record<string, string> }): MemoryEntry;
  recent(limit: number): readonly MemoryEntry[];
  search(key: string): readonly MemoryEntry[];
}

export interface AgentMemory {
  working: WorkingMemory;
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;
  shared: SharedMemory;
  episodic: EpisodicMemory;
}

/** Persistence backend for agent memory tiers. */
export interface MemoryStore {
  /** Read a value by key. Returns undefined if not found. */
  read(key: string): Promise<unknown | undefined>;
  /** Write a value by key. */
  write(key: string, value: unknown): Promise<void>;
  /** Delete a value by key. */
  delete(key: string): Promise<void>;
  /** List keys, optionally filtered by prefix. */
  list(prefix?: string): Promise<string[]>;
}
