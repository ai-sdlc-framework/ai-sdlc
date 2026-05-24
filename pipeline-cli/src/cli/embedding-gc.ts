/**
 * `cli-embedding-gc` — embedding storage garbage-collection CLI per RFC-0019 §8.2.
 *
 * Removes stale vector store entries from the JSONL backend at
 * `<artifactsDir>/_embeddings/*.jsonl` based on their `writtenAt` timestamp.
 *
 * Default retention: 90 days (matches RFC-0019 §8.2 GC-by-mtime spec).
 * Per-org override: `--retention-days <N>` (maps to `gcRetentionDays` in
 * the embedding config per §15.1).
 *
 * Subcommands:
 *   run      — run GC, remove entries older than retention threshold (default)
 *   stats    — show entry counts + oldest entry per provider/version (dry-run friendly)
 *
 * Usage:
 *   node pipeline-cli/bin/cli-embedding-gc.mjs run \
 *     --artifacts-dir /path/to/.ai-sdlc/artifacts \
 *     --retention-days 90
 *
 *   node pipeline-cli/bin/cli-embedding-gc.mjs stats \
 *     --artifacts-dir /path/to/.ai-sdlc/artifacts
 *
 * Exit codes:
 *   0 — GC completed (even if 0 entries removed)
 *   1 — Error (missing artifacts dir, corrupted index, etc.)
 *
 * Note: This CLI is self-contained and does NOT import @ai-sdlc/orchestrator
 * (pipeline-cli is orchestrator-free by design). The GC logic is implemented
 * directly here using the same JSONL file layout conventions.
 *
 * @module cli/embedding-gc
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ── Internal types (mirrors orchestrator/src/embedding/storage/types.ts) ─────

/** Minimal VectorStoreEntry shape for GC purposes. */
interface VectorStoreEntry {
  embeddingProvider?: string;
  embeddingModelVersion?: string;
  writtenAt?: string;
  textHash?: string;
  [key: string]: unknown;
}

/** Index file format (mirrors orchestrator/src/embedding/storage/jsonl-backend.ts). */
interface EmbeddingIndex {
  entries: Record<string, string>;
  updatedAt: string;
}

// ── GC logic ─────────────────────────────────────────────────────────────────

function readIndex(embeddingsDir: string): EmbeddingIndex {
  const indexPath = join(embeddingsDir, '_index.json');
  if (!existsSync(indexPath)) {
    return { entries: {}, updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as EmbeddingIndex;
  } catch {
    return { entries: {}, updatedAt: new Date().toISOString() };
  }
}

/** Run GC over all JSONL files in the embeddings directory. */
export function runGc(
  embeddingsDir: string,
  retentionDays: number,
  provider?: string,
): { removed: number; scanned: number; filesProcessed: number } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const index = readIndex(embeddingsDir);
  let removed = 0;
  let scanned = 0;
  let filesProcessed = 0;

  for (const [slug, filePath] of Object.entries(index.entries)) {
    if (!existsSync(filePath)) continue;

    filesProcessed++;
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    const surviving: string[] = [];
    for (const line of lines) {
      scanned++;
      try {
        const entry = JSON.parse(line) as VectorStoreEntry;

        // Apply provider filter if specified.
        if (provider && entry.embeddingProvider !== provider) {
          surviving.push(line);
          continue;
        }

        if (!entry.writtenAt) {
          // Entry without writtenAt is considered legacy/corrupt — keep it (don't drop silently).
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
      // Rewrite atomically only when something changed.
      const tmp = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmp, surviving.join('\n') + (surviving.length > 0 ? '\n' : ''), 'utf-8');
      renameSync(tmp, filePath);
    }

    void slug;
  }

  return { removed, scanned, filesProcessed };
}

/** Collect stats per (provider, modelVersion) without modifying anything. */
export function collectStats(embeddingsDir: string): Array<{
  provider: string;
  modelVersion: string;
  count: number;
  oldestWrittenAt: string | null;
  newestWrittenAt: string | null;
  filePath: string;
}> {
  const index = readIndex(embeddingsDir);
  const results: ReturnType<typeof collectStats> = [];

  for (const [_slug, filePath] of Object.entries(index.entries)) {
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    let count = 0;
    let oldestWrittenAt: string | null = null;
    let newestWrittenAt: string | null = null;
    let provider = '(unknown)';
    let modelVersion = '(unknown)';

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as VectorStoreEntry;
        count++;
        if (entry.embeddingProvider) provider = entry.embeddingProvider;
        if (entry.embeddingModelVersion) modelVersion = entry.embeddingModelVersion;

        if (entry.writtenAt) {
          if (!oldestWrittenAt || entry.writtenAt < oldestWrittenAt) {
            oldestWrittenAt = entry.writtenAt;
          }
          if (!newestWrittenAt || entry.writtenAt > newestWrittenAt) {
            newestWrittenAt = entry.writtenAt;
          }
        }
      } catch {
        // skip
      }
    }

    results.push({ provider, modelVersion, count, oldestWrittenAt, newestWrittenAt, filePath });
  }

  return results;
}

// ── CLI router ────────────────────────────────────────────────────────────────

export async function runEmbeddingGcCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('cli-embedding-gc')
    .usage('$0 <command> [options]')
    .command(
      ['run', '$0'],
      'Remove vector store entries older than the retention threshold',
      (y) =>
        y
          .option('artifacts-dir', {
            alias: 'a',
            type: 'string',
            description: 'Path to the artifacts directory (contains _embeddings/)',
            default: process.env.ARTIFACTS_DIR ?? '.ai-sdlc/artifacts',
          })
          .option('retention-days', {
            alias: 'r',
            type: 'number',
            description: 'Number of days to retain entries (default: 90)',
            default: 90,
          })
          .option('provider', {
            alias: 'p',
            type: 'string',
            description: 'Restrict GC to entries from this embedding provider',
          })
          .option('dry-run', {
            alias: 'd',
            type: 'boolean',
            description: 'Print what would be removed without modifying files',
            default: false,
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text',
            description: 'Output format',
          }),
      async (args) => {
        const embeddingsDir = join(args['artifacts-dir'], '_embeddings');

        if (!existsSync(embeddingsDir)) {
          if (args.format === 'json') {
            process.stdout.write(
              JSON.stringify(
                { removed: 0, scanned: 0, filesProcessed: 0, embeddingsDir },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(
              `[cli-embedding-gc] No _embeddings directory found at ${embeddingsDir}. Nothing to GC.\n`,
            );
          }
          return;
        }

        if (args['dry-run']) {
          // In dry-run mode, collect stats and show what WOULD be removed.
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - args['retention-days']);

          const index = readIndex(embeddingsDir);
          let wouldRemove = 0;
          let scanned = 0;

          for (const [_slug, filePath] of Object.entries(index.entries)) {
            if (!existsSync(filePath)) continue;
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            for (const line of lines) {
              scanned++;
              try {
                const entry = JSON.parse(line) as VectorStoreEntry;
                if (args.provider && entry.embeddingProvider !== args.provider) continue;
                if (entry.writtenAt && new Date(entry.writtenAt) < cutoff) wouldRemove++;
              } catch {
                // skip
              }
            }
          }

          if (args.format === 'json') {
            process.stdout.write(
              JSON.stringify(
                { dryRun: true, wouldRemove, scanned, retentionDays: args['retention-days'] },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(
              `[cli-embedding-gc] dry-run: would remove ${wouldRemove} of ${scanned} entries ` +
                `(older than ${args['retention-days']} days)\n`,
            );
          }
          return;
        }

        const result = runGc(embeddingsDir, args['retention-days'], args.provider);

        if (args.format === 'json') {
          process.stdout.write(
            JSON.stringify({ ...result, retentionDays: args['retention-days'] }, null, 2) + '\n',
          );
        } else {
          process.stdout.write(
            `[cli-embedding-gc] GC complete: removed ${result.removed} entries ` +
              `(scanned ${result.scanned} across ${result.filesProcessed} file(s), ` +
              `retention: ${args['retention-days']} days)\n`,
          );
        }
      },
    )
    .command(
      'stats',
      'Show entry counts and timestamps per provider/version (read-only)',
      (y) =>
        y
          .option('artifacts-dir', {
            alias: 'a',
            type: 'string',
            description: 'Path to the artifacts directory (contains _embeddings/)',
            default: process.env.ARTIFACTS_DIR ?? '.ai-sdlc/artifacts',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table',
            description: 'Output format',
          }),
      (args) => {
        const embeddingsDir = join(args['artifacts-dir'], '_embeddings');

        if (!existsSync(embeddingsDir)) {
          if (args.format === 'json') {
            process.stdout.write(JSON.stringify([]) + '\n');
          } else {
            process.stdout.write(
              `[cli-embedding-gc] No _embeddings directory at ${embeddingsDir}\n`,
            );
          }
          return;
        }

        const stats = collectStats(embeddingsDir);

        if (args.format === 'json') {
          process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
          return;
        }

        if (stats.length === 0) {
          process.stdout.write('[cli-embedding-gc] No embedding files found.\n');
          return;
        }

        // Table output.
        const header = ['Provider', 'ModelVersion', 'Count', 'OldestEntry', 'NewestEntry'];
        const rows = stats.map((s) => [
          s.provider,
          s.modelVersion,
          String(s.count),
          s.oldestWrittenAt?.slice(0, 10) ?? '(none)',
          s.newestWrittenAt?.slice(0, 10) ?? '(none)',
        ]);

        const widths = header.map((h, i) =>
          Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
        );

        const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');

        process.stdout.write(fmt(header) + '\n');
        process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
        for (const row of rows) {
          process.stdout.write(fmt(row) + '\n');
        }
      },
    )
    .demandCommand(0)
    .help()
    .strict()
    .parseAsync();

  void argv;
}
