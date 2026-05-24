/**
 * Unit tests for cli-embedding-gc.
 *
 * Tests cover:
 *  AC#4  — cli-embedding-gc ships with mtime-based retention; per-org gcRetentionDays override
 *  AC#8  — GC removes >90d entries; tests verify retention boundary
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc, collectStats } from './embedding-gc.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJsonlEntry(
  text: string,
  daysAgo: number,
  provider = 'openai-text-embedding-3-small',
  modelVersion = '2024-01-25',
): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return JSON.stringify({
    vector: [0.1, 0.2, 0.3],
    embeddingProvider: provider,
    embeddingModelVersion: modelVersion,
    writtenAt: d.toISOString(),
    text,
    textHash: `hash-${text}`,
  });
}

function makeEmbeddingsDir(tmpDir: string): string {
  const embDir = join(tmpDir, '_embeddings');
  mkdirSync(embDir, { recursive: true });
  return embDir;
}

function writeJsonlFile(embDir: string, slug: string, entries: string[]): string {
  const filePath = join(embDir, `${slug}.jsonl`);
  writeFileSync(filePath, entries.join('\n') + '\n', 'utf-8');
  return filePath;
}

function writeIndex(embDir: string, entries: Record<string, string>): void {
  const indexPath = join(embDir, '_index.json');
  writeFileSync(
    indexPath,
    JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('cli-embedding-gc (unit tests via module import)', () => {
  // We test the GC logic through the TypeScript module directly (no spawning).
  // This verifies the GC logic in isolation.

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-338-gc-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC#4: removes entries older than retention threshold', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = writeJsonlFile(embDir, slug, [
      makeJsonlEntry('old-text', 100), // 100 days old — should be removed
      makeJsonlEntry('new-text', 30), // 30 days old — should be retained
    ]);
    writeIndex(embDir, { [slug]: filePath });

    const result = runGc(embDir, 90);

    expect(result.removed).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.filesProcessed).toBe(1);

    // Verify the on-disk file was rewritten with only the surviving entry.
    const remaining = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]!).text).toBe('new-text');
  });

  it('AC#4: per-org gcRetentionDays override — 30 days removes more entries', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = writeJsonlFile(embDir, slug, [
      makeJsonlEntry('very-old', 100), // removed at both 90d and 30d
      makeJsonlEntry('medium', 60), // retained at 90d, removed at 30d
      makeJsonlEntry('recent', 20), // retained at both
    ]);
    writeIndex(embDir, { [slug]: filePath });

    // With 30d retention — only 'recent' survives.
    const result = runGc(embDir, 30);
    expect(result.removed).toBe(2);

    const remaining = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]!).text).toBe('recent');
  });

  it('AC#4: 90d retention retains a 60d-old entry but not a 100d-old one', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = writeJsonlFile(embDir, slug, [
      makeJsonlEntry('very-old', 100),
      makeJsonlEntry('medium', 60),
      makeJsonlEntry('recent', 20),
    ]);
    writeIndex(embDir, { [slug]: filePath });

    const result = runGc(embDir, 90);
    expect(result.removed).toBe(1);

    const remaining = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(2);
    const texts = remaining.map((l) => JSON.parse(l).text).sort();
    expect(texts).toEqual(['medium', 'recent']);
  });

  it('AC#8: GC retention boundary — entry written exactly at cutoff is retained', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';

    // Entry written exactly at the 90d boundary should be retained (inclusive).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const atBoundary = JSON.stringify({
      vector: [0.1],
      embeddingProvider: 'openai-text-embedding-3-small',
      embeddingModelVersion: '2024-01-25',
      writtenAt: cutoff.toISOString(),
      text: 'at-boundary',
      textHash: 'h-boundary',
    });
    const justBefore = JSON.stringify({
      vector: [0.1],
      embeddingProvider: 'openai-text-embedding-3-small',
      embeddingModelVersion: '2024-01-25',
      writtenAt: new Date(cutoff.getTime() - 60_000).toISOString(), // 1 min before cutoff
      text: 'just-before',
      textHash: 'h-before',
    });
    const filePath = writeJsonlFile(embDir, slug, [atBoundary, justBefore]);
    writeIndex(embDir, { [slug]: filePath });

    const result = runGc(embDir, 90);

    // Only the just-before entry should be removed.
    expect(result.removed).toBe(1);
    const remaining = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]!).text).toBe('at-boundary');
  });

  it('handles empty embeddings directory gracefully (no index file)', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    // No index file written.
    expect(existsSync(join(embDir, '_index.json'))).toBe(false);

    const result = runGc(embDir, 90);
    expect(result).toEqual({ removed: 0, scanned: 0, filesProcessed: 0 });
  });

  it('does not remove entries without a writtenAt field (legacy/corrupt protection)', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const legacyLine = JSON.stringify({
      vector: [0.1],
      embeddingProvider: 'openai-text-embedding-3-small',
      embeddingModelVersion: '2024-01-25',
      text: 'no-date',
      textHash: 'h-legacy',
    });
    const filePath = writeJsonlFile(embDir, slug, [legacyLine]);
    writeIndex(embDir, { [slug]: filePath });

    const result = runGc(embDir, 90);
    expect(result.removed).toBe(0);

    const remaining = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(1);
  });

  it('provider filter restricts GC to matching entries', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slugSmall = 'openai-text-embedding-3-small-2024-01-25';
    const slugLarge = 'openai-text-embedding-3-large-2024-01-25';

    const oldSmall = makeJsonlEntry(
      'old-small',
      100,
      'openai-text-embedding-3-small',
      '2024-01-25',
    );
    const oldLarge = makeJsonlEntry(
      'old-large',
      100,
      'openai-text-embedding-3-large',
      '2024-01-25',
    );

    const smallPath = writeJsonlFile(embDir, slugSmall, [oldSmall]);
    const largePath = writeJsonlFile(embDir, slugLarge, [oldLarge]);
    writeIndex(embDir, { [slugSmall]: smallPath, [slugLarge]: largePath });

    // GC only the small-provider entries.
    const result = runGc(embDir, 90, 'openai-text-embedding-3-small');
    expect(result.removed).toBe(1);

    // small file should now be empty; large file should still have its entry.
    const smallRemaining = readFileSync(smallPath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const largeRemaining = readFileSync(largePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);

    expect(smallRemaining).toHaveLength(0);
    expect(largeRemaining).toHaveLength(1);
  });

  it('collectStats() reports per-(provider, modelVersion) counts and timestamps', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = writeJsonlFile(embDir, slug, [
      makeJsonlEntry('a', 5),
      makeJsonlEntry('b', 30),
      makeJsonlEntry('c', 60),
    ]);
    writeIndex(embDir, { [slug]: filePath });

    const stats = collectStats(embDir);

    expect(stats).toHaveLength(1);
    const row = stats[0]!;
    expect(row.provider).toBe('openai-text-embedding-3-small');
    expect(row.modelVersion).toBe('2024-01-25');
    expect(row.count).toBe(3);
    expect(row.oldestWrittenAt).not.toBeNull();
    expect(row.newestWrittenAt).not.toBeNull();
    expect(new Date(row.oldestWrittenAt!).getTime()).toBeLessThan(
      new Date(row.newestWrittenAt!).getTime(),
    );
  });

  it('atomic rewrite: only rewrites files when something was actually removed', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = writeJsonlFile(embDir, slug, [makeJsonlEntry('fresh', 5)]);
    writeIndex(embDir, { [slug]: filePath });

    const beforeContents = readFileSync(filePath, 'utf-8');

    const result = runGc(embDir, 90);
    expect(result.removed).toBe(0);

    // File should be byte-identical (no needless rewrite).
    const afterContents = readFileSync(filePath, 'utf-8');
    expect(afterContents).toBe(beforeContents);
  });
});
