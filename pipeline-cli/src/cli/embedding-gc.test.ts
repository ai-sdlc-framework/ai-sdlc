/**
 * Unit tests for cli-embedding-gc.
 *
 * Tests cover:
 *  AC#4  — cli-embedding-gc ships with mtime-based retention; per-org gcRetentionDays override
 *  AC#8  — GC removes >90d entries; tests verify retention boundary
 *  Iter 2 MAJOR #5 — CLI router (`runEmbeddingGcCli`) has direct coverage via
 *                    argv mutation. Mirrors the capture / classify-pr test
 *                    pattern (no spawn → no `pnpm build` dep in test loop).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGc, collectStats, runEmbeddingGcCli } from './embedding-gc.js';

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
    // Iter 2 MAJOR #4 fix: thread the cutoff in so we assert on the same Date
    // the GC runs against. Pre-fix, the test computed `cutoff` at one instant
    // and runGc() recomputed it later, causing a ~40% flake rate when the two
    // computations straddled a clock tick.
    const embDir = makeEmbeddingsDir(tmpDir);
    const slug = 'openai-text-embedding-3-small-2024-01-25';

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

    // Pass the SAME cutoff Date that produced `atBoundary.writtenAt` so
    // boundary comparison is exact.
    const result = runGc(embDir, 90, undefined, cutoff);

    // Only the just-before entry should be removed.
    expect(result.removed).toBe(1);
    const remaining = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]!).text).toBe('at-boundary');
  });

  it('handles empty embeddings directory gracefully (no JSONL files)', () => {
    const embDir = makeEmbeddingsDir(tmpDir);
    // No JSONL files written — directory walk should produce nothing.
    expect(existsSync(embDir)).toBe(true);

    const result = runGc(embDir, 90);
    expect(result).toEqual({ removed: 0, scanned: 0, filesProcessed: 0 });
  });

  it('handles missing embeddings directory gracefully', () => {
    // Dir doesn't exist at all.
    const result = runGc(join(tmpDir, 'nonexistent', '_embeddings'), 90);
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
    writeJsonlFile(embDir, slug, [
      makeJsonlEntry('a', 5),
      makeJsonlEntry('b', 30),
      makeJsonlEntry('c', 60),
    ]);

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

    const beforeContents = readFileSync(filePath, 'utf-8');

    const result = runGc(embDir, 90);
    expect(result.removed).toBe(0);

    // File should be byte-identical (no needless rewrite).
    const afterContents = readFileSync(filePath, 'utf-8');
    expect(afterContents).toBe(beforeContents);
  });
});

// ── CLI router tests (Iter 2 MAJOR #5) ────────────────────────────────────────
//
// These exercise `runEmbeddingGcCli()` (the yargs router) by mutating
// `process.argv` + capturing `process.stdout.write`. This pattern matches
// `capture.test.ts` and `classify-pr.test.ts` and is faster than spawn-based
// tests because it doesn't depend on `dist/` being built.

describe('runEmbeddingGcCli (yargs router coverage)', () => {
  let tmpDir: string;
  let savedArgv: string[];
  let savedStdout: typeof process.stdout.write;
  let stdoutChunks: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-338-cli-'));
    savedArgv = process.argv;
    savedStdout = process.stdout.write.bind(process.stdout);
    stdoutChunks = [];
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.stdout.write = savedStdout;
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setArgv(...args: string[]): void {
    process.argv = ['node', 'cli-embedding-gc', ...args];
  }

  function stdoutText(): string {
    return stdoutChunks.join('');
  }

  function stdoutJson<T = unknown>(): T {
    const text = stdoutText().trim();
    // Find the LAST JSON object/array printed.
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '}' || text[i] === ']') {
        const start = text.lastIndexOf(text[i] === '}' ? '{' : '[', i);
        if (start >= 0) {
          return JSON.parse(text.slice(start, i + 1)) as T;
        }
      }
    }
    throw new Error(`no JSON found in stdout: ${text}`);
  }

  function makeArtifactsDir(): string {
    const artifactsDir = join(tmpDir, 'artifacts');
    const embDir = join(artifactsDir, '_embeddings');
    mkdirSync(embDir, { recursive: true });
    return artifactsDir;
  }

  function seedJsonl(artifactsDir: string, slug: string, entries: string[]): string {
    const filePath = join(artifactsDir, '_embeddings', `${slug}.jsonl`);
    writeFileSync(filePath, entries.join('\n') + '\n', 'utf-8');
    return filePath;
  }

  // ── run subcommand ──────────────────────────────────────────────────────────

  it('run --dry-run (text format) reports the count without modifying files', async () => {
    const artifactsDir = makeArtifactsDir();
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = seedJsonl(artifactsDir, slug, [
      makeJsonlEntry('old', 100),
      makeJsonlEntry('fresh', 10),
    ]);
    const before = readFileSync(filePath, 'utf-8');

    setArgv('run', '--dry-run', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const out = stdoutText();
    expect(out).toMatch(/dry-run: would remove 1 of 2 entries/);
    expect(out).toMatch(/older than 90 days/);

    // File untouched.
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('run --dry-run --format json emits a JSON payload with wouldRemove', async () => {
    const artifactsDir = makeArtifactsDir();
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    seedJsonl(artifactsDir, slug, [
      makeJsonlEntry('old-1', 100),
      makeJsonlEntry('old-2', 95),
      makeJsonlEntry('fresh', 10),
    ]);

    setArgv('run', '--dry-run', '--format', 'json', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const payload = stdoutJson<{
      dryRun: boolean;
      wouldRemove: number;
      scanned: number;
      retentionDays: number;
    }>();
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldRemove).toBe(2);
    expect(payload.scanned).toBe(3);
    expect(payload.retentionDays).toBe(90);
  });

  it('run --dry-run with --provider scopes the dry-run scan to one provider', async () => {
    const artifactsDir = makeArtifactsDir();
    seedJsonl(artifactsDir, 'openai-text-embedding-3-small-2024-01-25', [
      makeJsonlEntry('old-small', 100, 'openai-text-embedding-3-small'),
    ]);
    seedJsonl(artifactsDir, 'openai-text-embedding-3-large-2024-01-25', [
      makeJsonlEntry('old-large', 100, 'openai-text-embedding-3-large'),
    ]);

    setArgv(
      'run',
      '--dry-run',
      '--format',
      'json',
      '--artifacts-dir',
      artifactsDir,
      '--provider',
      'openai-text-embedding-3-small',
    );
    await runEmbeddingGcCli();

    const payload = stdoutJson<{ wouldRemove: number; scanned: number }>();
    expect(payload.wouldRemove).toBe(1);
    expect(payload.scanned).toBe(2); // both files are scanned, filter narrows wouldRemove
  });

  it('run (apply mode, text format) removes stale entries and prints summary', async () => {
    const artifactsDir = makeArtifactsDir();
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    const filePath = seedJsonl(artifactsDir, slug, [
      makeJsonlEntry('old', 100),
      makeJsonlEntry('fresh', 10),
    ]);

    setArgv('run', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const out = stdoutText();
    expect(out).toMatch(/GC complete: removed 1 entries/);
    expect(out).toMatch(/scanned 2 across 1 file/);

    const surviving = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(surviving).toHaveLength(1);
    expect(JSON.parse(surviving[0]!).text).toBe('fresh');
  });

  it('run --format json emits a JSON payload with the result counts', async () => {
    const artifactsDir = makeArtifactsDir();
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    seedJsonl(artifactsDir, slug, [makeJsonlEntry('old', 100), makeJsonlEntry('fresh', 10)]);

    setArgv('run', '--format', 'json', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const payload = stdoutJson<{
      removed: number;
      scanned: number;
      filesProcessed: number;
      retentionDays: number;
    }>();
    expect(payload.removed).toBe(1);
    expect(payload.scanned).toBe(2);
    expect(payload.filesProcessed).toBe(1);
    expect(payload.retentionDays).toBe(90);
  });

  it('run with --retention-days override changes the cutoff', async () => {
    const artifactsDir = makeArtifactsDir();
    const slug = 'openai-text-embedding-3-small-2024-01-25';
    seedJsonl(artifactsDir, slug, [
      makeJsonlEntry('60d-old', 60), // retained at 90d, removed at 30d
      makeJsonlEntry('fresh', 5),
    ]);

    setArgv('run', '--format', 'json', '--artifacts-dir', artifactsDir, '--retention-days', '30');
    await runEmbeddingGcCli();

    const payload = stdoutJson<{ removed: number; retentionDays: number }>();
    expect(payload.removed).toBe(1);
    expect(payload.retentionDays).toBe(30);
  });

  it('run on missing _embeddings dir (text) prints a friendly message and exits 0', async () => {
    const artifactsDir = join(tmpDir, 'no-such-dir');
    setArgv('run', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    expect(stdoutText()).toMatch(/No _embeddings directory found at /);
    expect(stdoutText()).toMatch(/Nothing to GC/);
  });

  it('run on missing _embeddings dir (json) emits a zero-result payload', async () => {
    const artifactsDir = join(tmpDir, 'no-such-dir');
    setArgv('run', '--format', 'json', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const payload = stdoutJson<{
      removed: number;
      scanned: number;
      filesProcessed: number;
      embeddingsDir: string;
    }>();
    expect(payload.removed).toBe(0);
    expect(payload.scanned).toBe(0);
    expect(payload.filesProcessed).toBe(0);
    expect(payload.embeddingsDir).toContain('_embeddings');
  });

  // ── stats subcommand ────────────────────────────────────────────────────────

  it('stats (table) prints a header + one row per (provider, modelVersion)', async () => {
    const artifactsDir = makeArtifactsDir();
    seedJsonl(artifactsDir, 'openai-text-embedding-3-small-2024-01-25', [
      makeJsonlEntry('a', 5),
      makeJsonlEntry('b', 30),
    ]);
    seedJsonl(artifactsDir, 'openai-text-embedding-3-large-2024-01-25', [
      makeJsonlEntry('c', 5, 'openai-text-embedding-3-large'),
    ]);

    setArgv('stats', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const out = stdoutText();
    expect(out).toMatch(/Provider/);
    expect(out).toMatch(/ModelVersion/);
    expect(out).toMatch(/Count/);
    expect(out).toMatch(/openai-text-embedding-3-small/);
    expect(out).toMatch(/openai-text-embedding-3-large/);
  });

  it('stats --format json emits an array of per-file stats', async () => {
    const artifactsDir = makeArtifactsDir();
    seedJsonl(artifactsDir, 'openai-text-embedding-3-small-2024-01-25', [
      makeJsonlEntry('a', 5),
      makeJsonlEntry('b', 30),
      makeJsonlEntry('c', 60),
    ]);

    setArgv('stats', '--format', 'json', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const payload = stdoutJson<Array<{ provider: string; modelVersion: string; count: number }>>();
    expect(payload).toHaveLength(1);
    expect(payload[0]!.provider).toBe('openai-text-embedding-3-small');
    expect(payload[0]!.modelVersion).toBe('2024-01-25');
    expect(payload[0]!.count).toBe(3);
  });

  it('stats on missing _embeddings dir (text) prints a friendly message', async () => {
    const artifactsDir = join(tmpDir, 'no-such-dir');
    setArgv('stats', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    expect(stdoutText()).toMatch(/No _embeddings directory at /);
  });

  it('stats on missing _embeddings dir (json) emits []', async () => {
    const artifactsDir = join(tmpDir, 'no-such-dir');
    setArgv('stats', '--format', 'json', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    const payload = stdoutJson<unknown[]>();
    expect(payload).toEqual([]);
  });

  it('stats on empty _embeddings dir prints "No embedding files found"', async () => {
    const artifactsDir = makeArtifactsDir();
    setArgv('stats', '--artifacts-dir', artifactsDir);
    await runEmbeddingGcCli();

    expect(stdoutText()).toMatch(/No embedding files found/);
  });
});
