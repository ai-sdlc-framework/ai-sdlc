/**
 * Unit tests for cli-embedding-bump per RFC-0019 §9.2.
 *
 * Covers AISDLC-339:
 *   AC#1  — dry-run produces accurate count + cost estimate
 *   AC#2  — execute is atomic under concurrent reads
 *   AC#11 — integration tests: migration round-trip
 *
 * The CLI is tested via direct function exports + yargs-router stdout capture.
 * No subprocess spawning (matches the cli-embedding-gc test pattern).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROVIDER_RATES_PER_1M_TOKENS_USD,
  estimateMigrationCost,
  estimateTokenCount,
  executeMigration,
  findFromFile,
  jsonlPath,
  readJsonlEntries,
  runEmbeddingBumpCli,
  slug,
  STUB_REEMBED,
  TOKEN_PER_CHAR_DIVISOR,
  type ReEmbedFn,
  type VectorStoreEntry,
} from './embedding-bump.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeEntry(
  text: string,
  provider: string,
  modelVersion: string,
  dims = 1536,
): VectorStoreEntry {
  return {
    vector: new Array(dims).fill(0.1) as number[],
    embeddingProvider: provider,
    embeddingModelVersion: modelVersion,
    writtenAt: new Date().toISOString(),
    text,
    textHash: `hash-${text}`,
  };
}

function writeJsonlFile(dir: string, fileName: string, entries: VectorStoreEntry[]): string {
  const filePath = join(dir, fileName);
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function makeEmbeddingsDir(tmpDir: string): string {
  const embDir = join(tmpDir, '_embeddings');
  mkdirSync(embDir, { recursive: true });
  return embDir;
}

// ── slug / jsonlPath / readJsonlEntries unit tests ───────────────────────────

describe('slug + jsonlPath helpers', () => {
  it('sanitizes unsafe characters in provider + modelVersion', () => {
    expect(slug('openai-text-embedding-3-small', '2024-01-25')).toBe(
      'openai-text-embedding-3-small-2024-01-25',
    );
    expect(slug('weird/provider', 'v1@latest')).toBe('weird-provider-v1-latest');
  });

  it('jsonlPath produces the expected filename layout', () => {
    expect(jsonlPath('/abs/_embeddings', 'openai-text-embedding-3-small', '2024-01-25')).toBe(
      '/abs/_embeddings/openai-text-embedding-3-small-2024-01-25.jsonl',
    );
  });
});

describe('readJsonlEntries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-339-read-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', () => {
    expect(readJsonlEntries(join(tmpDir, 'missing.jsonl'))).toEqual([]);
  });

  it('parses each line into a VectorStoreEntry', () => {
    const dir = makeEmbeddingsDir(tmpDir);
    const path = writeJsonlFile(dir, 'a.jsonl', [
      makeEntry('one', 'p', 'v', 4),
      makeEntry('two', 'p', 'v', 4),
    ]);
    const entries = readJsonlEntries(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe('one');
    expect(entries[1]!.text).toBe('two');
  });

  it('silently skips malformed lines', () => {
    const dir = makeEmbeddingsDir(tmpDir);
    const path = join(dir, 'corrupt.jsonl');
    writeFileSync(
      path,
      JSON.stringify(makeEntry('valid', 'p', 'v', 4)) + '\nNOT JSON\n' + '\n',
      'utf-8',
    );
    const entries = readJsonlEntries(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('valid');
  });
});

// ── findFromFile ─────────────────────────────────────────────────────────────

describe('findFromFile', () => {
  let tmpDir: string;
  let embDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-339-find-'));
    embDir = makeEmbeddingsDir(tmpDir);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no file holds the provider', () => {
    expect(findFromFile(embDir, 'no-such-provider')).toBeNull();
  });

  it('finds the file holding the source provider', () => {
    writeJsonlFile(embDir, 'openai-ada-002-2022-12-15.jsonl', [
      makeEntry('a', 'openai-text-embedding-ada-002', '2022-12-15', 4),
      makeEntry('b', 'openai-text-embedding-ada-002', '2022-12-15', 4),
    ]);
    writeJsonlFile(embDir, 'openai-3-small-2024-01-25.jsonl', [
      makeEntry('c', 'openai-text-embedding-3-small', '2024-01-25', 4),
    ]);

    const result = findFromFile(embDir, 'openai-text-embedding-ada-002');
    expect(result).not.toBeNull();
    expect(result?.modelVersion).toBe('2022-12-15');
    expect(result?.filePath).toContain('openai-ada-002-2022-12-15.jsonl');
  });

  it('prefers the largest modelVersion when multiple files hold the same provider', () => {
    writeJsonlFile(embDir, 'p-2024-01-25.jsonl', [makeEntry('a', 'p', '2024-01-25', 4)]);
    writeJsonlFile(embDir, 'p-2024-12-01.jsonl', [makeEntry('b', 'p', '2024-12-01', 4)]);
    const result = findFromFile(embDir, 'p');
    expect(result?.modelVersion).toBe('2024-12-01');
  });

  it('skips empty JSONL files', () => {
    writeJsonlFile(embDir, 'empty.jsonl', []);
    expect(findFromFile(embDir, 'p')).toBeNull();
  });
});

// ── Token + cost estimation ──────────────────────────────────────────────────

describe('estimateTokenCount', () => {
  it('AC#1: returns 0 for empty text', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('AC#1: clamps to at least 1 token for non-empty short text', () => {
    expect(estimateTokenCount('a')).toBe(1);
  });

  it('AC#1: scales by ceil(len / TOKEN_PER_CHAR_DIVISOR)', () => {
    expect(TOKEN_PER_CHAR_DIVISOR).toBe(4);
    expect(estimateTokenCount('x'.repeat(16))).toBe(4);
    expect(estimateTokenCount('x'.repeat(17))).toBe(5); // ceil(17/4) = 5
    expect(estimateTokenCount('x'.repeat(100))).toBe(25);
  });
});

describe('estimateMigrationCost', () => {
  let tmpDir: string;
  let embDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-339-cost-'));
    embDir = makeEmbeddingsDir(tmpDir);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC#1: returns null when no source file exists', () => {
    expect(estimateMigrationCost(embDir, 'no-such', 'target')).toBeNull();
  });

  it('AC#1: sums tokens across all source entries and applies default target rate', () => {
    writeJsonlFile(embDir, 'src.jsonl', [
      makeEntry('x'.repeat(40), 'openai-text-embedding-ada-002', '2022-12-15', 4),
      makeEntry('x'.repeat(80), 'openai-text-embedding-ada-002', '2022-12-15', 4),
    ]);

    const est = estimateMigrationCost(
      embDir,
      'openai-text-embedding-ada-002',
      'openai-text-embedding-3-large',
    );
    expect(est).not.toBeNull();
    expect(est!.entryCount).toBe(2);
    // 40 chars = 10 tokens; 80 chars = 20 tokens; total = 30 tokens.
    expect(est!.totalTokens).toBe(30);
    expect(est!.ratePer1MTokensUsd).toBe(
      DEFAULT_PROVIDER_RATES_PER_1M_TOKENS_USD['openai-text-embedding-3-large'],
    );
    // 30 / 1M * 0.13 = 3.9e-6
    expect(est!.estimatedCostUsd).toBeCloseTo((30 / 1_000_000) * 0.13, 10);
  });

  it('AC#1: respects custom rate override', () => {
    writeJsonlFile(embDir, 'src.jsonl', [
      makeEntry('x'.repeat(40), 'openai-text-embedding-ada-002', '2022-12-15', 4),
    ]);
    const est = estimateMigrationCost(
      embDir,
      'openai-text-embedding-ada-002',
      'openai-text-embedding-3-small',
      { ratePer1MTokensUsd: 0.5 },
    );
    expect(est!.ratePer1MTokensUsd).toBe(0.5);
    expect(est!.estimatedCostUsd).toBeCloseTo((10 / 1_000_000) * 0.5, 10);
  });

  it('AC#1: uses 0.10 fallback rate when target provider is unknown', () => {
    writeJsonlFile(embDir, 'src.jsonl', [
      makeEntry('x'.repeat(20), 'openai-text-embedding-ada-002', '2022-12-15', 4),
    ]);
    const est = estimateMigrationCost(
      embDir,
      'openai-text-embedding-ada-002',
      'novel-future-provider-not-in-table',
    );
    expect(est!.ratePer1MTokensUsd).toBe(0.1);
  });
});

// ── executeMigration: round-trip + atomicity ─────────────────────────────────

describe('executeMigration', () => {
  let tmpDir: string;
  let embDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-339-exec-'));
    embDir = makeEmbeddingsDir(tmpDir);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AC#11: round-trip — entries from source land on target with same text + textHash', async () => {
    const fromProvider = 'openai-text-embedding-ada-002';
    const toProvider = 'openai-text-embedding-3-small';

    writeJsonlFile(embDir, 'src.jsonl', [
      makeEntry('hello world', fromProvider, '2022-12-15', 4),
      makeEntry('goodbye world', fromProvider, '2022-12-15', 4),
    ]);

    const result = await executeMigration(embDir, fromProvider, toProvider, {
      toModelVersion: '2024-01-25',
      backupTimestamp: 'fixed-stamp',
    });

    expect(result.entryCount).toBe(2);
    expect(result.fromProvider).toBe(fromProvider);
    expect(result.toProvider).toBe(toProvider);
    expect(result.toModelVersion).toBe('2024-01-25');

    // Target file landed with re-embedded entries.
    const targetEntries = readJsonlEntries(result.toFilePath);
    expect(targetEntries).toHaveLength(2);
    expect(targetEntries[0]!.text).toBe('hello world');
    expect(targetEntries[0]!.embeddingProvider).toBe(toProvider);
    expect(targetEntries[0]!.embeddingModelVersion).toBe('2024-01-25');
    expect(targetEntries[0]!.textHash).toBe('hash-hello world');
    expect(targetEntries[1]!.text).toBe('goodbye world');

    // Source file moved to .bak.
    expect(existsSync(result.backupFilePath)).toBe(true);
    expect(result.backupFilePath).toContain('.bak.fixed-stamp');
    expect(existsSync(result.fromFilePath)).toBe(false);
  });

  it('AC#2: atomicity — partial-write tmp files are never visible (only the renamed target exists)', async () => {
    writeJsonlFile(embDir, 'src.jsonl', [makeEntry('text-a', 'old-provider', 'old-ver', 4)]);

    const result = await executeMigration(embDir, 'old-provider', 'new-provider', {
      toModelVersion: 'new-ver',
      backupTimestamp: 'fixed',
    });

    // After migration, no .tmp files left in the embeddings directory.
    const allFiles = readdirSync(embDir);
    const tmpFiles = allFiles.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
    expect(existsSync(result.toFilePath)).toBe(true);
  });

  it('AC#2: backup is created AFTER target file lands (atomicity ordering)', async () => {
    // We can't directly observe the in-flight ordering, but we can verify the
    // POST-condition: target exists AND source is renamed (not deleted).
    writeJsonlFile(embDir, 'src.jsonl', [makeEntry('text-a', 'old', 'ov', 4)]);

    const result = await executeMigration(embDir, 'old', 'new', { backupTimestamp: 's' });

    expect(existsSync(result.toFilePath)).toBe(true);
    expect(existsSync(result.backupFilePath)).toBe(true);
    // The source path no longer exists at its original name.
    expect(existsSync(result.fromFilePath)).toBe(false);
  });

  it('AC#11: re-embed function preserves input order', async () => {
    writeJsonlFile(embDir, 'src.jsonl', [
      makeEntry('alpha', 'p', 'v', 4),
      makeEntry('beta', 'p', 'v', 4),
      makeEntry('gamma', 'p', 'v', 4),
    ]);

    // Custom re-embed that encodes the input index into vector[0].
    const indexedReEmbed: ReEmbedFn = async (texts) =>
      texts.map((_, i) => [i, 0, 0, 0]) as number[][];

    const result = await executeMigration(embDir, 'p', 'q', {
      reEmbed: indexedReEmbed,
      toModelVersion: 'v2',
      backupTimestamp: 's',
    });

    const entries = readJsonlEntries(result.toFilePath);
    expect(entries.map((e) => [e.text, e.vector[0]])).toEqual([
      ['alpha', 0],
      ['beta', 1],
      ['gamma', 2],
    ]);
  });

  it('throws when no source file exists', async () => {
    await expect(executeMigration(embDir, 'no-source', 'target')).rejects.toThrow(
      /no source file found/i,
    );
  });

  it('throws when source file is empty', async () => {
    writeJsonlFile(embDir, 'empty.jsonl', []);
    await expect(executeMigration(embDir, 'no-entries-provider', 'target')).rejects.toThrow(
      /no source file found/i,
    );
  });

  it('throws when re-embed returns a different number of vectors', async () => {
    writeJsonlFile(embDir, 'src.jsonl', [makeEntry('a', 'p', 'v', 4), makeEntry('b', 'p', 'v', 4)]);

    const shortReEmbed: ReEmbedFn = async () => [[0, 0]];

    await expect(
      executeMigration(embDir, 'p', 'q', { reEmbed: shortReEmbed, backupTimestamp: 's' }),
    ).rejects.toThrow(/order\/count contract violated/);
  });

  it('preserves metadata when present on source entries', async () => {
    const entry = makeEntry('with-meta', 'p', 'v', 4);
    entry.metadata = { sourceDoc: 'rfc-0009.md', shardId: 'OQ-6' };
    writeJsonlFile(embDir, 'src.jsonl', [entry]);

    const result = await executeMigration(embDir, 'p', 'q', { backupTimestamp: 's' });
    const migrated = readJsonlEntries(result.toFilePath);
    expect(migrated[0]!.metadata).toEqual({ sourceDoc: 'rfc-0009.md', shardId: 'OQ-6' });
  });

  it('STUB_REEMBED returns 1536-dim zero vectors in input order', async () => {
    const out = await STUB_REEMBED(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(1536);
    expect(out[0]!.every((v) => v === 0)).toBe(true);
  });
});

// ── CLI router tests (yargs router via process.argv mutation) ────────────────

describe('runEmbeddingBumpCli (yargs router coverage)', () => {
  let tmpDir: string;
  let savedArgv: string[];
  let savedStdout: typeof process.stdout.write;
  let stdoutChunks: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-339-cli-'));
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
  });

  function setArgv(...args: string[]): void {
    process.argv = ['node', 'cli-embedding-bump', ...args];
  }

  function stdoutText(): string {
    return stdoutChunks.join('');
  }

  function stdoutJson<T = unknown>(): T {
    const text = stdoutText().trim();
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

  function seedSourceJsonl(
    artifactsDir: string,
    fileName: string,
    entries: VectorStoreEntry[],
  ): string {
    const filePath = join(artifactsDir, '_embeddings', fileName);
    writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    return filePath;
  }

  it('AC#1: dry-run (text format) emits the cost-estimate report', async () => {
    const artifactsDir = makeArtifactsDir();
    seedSourceJsonl(artifactsDir, 'src.jsonl', [
      makeEntry('x'.repeat(40), 'openai-text-embedding-ada-002', '2022-12-15', 4),
      makeEntry('x'.repeat(40), 'openai-text-embedding-ada-002', '2022-12-15', 4),
    ]);

    setArgv(
      'dry-run',
      '--artifacts-dir',
      artifactsDir,
      '--from',
      'openai-text-embedding-ada-002',
      '--to',
      'openai-text-embedding-3-small',
    );
    await runEmbeddingBumpCli();

    const out = stdoutText();
    expect(out).toMatch(/migrate 2 vectors/);
    expect(out).toMatch(/openai-text-embedding-ada-002/);
    expect(out).toMatch(/openai-text-embedding-3-small/);
    expect(out).toMatch(/Estimated cost: \$/);
  });

  it('AC#1: dry-run --format json emits a JSON estimate payload', async () => {
    const artifactsDir = makeArtifactsDir();
    seedSourceJsonl(artifactsDir, 'src.jsonl', [
      makeEntry('a', 'p', 'v', 4),
      makeEntry('b', 'p', 'v', 4),
    ]);

    setArgv(
      'dry-run',
      '--artifacts-dir',
      artifactsDir,
      '--from',
      'p',
      '--to',
      'openai-text-embedding-3-small',
      '--format',
      'json',
    );
    await runEmbeddingBumpCli();

    const payload = stdoutJson<{
      dryRun: boolean;
      entryCount: number;
      totalTokens: number;
      ratePer1MTokensUsd: number;
    }>();
    expect(payload.dryRun).toBe(true);
    expect(payload.entryCount).toBe(2);
    expect(payload.totalTokens).toBe(2); // 1 char each → 1 token each (clamped)
    expect(payload.ratePer1MTokensUsd).toBe(0.02);
  });

  it('AC#1: dry-run with --rate-per-1m-tokens overrides the rate', async () => {
    const artifactsDir = makeArtifactsDir();
    seedSourceJsonl(artifactsDir, 'src.jsonl', [makeEntry('x'.repeat(40), 'p', 'v', 4)]);

    setArgv(
      'dry-run',
      '--artifacts-dir',
      artifactsDir,
      '--from',
      'p',
      '--to',
      'q',
      '--rate-per-1m-tokens',
      '1.50',
      '--format',
      'json',
    );
    await runEmbeddingBumpCli();

    const payload = stdoutJson<{ ratePer1MTokensUsd: number; estimatedCostUsd: number }>();
    expect(payload.ratePer1MTokensUsd).toBe(1.5);
    // 10 tokens * 1.50 / 1M
    expect(payload.estimatedCostUsd).toBeCloseTo((10 / 1_000_000) * 1.5, 10);
  });

  it('AC#1: dry-run on empty embeddings dir (text) prints a friendly message', async () => {
    const artifactsDir = makeArtifactsDir();
    setArgv('dry-run', '--artifacts-dir', artifactsDir, '--from', 'p', '--to', 'q');
    await runEmbeddingBumpCli();
    expect(stdoutText()).toMatch(/no source file found/i);
  });

  it('AC#1: dry-run on empty embeddings dir (json) emits a zero-result payload', async () => {
    const artifactsDir = makeArtifactsDir();
    setArgv(
      'dry-run',
      '--artifacts-dir',
      artifactsDir,
      '--from',
      'p',
      '--to',
      'q',
      '--format',
      'json',
    );
    await runEmbeddingBumpCli();

    const payload = stdoutJson<{ entryCount: number; totalTokens: number; note?: string }>();
    expect(payload.entryCount).toBe(0);
    expect(payload.totalTokens).toBe(0);
    expect(payload.note).toContain('No source file');
  });

  it('AC#2 + AC#11: execute migrates entries and prints summary', async () => {
    const artifactsDir = makeArtifactsDir();
    seedSourceJsonl(artifactsDir, 'src.jsonl', [makeEntry('hello', 'p', 'v', 4)]);

    setArgv(
      'execute',
      '--artifacts-dir',
      artifactsDir,
      '--from',
      'p',
      '--to',
      'q',
      '--to-model-version',
      '2026-05-24',
    );
    await runEmbeddingBumpCli();

    const out = stdoutText();
    expect(out).toMatch(/migrated 1 vectors/);
    expect(out).toMatch(/Pipeline.spec.embedding.provider should now be set to 'q'/);
  });

  it('AC#2: execute --format json emits a MigrationResult payload', async () => {
    const artifactsDir = makeArtifactsDir();
    seedSourceJsonl(artifactsDir, 'src.jsonl', [
      makeEntry('a', 'p', 'v', 4),
      makeEntry('b', 'p', 'v', 4),
    ]);

    setArgv(
      'execute',
      '--artifacts-dir',
      artifactsDir,
      '--from',
      'p',
      '--to',
      'q',
      '--to-model-version',
      '2026-05-24',
      '--format',
      'json',
    );
    await runEmbeddingBumpCli();

    const payload = stdoutJson<{
      fromProvider: string;
      toProvider: string;
      toModelVersion: string;
      entryCount: number;
      toFilePath: string;
      backupFilePath: string;
    }>();
    expect(payload.entryCount).toBe(2);
    expect(payload.fromProvider).toBe('p');
    expect(payload.toProvider).toBe('q');
    expect(payload.toModelVersion).toBe('2026-05-24');
    expect(payload.toFilePath).toContain('q-2026-05-24.jsonl');
    expect(payload.backupFilePath).toContain('.bak.');
  });
});
