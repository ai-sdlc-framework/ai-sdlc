/**
 * Audit trail archival — compaction of old entries into gzipped archives.
 * Preserves chain root hash for continuity verification.
 */

import { createGzip, createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { AuditEntry } from '@ai-sdlc/reference';

export interface ArchiveManifest {
  /** Identifier for this archive. */
  archiveId: string;
  /** Number of entries in the archive. */
  entryCount: number;
  /** First entry timestamp. */
  firstTimestamp: string;
  /** Last entry timestamp. */
  lastTimestamp: string;
  /** Hash of the first entry (chain root for this segment). */
  firstHash: string;
  /** Hash of the last entry (chain tip for this segment). */
  lastHash: string;
  /** When the archive was created. */
  archivedAt: string;
  /** Path to the gzipped archive file. */
  archivePath: string;
}

export interface ArchivalOptions {
  /** Entries older than this are eligible for archival. */
  olderThanMs: number;
  /** Base directory for archive files. */
  archiveDir: string;
}

/**
 * Archive old audit entries to a gzipped JSONL file.
 * Returns entries that were NOT archived (i.e., still active).
 */
export async function archiveEntries(
  entries: readonly AuditEntry[],
  options: ArchivalOptions,
): Promise<{ remaining: AuditEntry[]; manifest: ArchiveManifest | null }> {
  const cutoff = new Date(Date.now() - options.olderThanMs).toISOString();
  const toArchive = entries.filter((e) => e.timestamp < cutoff);
  const remaining = entries.filter((e) => e.timestamp >= cutoff);

  if (toArchive.length === 0) {
    return { remaining: [...remaining], manifest: null };
  }

  const archiveId = `archive-${Date.now()}`;
  const archivePath = `${options.archiveDir}/${archiveId}.jsonl.gz`;

  // Write JSONL then gzip
  const jsonl = toArchive.map((e) => JSON.stringify(e)).join('\n');
  const tmpPath = `${options.archiveDir}/${archiveId}.jsonl`;
  await writeFile(tmpPath, jsonl, 'utf-8');

  // Gzip the file
  await pipeline(
    createReadStream(tmpPath),
    createGzip(),
    createWriteStream(archivePath),
  );
  await unlink(tmpPath);

  const manifest: ArchiveManifest = {
    archiveId,
    entryCount: toArchive.length,
    firstTimestamp: toArchive[0].timestamp,
    lastTimestamp: toArchive[toArchive.length - 1].timestamp,
    firstHash: toArchive[0].hash ?? '',
    lastHash: toArchive[toArchive.length - 1].hash ?? '',
    archivedAt: new Date().toISOString(),
    archivePath,
  };

  return { remaining: [...remaining], manifest };
}

/**
 * Load entries from a gzipped JSONL archive.
 */
export async function loadArchivedEntries(archivePath: string): Promise<AuditEntry[]> {
  if (!existsSync(archivePath)) return [];

  const chunks: Buffer[] = [];
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    async function* collect(source) {
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk));
      }
      yield Buffer.alloc(0);
    },
  );

  const content = Buffer.concat(chunks).toString('utf-8');
  if (!content.trim()) return [];

  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Verify that an archive's chain links correctly to a continuation hash.
 * The last entry's hash in the archive should match the previousHash
 * of the first remaining entry.
 */
export function verifyArchiveContinuity(
  manifest: ArchiveManifest,
  firstRemainingEntry: AuditEntry | undefined,
): boolean {
  if (!firstRemainingEntry) return true; // nothing to chain to
  return firstRemainingEntry.previousHash === manifest.lastHash;
}
