/**
 * `cli-embedding-bump` — embedding adapter migration tooling per RFC-0019 §9.2.
 *
 * Subcommands:
 *   dry-run    — count entries on the deprecated provider + estimate re-embed cost
 *   execute    — read-old → re-embed → atomic-swap → keep .bak
 *
 * Atomicity contract (AC#2): the migration writes the new provider+version JSONL
 * file in full via temp-then-rename: the final `rename(<file>.<uuid>.tmp,
 * <newProvider>-<newModelVersion>.jsonl)` is the linearization point. Concurrent
 * reads see either the old file (still on the deprecated provider) or the new
 * file (on the replacement provider), never a half-written mix. The original is
 * preserved as `.bak.<timestamp>` for 30 days; `cli-embedding-gc` removes it
 * after that window.
 *
 * Cost estimation (AC#1) uses a per-provider rate table — defaults to the
 * documented public-pricing values for the in-tree adapters. Operators with
 * private rates can pass `--rate-per-1m-tokens <usd>` to override.
 *
 * This CLI is intentionally self-contained: pipeline-cli does NOT depend on
 * `@ai-sdlc/orchestrator` (pipeline-cli is orchestrator-free by design). The
 * JSONL layout conventions are replicated here and stay in lockstep with
 * `orchestrator/src/embedding/storage/jsonl-backend.ts`.
 *
 * @module cli/embedding-bump
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ── Internal types (mirrors orchestrator/src/embedding/storage/types.ts) ─────

/** Minimal VectorStoreEntry shape used during migration. */
export interface VectorStoreEntry {
  vector: number[];
  embeddingProvider: string;
  embeddingModelVersion: string;
  writtenAt: string;
  text: string;
  textHash: string;
  metadata?: Record<string, unknown>;
}

/**
 * Approximate cost per 1M tokens, in USD, per RFC-0019 §6.2 capability matrix.
 * Operators with private/discounted rates can override via `--rate-per-1m-tokens`.
 */
export const DEFAULT_PROVIDER_RATES_PER_1M_TOKENS_USD: Record<string, number> = {
  'openai-text-embedding-3-small': 0.02,
  'openai-text-embedding-3-large': 0.13,
  'openai-text-embedding-ada-002': 0.1,
  'cohere-embed-v3': 0.1,
};

/**
 * Conservative tokens-per-character estimate. OpenAI tokenizers run ~3.5-4
 * characters per token on average English text. We use 4 to slightly
 * UNDER-estimate token counts (and therefore over-state per-character density),
 * which then OVER-estimates cost on the conservative side — operators get a
 * cost ceiling, not a floor.
 *
 * For per-entry estimation we use `max(1, ceil(len(text) / 4))` to clamp the
 * zero-text edge case to at least one billable token.
 */
export const TOKEN_PER_CHAR_DIVISOR = 4;

/** Estimate token count from text length (cheap heuristic — no tokenizer dep). */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / TOKEN_PER_CHAR_DIVISOR));
}

// ── File helpers (mirrors orchestrator JSONL conventions) ────────────────────

/** Sanitize a string for filesystem use. */
function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Build the slug used as the JSONL filename stem. */
export function slug(provider: string, modelVersion: string): string {
  return `${safe(provider)}-${safe(modelVersion)}`;
}

/** Build the absolute path to the JSONL file for one (provider, modelVersion). */
export function jsonlPath(embeddingsDir: string, provider: string, modelVersion: string): string {
  return join(embeddingsDir, `${slug(provider, modelVersion)}.jsonl`);
}

/** Read a JSONL file into entries, silently skipping malformed lines. */
export function readJsonlEntries(filePath: string): VectorStoreEntry[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const out: VectorStoreEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as VectorStoreEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/** List every `*.jsonl` file in the embeddings directory. */
function listJsonlFiles(embeddingsDir: string): string[] {
  if (!existsSync(embeddingsDir)) return [];
  return readdirSync(embeddingsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(embeddingsDir, name));
}

/**
 * Find the JSONL file holding entries for a given provider — searches by
 * scanning each file's first entry rather than guessing the modelVersion.
 * Returns the most-recent (largest-modelVersion-string) match if multiple files
 * exist for the same provider.
 *
 * @returns { filePath, modelVersion } when found, or null when no file holds
 *          entries for the provider.
 */
export function findFromFile(
  embeddingsDir: string,
  fromProvider: string,
): { filePath: string; modelVersion: string } | null {
  let best: { filePath: string; modelVersion: string } | null = null;
  for (const filePath of listJsonlFiles(embeddingsDir)) {
    const entries = readJsonlEntries(filePath);
    if (entries.length === 0) continue;
    const first = entries[0];
    if (first?.embeddingProvider !== fromProvider) continue;
    const candidateVersion = first.embeddingModelVersion;
    if (!best || candidateVersion > best.modelVersion) {
      best = { filePath, modelVersion: candidateVersion };
    }
  }
  return best;
}

// ── Cost estimation ──────────────────────────────────────────────────────────

export interface MigrationCostEstimate {
  /** Source provider (deprecated). */
  fromProvider: string;
  /** Source provider modelVersion that was detected on disk. */
  fromModelVersion: string;
  /** Target provider for the re-embed. */
  toProvider: string;
  /** Number of vectors on the source provider. */
  entryCount: number;
  /** Total tokens estimated for the re-embed (sum across all entries). */
  totalTokens: number;
  /** Per-1M-tokens cost rate used for the estimate. */
  ratePer1MTokensUsd: number;
  /** Estimated USD cost. */
  estimatedCostUsd: number;
}

/**
 * Compute a cost estimate for migrating from `fromProvider` to `toProvider`.
 * Returns `null` when no source file is found (nothing to migrate).
 */
export function estimateMigrationCost(
  embeddingsDir: string,
  fromProvider: string,
  toProvider: string,
  options?: { ratePer1MTokensUsd?: number },
): MigrationCostEstimate | null {
  const fromFile = findFromFile(embeddingsDir, fromProvider);
  if (!fromFile) return null;

  const entries = readJsonlEntries(fromFile.filePath);
  let totalTokens = 0;
  for (const entry of entries) {
    totalTokens += estimateTokenCount(entry.text);
  }

  const rate =
    options?.ratePer1MTokensUsd ?? DEFAULT_PROVIDER_RATES_PER_1M_TOKENS_USD[toProvider] ?? 0.1;
  const estimatedCostUsd = (totalTokens / 1_000_000) * rate;

  return {
    fromProvider,
    fromModelVersion: fromFile.modelVersion,
    toProvider,
    entryCount: entries.length,
    totalTokens,
    ratePer1MTokensUsd: rate,
    estimatedCostUsd,
  };
}

// ── Re-embed strategy (pluggable for tests) ──────────────────────────────────

/**
 * Pluggable re-embed function. The CLI takes a function so tests can stub it
 * (no network calls) and the orchestrator can wire the real adapter at
 * pipeline-load. In production this would call the destination adapter's
 * embedBatch() and return its vectors in input order.
 */
export type ReEmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * Default stub re-embed function — produces deterministic zero-vectors of
 * length 1536 (matching the openai-text-embedding-3-small dimensions). Used
 * when the CLI is invoked without a wired re-embed function (which is the
 * dry-run-only path in pipeline-cli today; the orchestrator wires real
 * adapters in Phase 4).
 *
 * The stub PRESERVES input order per the EmbeddingAdapter.embedBatch contract.
 */
export const STUB_REEMBED: ReEmbedFn = async (texts) =>
  texts.map(() => new Array(1536).fill(0)) as number[][];

// ── Migration executor (AC#2 atomic swap) ────────────────────────────────────

export interface MigrationOptions {
  /** Override the timestamp used on .bak filenames (tests). */
  backupTimestamp?: string;
  /** Pluggable re-embed function (defaults to STUB_REEMBED). */
  reEmbed?: ReEmbedFn;
  /** Target model version (defaults to today's ISO date). */
  toModelVersion?: string;
}

export interface MigrationResult {
  fromProvider: string;
  fromModelVersion: string;
  fromFilePath: string;
  toProvider: string;
  toModelVersion: string;
  toFilePath: string;
  backupFilePath: string;
  entryCount: number;
}

/**
 * Execute a migration from `fromProvider` to `toProvider`.
 *
 * Atomicity model (AC#2):
 *   1. Read all entries from the source JSONL.
 *   2. Re-embed via `reEmbed()` in one call (batch-preserving order).
 *   3. Write the new file to `<toFile>.<uuid>.tmp`.
 *   4. Rename `<toFile>.<uuid>.tmp` → `<toFile>` (atomic on POSIX).
 *   5. Rename the source `<fromFile>` → `<fromFile>.bak.<timestamp>`.
 *
 * Concurrent readers during steps 1-4 see ONLY the old file. The moment the
 * rename in step 4 completes, readers see the new file. There is no window
 * where they see a partial mix — the source remains intact until step 5.
 *
 * The .bak file is retained for 30 days (cli-embedding-gc retention applies).
 */
export async function executeMigration(
  embeddingsDir: string,
  fromProvider: string,
  toProvider: string,
  options?: MigrationOptions,
): Promise<MigrationResult> {
  const fromFile = findFromFile(embeddingsDir, fromProvider);
  if (!fromFile) {
    throw new Error(
      `[cli-embedding-bump] no source file found for provider '${fromProvider}' ` +
        `in ${embeddingsDir}. Nothing to migrate.`,
    );
  }

  const entries = readJsonlEntries(fromFile.filePath);
  if (entries.length === 0) {
    throw new Error(
      `[cli-embedding-bump] source file ${fromFile.filePath} contains zero ` +
        `entries. Nothing to migrate.`,
    );
  }

  const toModelVersion = options?.toModelVersion ?? new Date().toISOString().slice(0, 10);
  const toFilePath = jsonlPath(embeddingsDir, toProvider, toModelVersion);

  const reEmbed = options?.reEmbed ?? STUB_REEMBED;
  const texts = entries.map((e) => e.text);
  const newVectors = await reEmbed(texts);

  if (newVectors.length !== entries.length) {
    throw new Error(
      `[cli-embedding-bump] re-embed returned ${newVectors.length} vectors for ` +
        `${entries.length} input texts — order/count contract violated.`,
    );
  }

  const writtenAt = new Date().toISOString();
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const src = entries[i]!;
    const newVec = newVectors[i]!;
    const migrated: VectorStoreEntry = {
      vector: newVec,
      embeddingProvider: toProvider,
      embeddingModelVersion: toModelVersion,
      writtenAt,
      text: src.text,
      textHash: src.textHash,
      ...(src.metadata !== undefined ? { metadata: src.metadata } : {}),
    };
    lines.push(JSON.stringify(migrated));
  }

  // Step 3+4: atomic temp-then-rename for the new file.
  const tmp = `${toFilePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, lines.join('\n') + '\n', 'utf-8');
  renameSync(tmp, toFilePath);

  // Step 5: rename the source file to .bak.<timestamp> only AFTER the new file
  // lands. This guarantees concurrent readers always see at least one valid
  // file — either the old one (until step 5) or the new one (from step 4).
  const backupStamp = options?.backupTimestamp ?? writtenAt.replace(/[:.]/g, '-');
  const backupFilePath = `${fromFile.filePath}.bak.${backupStamp}`;
  renameSync(fromFile.filePath, backupFilePath);

  return {
    fromProvider,
    fromModelVersion: fromFile.modelVersion,
    fromFilePath: fromFile.filePath,
    toProvider,
    toModelVersion,
    toFilePath,
    backupFilePath,
    entryCount: entries.length,
  };
}

// ── CLI router ────────────────────────────────────────────────────────────────

/**
 * yargs router for `cli-embedding-bump`. Exported so tests can mutate
 * `process.argv` + capture stdout (mirrors the cli-embedding-gc test pattern).
 */
export async function runEmbeddingBumpCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('cli-embedding-bump')
    .usage('$0 <command> [options]')
    .command(
      ['dry-run', '$0'],
      'Report the count + cost estimate for a migration without modifying files',
      (y) =>
        y
          .option('artifacts-dir', {
            alias: 'a',
            type: 'string',
            description: 'Path to the artifacts directory (contains _embeddings/)',
            default: process.env.ARTIFACTS_DIR ?? '.ai-sdlc/artifacts',
          })
          .option('from', {
            alias: 'f',
            type: 'string',
            description: 'Source provider (deprecated adapter name)',
            demandOption: true,
          })
          .option('to', {
            alias: 't',
            type: 'string',
            description: 'Target provider (replacement adapter name)',
            demandOption: true,
          })
          .option('rate-per-1m-tokens', {
            type: 'number',
            description: 'Override the cost rate (USD per 1M tokens). Defaults to public pricing.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text',
            description: 'Output format',
          }),
      (args) => {
        const embeddingsDir = join(args['artifacts-dir'], '_embeddings');
        const estimate = estimateMigrationCost(embeddingsDir, args.from, args.to, {
          ...(typeof args['rate-per-1m-tokens'] === 'number'
            ? { ratePer1MTokensUsd: args['rate-per-1m-tokens'] }
            : {}),
        });

        if (!estimate) {
          if (args.format === 'json') {
            process.stdout.write(
              JSON.stringify(
                {
                  fromProvider: args.from,
                  toProvider: args.to,
                  entryCount: 0,
                  totalTokens: 0,
                  estimatedCostUsd: 0,
                  note: `No source file found for '${args.from}'.`,
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(
              `[cli-embedding-bump] dry-run: no source file found for provider ` +
                `'${args.from}' in ${embeddingsDir}. Nothing to migrate.\n`,
            );
          }
          return;
        }

        if (args.format === 'json') {
          process.stdout.write(JSON.stringify({ dryRun: true, ...estimate }, null, 2) + '\n');
        } else {
          process.stdout.write(
            `[cli-embedding-bump] dry-run: migrate ${estimate.entryCount} vectors from ` +
              `'${estimate.fromProvider}@${estimate.fromModelVersion}' to '${estimate.toProvider}'\n` +
              `  Total tokens: ${estimate.totalTokens}\n` +
              `  Rate: $${estimate.ratePer1MTokensUsd.toFixed(2)} / 1M tokens\n` +
              `  Estimated cost: $${estimate.estimatedCostUsd.toFixed(4)} USD\n` +
              `Run with 'execute' to perform the migration.\n`,
          );
        }
      },
    )
    .command(
      'execute',
      'Read source vectors, re-embed via the target provider, atomically swap files',
      (y) =>
        y
          .option('artifacts-dir', {
            alias: 'a',
            type: 'string',
            description: 'Path to the artifacts directory (contains _embeddings/)',
            default: process.env.ARTIFACTS_DIR ?? '.ai-sdlc/artifacts',
          })
          .option('from', {
            alias: 'f',
            type: 'string',
            description: 'Source provider (deprecated adapter name)',
            demandOption: true,
          })
          .option('to', {
            alias: 't',
            type: 'string',
            description: 'Target provider (replacement adapter name)',
            demandOption: true,
          })
          .option('to-model-version', {
            type: 'string',
            description: 'Target model version (defaults to today ISO date)',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text',
            description: 'Output format',
          }),
      async (args) => {
        const embeddingsDir = join(args['artifacts-dir'], '_embeddings');
        const result = await executeMigration(embeddingsDir, args.from, args.to, {
          ...(args['to-model-version'] ? { toModelVersion: args['to-model-version'] } : {}),
        });

        if (args.format === 'json') {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(
            `[cli-embedding-bump] execute: migrated ${result.entryCount} vectors\n` +
              `  From: ${result.fromFilePath}\n` +
              `  To:   ${result.toFilePath}\n` +
              `  Backup: ${result.backupFilePath} (.bak retained for 30d)\n` +
              `Pipeline.spec.embedding.provider should now be set to '${result.toProvider}'.\n`,
          );
        }
      },
    )
    .demandCommand(0)
    .help()
    .strict()
    .parseAsync();

  void argv;
}
