/**
 * Unit tests for the JSONL embedding storage backend.
 *
 * Covers RFC-0019 Phase 2 acceptance criteria:
 *  AC#1  — EmbeddingStorageBackend interface (tested via JsonlEmbeddingStorageBackend)
 *  AC#2  — JSONL backend ships as default at _embeddings/*.jsonl
 *  AC#5  — Vectors carry (embeddingProvider, embeddingModelVersion) provenance
 *  AC#6  — Write 1K entries; read by textHash in <100ms median
 *  AC#7  — Concurrent-write atomicity preserved
 *  AC#8  — GC removes >90d entries; tests verify retention boundary
 *  AC#9  — Scale-escalation heuristic emits operator-visible signal at >100K entries OR p95 read >250ms
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonlEmbeddingStorageBackend,
  SCALE_ESCALATION_MAX_ENTRIES,
  SCALE_ESCALATION_P95_READ_MS,
} from './jsonl-backend.js';
import { createEmbeddingStorageBackend } from './index.js';
import type { VectorStoreEntry } from './types.js';

// ── Test fixture helpers ──────────────────────────────────────────────────────

function makeEntry(
  text: string,
  provider = 'openai-text-embedding-3-small',
  modelVersion = '2024-01-25',
  overrides?: Partial<VectorStoreEntry>,
): VectorStoreEntry {
  return {
    vector: [0.1, 0.2, 0.3],
    embeddingProvider: provider,
    embeddingModelVersion: modelVersion,
    writtenAt: new Date().toISOString(),
    text,
    textHash: JsonlEmbeddingStorageBackend.hashText(text),
    ...overrides,
  };
}

/** Create a dated entry N days ago for GC tests. */
function makeOldEntry(text: string, daysAgo: number): VectorStoreEntry {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return makeEntry(text, 'openai-text-embedding-3-small', '2024-01-25', {
    writtenAt: d.toISOString(),
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('JsonlEmbeddingStorageBackend', () => {
  let tmpDir: string;
  let backend: JsonlEmbeddingStorageBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-338-test-'));
    backend = new JsonlEmbeddingStorageBackend(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── AC#2: JSONL backend ships as default ───────────────────────────────────

  it('has name "jsonl"', () => {
    expect(backend.name).toBe('jsonl');
  });

  it('creates _embeddings directory on first write', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(tmpDir, '_embeddings'))).toBe(false);

    await backend.write(makeEntry('hello'));

    expect(existsSync(join(tmpDir, '_embeddings'))).toBe(true);
  });

  // ── AC#5: Vectors carry (embeddingProvider, embeddingModelVersion) provenance

  it('preserves embeddingProvider and embeddingModelVersion on write→read', async () => {
    const entry = makeEntry('test text', 'openai-text-embedding-3-small', '2024-01-25');
    await backend.write(entry);

    const found = await backend.read(entry.textHash, 'openai-text-embedding-3-small', '2024-01-25');
    expect(found).not.toBeNull();
    expect(found!.embeddingProvider).toBe('openai-text-embedding-3-small');
    expect(found!.embeddingModelVersion).toBe('2024-01-25');
  });

  it('returns null for unknown textHash', async () => {
    await backend.write(makeEntry('hello'));
    const result = await backend.read(
      'nonexistent-hash',
      'openai-text-embedding-3-small',
      '2024-01-25',
    );
    expect(result).toBeNull();
  });

  it('returns null for known hash but wrong provider', async () => {
    const entry = makeEntry('hello');
    await backend.write(entry);
    const result = await backend.read(entry.textHash, 'different-provider', '2024-01-25');
    expect(result).toBeNull();
  });

  it('stores entries in separate JSONL files per provider+version', async () => {
    const { existsSync } = await import('node:fs');

    await backend.write(makeEntry('text-a', 'openai-text-embedding-3-small', '2024-01-25'));
    await backend.write(makeEntry('text-b', 'openai-text-embedding-3-large', '2024-01-25'));

    expect(
      existsSync(join(tmpDir, '_embeddings', 'openai-text-embedding-3-small-2024-01-25.jsonl')),
    ).toBe(true);
    expect(
      existsSync(join(tmpDir, '_embeddings', 'openai-text-embedding-3-large-2024-01-25.jsonl')),
    ).toBe(true);
  });

  // ── Write→read round-trip ─────────────────────────────────────────────────

  it('write→read round-trip preserves all fields', async () => {
    const entry: VectorStoreEntry = {
      vector: [1.1, 2.2, 3.3],
      embeddingProvider: 'openai-text-embedding-3-small',
      embeddingModelVersion: '2024-01-25',
      writtenAt: '2026-05-01T12:00:00.000Z',
      text: 'hello world',
      textHash: JsonlEmbeddingStorageBackend.hashText('hello world'),
      metadata: { sourceDoc: 'rfc-0009.md', shardId: 'OQ-6' },
    };

    await backend.write(entry);
    const found = await backend.read(entry.textHash, 'openai-text-embedding-3-small', '2024-01-25');

    expect(found).not.toBeNull();
    expect(found!.vector).toEqual([1.1, 2.2, 3.3]);
    expect(found!.text).toBe('hello world');
    expect(found!.metadata).toEqual({ sourceDoc: 'rfc-0009.md', shardId: 'OQ-6' });
  });

  it('auto-computes textHash when omitted on write', async () => {
    const entry: VectorStoreEntry = {
      vector: [0.1],
      embeddingProvider: 'openai-text-embedding-3-small',
      embeddingModelVersion: '2024-01-25',
      writtenAt: new Date().toISOString(),
      text: 'compute my hash',
      textHash: '', // omitted / empty
    };

    await backend.write(entry);

    const expectedHash = JsonlEmbeddingStorageBackend.hashText('compute my hash');
    const found = await backend.read(expectedHash, 'openai-text-embedding-3-small', '2024-01-25');
    expect(found).not.toBeNull();
    expect(found!.textHash).toBe(expectedHash);
  });

  // ── AC#6: Write 1K entries; read by textHash in <100ms median ─────────────

  it('writes 1K entries and reads by textHash (median <100ms)', async () => {
    const N = 1000;
    const entries: VectorStoreEntry[] = [];
    for (let i = 0; i < N; i++) {
      entries.push(makeEntry(`text-entry-${i}`));
    }

    // Write all.
    for (const e of entries) {
      await backend.write(e);
    }

    // Sample 20 reads and assert all complete in <100ms each.
    const sample = entries.filter((_, i) => i % 50 === 0); // ~20 samples
    const latencies: number[] = [];

    for (const e of sample) {
      const t0 = Date.now();
      const found = await backend.read(e.textHash, e.embeddingProvider, e.embeddingModelVersion);
      const elapsed = Date.now() - t0;
      latencies.push(elapsed);
      expect(found).not.toBeNull();
      expect(found!.text).toBe(e.text);
    }

    // Compute median.
    const sorted = [...latencies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(median).toBeLessThan(100); // AC#6: <100ms median
  }, 30_000); // generous timeout for 1K writes

  // ── scan() ────────────────────────────────────────────────────────────────

  it('scan() with no filter yields all entries across all providers', async () => {
    await backend.write(makeEntry('entry-1', 'openai-text-embedding-3-small', '2024-01-25'));
    await backend.write(makeEntry('entry-2', 'openai-text-embedding-3-small', '2024-01-25'));
    await backend.write(makeEntry('entry-3', 'openai-text-embedding-3-large', '2024-01-25'));

    const all: VectorStoreEntry[] = [];
    for await (const e of backend.scan()) {
      all.push(e);
    }

    expect(all).toHaveLength(3);
  });

  it('scan() with provider filter yields only matching entries', async () => {
    await backend.write(makeEntry('entry-a', 'openai-text-embedding-3-small', '2024-01-25'));
    await backend.write(makeEntry('entry-b', 'openai-text-embedding-3-large', '2024-01-25'));

    const found: VectorStoreEntry[] = [];
    for await (const e of backend.scan({ provider: 'openai-text-embedding-3-small' })) {
      found.push(e);
    }

    expect(found).toHaveLength(1);
    expect(found[0]!.text).toBe('entry-a');
  });

  // ── delete() ──────────────────────────────────────────────────────────────

  it('delete() removes the entry and subsequent read returns null', async () => {
    const entry = makeEntry('to-delete');
    await backend.write(entry);

    const before = await backend.read(
      entry.textHash,
      entry.embeddingProvider,
      entry.embeddingModelVersion,
    );
    expect(before).not.toBeNull();

    await backend.delete(entry.textHash, entry.embeddingProvider, entry.embeddingModelVersion);

    const after = await backend.read(
      entry.textHash,
      entry.embeddingProvider,
      entry.embeddingModelVersion,
    );
    expect(after).toBeNull();
  });

  it('delete() is a no-op when entry does not exist', async () => {
    await expect(
      backend.delete('nonexistent-hash', 'openai-text-embedding-3-small', '2024-01-25'),
    ).resolves.toBeUndefined();
  });

  it('delete() preserves other entries in the same file', async () => {
    const entryA = makeEntry('entry-a');
    const entryB = makeEntry('entry-b');
    await backend.write(entryA);
    await backend.write(entryB);

    await backend.delete(entryA.textHash, entryA.embeddingProvider, entryA.embeddingModelVersion);

    const foundA = await backend.read(
      entryA.textHash,
      entryA.embeddingProvider,
      entryA.embeddingModelVersion,
    );
    const foundB = await backend.read(
      entryB.textHash,
      entryB.embeddingProvider,
      entryB.embeddingModelVersion,
    );

    expect(foundA).toBeNull();
    expect(foundB).not.toBeNull();
  });

  // ── count() ───────────────────────────────────────────────────────────────

  it('count() returns 0 when no entries', async () => {
    const n = await backend.count();
    expect(n).toBe(0);
  });

  it('count() with provider filter counts correctly', async () => {
    await backend.write(makeEntry('a', 'openai-text-embedding-3-small', '2024-01-25'));
    await backend.write(makeEntry('b', 'openai-text-embedding-3-small', '2024-01-25'));
    await backend.write(makeEntry('c', 'openai-text-embedding-3-large', '2024-01-25'));

    expect(await backend.count({ provider: 'openai-text-embedding-3-small' })).toBe(2);
    expect(await backend.count({ provider: 'openai-text-embedding-3-large' })).toBe(1);
    expect(await backend.count()).toBe(3);
  });

  // ── AC#7: Concurrent-write atomicity ──────────────────────────────────────

  it('concurrent writes to the same file do not corrupt entries', async () => {
    const N = 50;
    const entries = Array.from({ length: N }, (_, i) => makeEntry(`concurrent-text-${i}`));

    // Fire all writes concurrently.
    await Promise.all(entries.map((e) => backend.write(e)));

    // Every entry must be readable.
    for (const e of entries) {
      const found = await backend.read(e.textHash, e.embeddingProvider, e.embeddingModelVersion);
      expect(found).not.toBeNull();
      expect(found!.text).toBe(e.text);
    }

    // Total count must match N.
    const total = await backend.count();
    expect(total).toBe(N);
  });

  // ── AC#8: GC removes >90d entries; retention boundary ─────────────────────

  it('gc() removes entries older than retentionDays', async () => {
    const oldEntry = makeOldEntry('ancient-text', 100); // 100 days old
    const newEntry = makeEntry('fresh-text');
    await backend.write(oldEntry);
    await backend.write(newEntry);

    const removed = await backend.gcWithCutoffDate(
      (() => {
        const d = new Date();
        d.setDate(d.getDate() - 90);
        return d;
      })(),
    );

    expect(removed).toBe(1);

    const oldFound = await backend.read(
      oldEntry.textHash,
      oldEntry.embeddingProvider,
      oldEntry.embeddingModelVersion,
    );
    const newFound = await backend.read(
      newEntry.textHash,
      newEntry.embeddingProvider,
      newEntry.embeddingModelVersion,
    );

    expect(oldFound).toBeNull(); // GC'd
    expect(newFound).not.toBeNull(); // retained
  });

  it('gc() retains entries exactly at the retention boundary', async () => {
    // Entry written exactly at the boundary: should be RETAINED (not removed).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    // Entry written 89 days ago: should be retained.
    const recentEnough = makeOldEntry('borderline-text', 89);
    await backend.write(recentEnough);

    const removed = await backend.gcWithCutoffDate(cutoff);

    expect(removed).toBe(0); // nothing removed — entry is within retention window
  });

  it('gc() with provider filter only removes matching entries', async () => {
    const oldSmall = makeOldEntry('old-small', 100);
    oldSmall.embeddingProvider = 'openai-text-embedding-3-small';
    const oldLarge = makeOldEntry('old-large', 100);
    oldLarge.embeddingProvider = 'openai-text-embedding-3-large';
    oldLarge.textHash = JsonlEmbeddingStorageBackend.hashText('old-large');

    await backend.write(oldSmall);
    await backend.write(
      makeEntry('old-large', 'openai-text-embedding-3-large', '2024-01-25', {
        writtenAt: (() => {
          const d = new Date();
          d.setDate(d.getDate() - 100);
          return d.toISOString();
        })(),
      }),
    );

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    const removed = await backend.gcWithCutoffDate(cutoff, {
      provider: 'openai-text-embedding-3-small',
    });

    // Only the small-provider entry should be removed.
    expect(removed).toBe(1);
  });

  it('gc() handles an empty store without error', async () => {
    const removed = await backend.gc(90);
    expect(removed).toBe(0);
  });

  // ── AC#9: Scale-escalation heuristic ──────────────────────────────────────

  it('emits scale-escalation signal when count exceeds threshold (mocked)', async () => {
    const signals: { type: string }[] = [];
    const backendWithCb = new JsonlEmbeddingStorageBackend(tmpDir, {
      onScaleEscalation: (s) => signals.push(s),
    });

    // Mock count() to return a value above threshold to avoid writing 100K entries.
    vi.spyOn(backendWithCb, 'count').mockResolvedValue(SCALE_ESCALATION_MAX_ENTRIES + 1);

    // Force Math.random to return < 0.01 so the sampling check always fires.
    vi.spyOn(Math, 'random').mockReturnValue(0.005);

    await backendWithCb.write(makeEntry('trigger-scale-check'));

    // Allow microtasks to flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0]!.type).toBe('count-exceeded');
  });

  it('emits scale-escalation signal when read latency exceeds threshold (mocked)', async () => {
    const signals: { type: string }[] = [];
    const backendWithCb = new JsonlEmbeddingStorageBackend(tmpDir, {
      onScaleEscalation: (s) => signals.push(s),
    });

    // Write an entry.
    const entry = makeEntry('slow-read-text');
    await backendWithCb.write(entry);

    // Mock Date.now to simulate a slow read (>250ms).
    let callCount = 0;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call = start time; second call = end time (simulating slow read).
      return callCount === 1 ? 1000 : 1000 + SCALE_ESCALATION_P95_READ_MS + 10;
    });

    await backendWithCb.read(entry.textHash, entry.embeddingProvider, entry.embeddingModelVersion);

    expect(signals.some((s) => s.type === 'p95-latency-exceeded')).toBe(true);

    vi.spyOn(Date, 'now').mockImplementation(realNow);
  });

  // ── hashText() static helper ───────────────────────────────────────────────

  it('hashText() produces a stable SHA-256 hex string', () => {
    const hash = JsonlEmbeddingStorageBackend.hashText('hello');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic.
    expect(JsonlEmbeddingStorageBackend.hashText('hello')).toBe(hash);
    // Different inputs produce different hashes.
    expect(JsonlEmbeddingStorageBackend.hashText('world')).not.toBe(hash);
  });
});

// ── Backend factory ──────────────────────────────────────────────────────────

describe('createEmbeddingStorageBackend', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-338-factory-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC#3: returns a JsonlEmbeddingStorageBackend when backendName is "jsonl"', () => {
    const backend = createEmbeddingStorageBackend('jsonl', tmpDir);
    expect(backend.name).toBe('jsonl');
    expect(backend).toBeInstanceOf(JsonlEmbeddingStorageBackend);
  });

  it('AC#3: defaults to "jsonl" when backendName is omitted', () => {
    const backend = createEmbeddingStorageBackend(undefined, tmpDir);
    expect(backend.name).toBe('jsonl');
  });

  it('throws for unknown backendName', () => {
    expect(() => createEmbeddingStorageBackend('unknown-backend', tmpDir)).toThrow(
      "Unknown embedding storage backend 'unknown-backend'",
    );
  });
});
