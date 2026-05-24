/**
 * Default JSONL storage backend per RFC-0019 §8.2.
 *
 * Storage layout:
 *   <artifactsDir>/_embeddings/
 *   └── openai-text-embedding-3-small-2024-01-25.jsonl   (one per provider+version)
 *
 * Files are named `<safeProvider>-<safeModelVersion>.jsonl` where each component
 * is sanitized to `[a-zA-Z0-9._-]`. The directory itself is the index — `scan()`
 * directory-walks `<embeddingsDir>/*.jsonl` and entries carry their own
 * `(embeddingProvider, embeddingModelVersion)` provenance for filtering.
 *
 * This removes the read-modify-write race on a previous `_index.json` file
 * (Iter 2 MAJOR #2): two concurrent first-writes for different
 * (provider, modelVersion) tuples can no longer clobber each other because the
 * index lookup is now `existsSync(<filePath>)` rather than a JSON file rewrite.
 *
 * Write semantics: ALL writes use an atomic read→append→temp-then-rename pattern
 * (Iter 2 CRITICAL #1). The previous `appendFileSync` short path for sub-PIPE_BUF
 * lines was based on a misreading of POSIX — PIPE_BUF only applies to pipes/
 * FIFOs/sockets, not regular files. The unified temp-then-rename path holds
 * regardless of write size and guarantees readers never see partial lines.
 *
 * Scale escalation thresholds (RFC-0019 OQ-1 re-walkthrough):
 *   > 100K entries per provider+version → emit operator-visible signal
 *   > p95 read latency 250ms           → emit operator-visible signal
 *   See docs/operations/embedding-providers.md#scale-escalation for the
 *   JSONL→sqlite swap runbook.
 *
 * Concurrency contract:
 *   - write(): atomic temp-file-then-rename ensures readers see complete lines.
 *     NOTE: concurrent writes to the same file may still race at the read+append
 *     step (last-rename-wins). Single-writer-per-(provider,modelVersion) is the
 *     safe usage; multi-writer requires a per-file mutex layered above.
 *   - read(): linear scan on a stable file; safe to run concurrently with writes.
 *   - delete(): rewrites the file atomically after filtering out the entry.
 *
 * This backend is intentionally NOT optimized for million-vector scales.
 * The interface is EmbeddingStorageBackend; adopters who hit the thresholds
 * above can swap in a sqlite backend with zero consumer-code changes.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { EmbeddingStorageBackend, VectorStoreEntry, VectorStoreFilter } from './types.js';

/** Scale escalation thresholds per RFC-0019 OQ-1 re-walkthrough. */
export const SCALE_ESCALATION_MAX_ENTRIES = 100_000;
export const SCALE_ESCALATION_P95_READ_MS = 250;

/** Scale escalation signal emitted when thresholds are crossed. */
export interface ScaleEscalationSignal {
  type: 'count-exceeded' | 'p95-latency-exceeded';
  provider: string;
  modelVersion: string;
  currentCount?: number;
  currentP95Ms?: number;
  thresholdCount?: number;
  thresholdP95Ms?: number;
  runbook: string;
}

/** Default runbook URL for the scale-escalation signal. */
const SCALE_RUNBOOK = 'docs/operations/embedding-providers.md#scale-escalation';

/**
 * JSONL embedding storage backend (default for RFC-0019 v1).
 *
 * Construct with the path to the artifacts directory:
 *   const backend = new JsonlEmbeddingStorageBackend('/path/to/.ai-sdlc/artifacts');
 *
 * The backend creates `<artifactsDir>/_embeddings/` on first use.
 */
export class JsonlEmbeddingStorageBackend implements EmbeddingStorageBackend {
  readonly name = 'jsonl';

  private readonly embeddingsDir: string;

  /**
   * Optional callback for operator-visible scale-escalation signals.
   * Wire to your logging/telemetry layer; defaults to console.warn.
   */
  onScaleEscalation?: (signal: ScaleEscalationSignal) => void;

  constructor(
    artifactsDir: string,
    options?: { onScaleEscalation?: (signal: ScaleEscalationSignal) => void },
  ) {
    this.embeddingsDir = join(artifactsDir, '_embeddings');
    if (options?.onScaleEscalation) {
      this.onScaleEscalation = options.onScaleEscalation;
    }
  }

  /** Ensure the embeddings directory exists (lazy init). */
  private ensureDir(): void {
    if (!existsSync(this.embeddingsDir)) {
      mkdirSync(this.embeddingsDir, { recursive: true });
    }
  }

  /** Derive the slug used as the JSONL filename stem. */
  private slug(provider: string, modelVersion: string): string {
    // Sanitize: replace characters unsafe in filenames with '-'.
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '-');
    return `${safe(provider)}-${safe(modelVersion)}`;
  }

  /** Return the JSONL file path for a given provider+version. */
  private jsonlPath(provider: string, modelVersion: string): string {
    return join(this.embeddingsDir, `${this.slug(provider, modelVersion)}.jsonl`);
  }

  /** List all JSONL file paths in the embeddings directory. */
  private listJsonlFiles(): string[] {
    if (!existsSync(this.embeddingsDir)) return [];
    return readdirSync(this.embeddingsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(this.embeddingsDir, name));
  }

  /**
   * Compute the SHA-256 hash of the source text.
   * Exposed as a static helper so callers can pre-compute hashes.
   */
  static hashText(text: string): string {
    return createHash('sha256').update(text, 'utf-8').digest('hex');
  }

  /**
   * Write an entry to the JSONL file for its (provider, modelVersion) tuple.
   *
   * All writes use atomic read→append→temp-then-rename: read existing file
   * content, concatenate the new line, write to a temp file, then atomically
   * rename over the target. This guarantees readers never see partial lines.
   *
   * The textHash is computed from the text if not already set (caller convenience).
   *
   * Single-writer-per-file safety: concurrent writes to the SAME
   * (provider, modelVersion) target may still race at the read+append step
   * (last-rename-wins). The intended usage is single-writer-per-tuple; if you
   * need multi-writer-per-tuple, layer a per-file mutex above this backend.
   */
  async write(entry: VectorStoreEntry): Promise<void> {
    this.ensureDir();

    // Normalize: compute textHash if caller omitted it.
    const normalized: VectorStoreEntry = {
      ...entry,
      textHash: entry.textHash || JsonlEmbeddingStorageBackend.hashText(entry.text),
      writtenAt: entry.writtenAt || new Date().toISOString(),
    };

    const line = JSON.stringify(normalized) + '\n';
    const filePath = this.jsonlPath(normalized.embeddingProvider, normalized.embeddingModelVersion);

    // Always temp-then-rename for atomicity (Iter 2 CRITICAL #1 / MAJOR #3).
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, existing + line, 'utf-8');
    renameSync(tmp, filePath);

    // Check scale escalation threshold after write.
    // Count is computed lazily — only when near the threshold to avoid O(n) overhead.
    await this._maybeEmitScaleSignal(
      normalized.embeddingProvider,
      normalized.embeddingModelVersion,
    );
  }

  /**
   * Read an entry by (textHash, provider, modelVersion).
   * Returns null when not found.
   *
   * JSONL backend: O(n) linear scan. P95 latency should be <100ms for ≤100K entries.
   * Emits a scale-escalation signal when p95 latency exceeds 250ms.
   */
  async read(
    textHash: string,
    provider: string,
    modelVersion: string,
  ): Promise<VectorStoreEntry | null> {
    const startMs = Date.now();
    const filePath = this.jsonlPath(provider, modelVersion);

    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as VectorStoreEntry;
        if (entry.textHash === textHash) {
          const elapsedMs = Date.now() - startMs;
          await this._maybeEmitLatencySignal(provider, modelVersion, elapsedMs);
          return entry;
        }
      } catch {
        // Skip malformed lines.
      }
    }

    const elapsedMs = Date.now() - startMs;
    await this._maybeEmitLatencySignal(provider, modelVersion, elapsedMs);
    return null;
  }

  /**
   * Scan all entries matching an optional filter.
   * Yields entries from each JSONL file discovered in the embeddings directory.
   */
  async *scan(filter?: VectorStoreFilter): AsyncIterable<VectorStoreEntry> {
    for (const filePath of this.listJsonlFiles()) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as VectorStoreEntry;
          if (filter?.provider && entry.embeddingProvider !== filter.provider) continue;
          if (filter?.modelVersion && entry.embeddingModelVersion !== filter.modelVersion) continue;
          yield entry;
        } catch {
          // Skip malformed lines.
        }
      }
    }
  }

  /**
   * Delete a specific entry by (textHash, provider, modelVersion).
   * Rewrites the JSONL file atomically after filtering out the entry.
   * No-op when the entry does not exist.
   */
  async delete(textHash: string, provider: string, modelVersion: string): Promise<void> {
    const filePath = this.jsonlPath(provider, modelVersion);

    if (!existsSync(filePath)) return;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    const remaining = lines.filter((line) => {
      try {
        const entry = JSON.parse(line) as VectorStoreEntry;
        return entry.textHash !== textHash;
      } catch {
        return true; // keep malformed lines (don't silently drop data)
      }
    });

    // Atomically rewrite the file.
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, remaining.join('\n') + (remaining.length > 0 ? '\n' : ''), 'utf-8');
    renameSync(tmp, filePath);
  }

  /**
   * Count entries matching an optional filter.
   * Used by the scale-escalation heuristic.
   */
  async count(filter?: VectorStoreFilter): Promise<number> {
    let total = 0;
    for await (const _entry of this.scan(filter)) {
      total++;
    }
    return total;
  }

  /**
   * Garbage-collect entries older than `retentionDays` from the specified
   * provider+version JSONL file (or all files if not specified).
   *
   * Entries with `writtenAt` older than `cutoffDate` are removed.
   * The JSONL file is rewritten atomically via temp-then-rename.
   *
   * @param retentionDays - Number of days to retain entries (default 90).
   * @param filter - Optional provider/modelVersion filter; absent = all files.
   * @returns Count of removed entries.
   */
  async gc(retentionDays = 90, filter?: VectorStoreFilter): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    return this._gcWithCutoff(cutoff, filter);
  }

  /**
   * Internal GC implementation; accepts a cutoff Date for testability.
   */
  async gcWithCutoffDate(cutoff: Date, filter?: VectorStoreFilter): Promise<number> {
    return this._gcWithCutoff(cutoff, filter);
  }

  private async _gcWithCutoff(cutoff: Date, filter?: VectorStoreFilter): Promise<number> {
    let removed = 0;

    for (const filePath of this.listJsonlFiles()) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);

      const surviving: string[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as VectorStoreEntry;

          // Apply provider/modelVersion filter if set.
          if (filter?.provider && entry.embeddingProvider !== filter.provider) {
            surviving.push(line);
            continue;
          }
          if (filter?.modelVersion && entry.embeddingModelVersion !== filter.modelVersion) {
            surviving.push(line);
            continue;
          }

          const writtenAt = new Date(entry.writtenAt);
          if (writtenAt < cutoff) {
            removed++;
          } else {
            surviving.push(line);
          }
        } catch {
          surviving.push(line); // keep malformed lines
        }
      }

      if (surviving.length !== lines.length) {
        // Rewrite atomically only when something was removed.
        const tmp = `${filePath}.${randomUUID()}.tmp`;
        writeFileSync(tmp, surviving.join('\n') + (surviving.length > 0 ? '\n' : ''), 'utf-8');
        renameSync(tmp, filePath);
      }
    }

    return removed;
  }

  /** Emit a scale-escalation signal when count exceeds the threshold. */
  private async _maybeEmitScaleSignal(provider: string, modelVersion: string): Promise<void> {
    // Only check periodically — count() is O(n) so we don't want it on every write.
    // Sample 1% of writes to avoid performance impact at high write rates.
    if (Math.random() > 0.01) return;

    const currentCount = await this.count({ provider, modelVersion });
    if (currentCount > SCALE_ESCALATION_MAX_ENTRIES) {
      const signal: ScaleEscalationSignal = {
        type: 'count-exceeded',
        provider,
        modelVersion,
        currentCount,
        thresholdCount: SCALE_ESCALATION_MAX_ENTRIES,
        runbook: SCALE_RUNBOOK,
      };
      if (this.onScaleEscalation) {
        this.onScaleEscalation(signal);
      } else {
        console.warn(
          `[embedding-storage] scale-escalation: ${provider}/${modelVersion} has ${currentCount} entries (threshold: ${SCALE_ESCALATION_MAX_ENTRIES}). See ${SCALE_RUNBOOK}`,
        );
      }
    }
  }

  /** Emit a scale-escalation signal when read latency exceeds the threshold. */
  private async _maybeEmitLatencySignal(
    provider: string,
    modelVersion: string,
    elapsedMs: number,
  ): Promise<void> {
    if (elapsedMs > SCALE_ESCALATION_P95_READ_MS) {
      const signal: ScaleEscalationSignal = {
        type: 'p95-latency-exceeded',
        provider,
        modelVersion,
        currentP95Ms: elapsedMs,
        thresholdP95Ms: SCALE_ESCALATION_P95_READ_MS,
        runbook: SCALE_RUNBOOK,
      };
      if (this.onScaleEscalation) {
        this.onScaleEscalation(signal);
      } else {
        console.warn(
          `[embedding-storage] scale-escalation: read for ${provider}/${modelVersion} took ${elapsedMs}ms (threshold: ${SCALE_ESCALATION_P95_READ_MS}ms). See ${SCALE_RUNBOOK}`,
        );
      }
    }
  }
}
