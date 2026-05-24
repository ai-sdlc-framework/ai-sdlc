/**
 * `cli-classifier` — aggregator + sweeper CLI for the shared classifier
 * substrate (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * Subcommands:
 *
 *   corpus aggregate [--task-type <type>] [--corpus-dir <path>] [--format json|table]
 *     Emit the aggregated training corpus (positive + negative
 *     exemplars) for one or all task types. Output is JSON by default;
 *     `--format table` renders a per-task-type summary.
 *
 *   corpus resolve-silence [--task-type <type>] [--corpus-dir <path>]
 *     Sweep `pending` entries older than the override window and flip
 *     them to `positive`. Runs across all task types unless one is
 *     named. Idempotent — re-running has no effect on already-resolved
 *     entries.
 *
 *   corpus stats [--task-type <type>] [--corpus-dir <path>] [--format json|table]
 *     Per-task-type accuracy + override-rate summary. Useful for
 *     deciding when a per-task classifier is ready for default-on.
 *
 * Per AC-5: the `aggregate` subcommand emits the aggregated training
 * corpus. The other two subcommands are operational helpers — they
 * surface the silence-as-positive sweeper (AC-7) and the corpus-quality
 * metric the operator uses to decide promotion.
 *
 * @module cli/classifier
 */

import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  ALL_TASK_TYPES,
  readCorpus,
  resolveCorpusDir,
  resolveOverrideWindowHours,
  resolveSilenceAsPositive,
  type CalibrationCorpusEntry,
  type ClassifierTaskType,
} from '../classifier/substrate/index.js';

// ── Output helpers ───────────────────────────────────────────────────────────

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(`[cli-classifier] error: ${reason}\n`);
  process.exit(code);
}

// ── Task-type validation ─────────────────────────────────────────────────────

function validateTaskType(value: unknown): ClassifierTaskType | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    fail(`task type must be a string, got ${typeof value}`);
  }
  if (!(ALL_TASK_TYPES as readonly string[]).includes(value)) {
    fail(`unknown task type "${value}". Allowed: ${ALL_TASK_TYPES.join(', ')}`);
  }
  return value as ClassifierTaskType;
}

// ── Aggregate ────────────────────────────────────────────────────────────────

interface AggregatedTaskTypeCorpus {
  taskType: ClassifierTaskType;
  /** Total entries across all polarities. */
  totalEntries: number;
  /** Resolved (positive + negative) exemplars suitable for training. */
  resolvedExemplars: ResolvedExemplar[];
  /** Pending entries — not yet eligible for training. */
  pendingCount: number;
  /** Positive count among resolved. */
  positiveCount: number;
  /** Negative count among resolved. */
  negativeCount: number;
}

interface ResolvedExemplar {
  id: string;
  timestamp: string;
  input: CalibrationCorpusEntry['input'];
  llmClassification: string;
  llmConfidence: number;
  /**
   * The "correct" classification — for positive exemplars this equals
   * the LLM's; for negatives this is the operator's override.
   */
  correctClassification: string;
  polarity: 'positive' | 'negative';
}

interface AggregateResult {
  /** ISO-8601 timestamp the aggregation was run. */
  aggregatedAt: string;
  /** Task type filter applied (`null` = all). */
  taskTypeFilter: ClassifierTaskType | null;
  /** Per-task-type corpora — one entry per task type seen. */
  perTaskType: AggregatedTaskTypeCorpus[];
  /** Combined exemplar count across all task types in the result. */
  totalResolvedExemplars: number;
}

function aggregate(
  repoRoot: string,
  corpusDir: string | undefined,
  taskTypeFilter: ClassifierTaskType | undefined,
): AggregateResult {
  const taskTypes = taskTypeFilter ? [taskTypeFilter] : ALL_TASK_TYPES;
  const perTaskType: AggregatedTaskTypeCorpus[] = [];
  let totalResolvedExemplars = 0;
  for (const taskType of taskTypes) {
    const entries = readCorpus(repoRoot, taskType, corpusDir);
    const resolved = entries.filter((e) => e.polarity === 'positive' || e.polarity === 'negative');
    const exemplars: ResolvedExemplar[] = resolved.map((e) => {
      // The filter above guarantees e.polarity is 'positive' | 'negative',
      // but TypeScript's flow analysis through .filter() doesn't narrow
      // the discriminated union — we narrow inline.
      const polarity: 'positive' | 'negative' = e.polarity === 'negative' ? 'negative' : 'positive';
      return {
        id: e.id,
        timestamp: e.timestamp,
        input: e.input,
        llmClassification: e.classification,
        llmConfidence: e.confidence,
        correctClassification:
          polarity === 'positive'
            ? e.classification
            : (e.operatorOverrideClassification ?? e.classification),
        polarity,
      };
    });
    const positiveCount = resolved.filter((e) => e.polarity === 'positive').length;
    const negativeCount = resolved.filter((e) => e.polarity === 'negative').length;
    const pendingCount = entries.length - resolved.length;
    perTaskType.push({
      taskType,
      totalEntries: entries.length,
      resolvedExemplars: exemplars,
      pendingCount,
      positiveCount,
      negativeCount,
    });
    totalResolvedExemplars += exemplars.length;
  }
  return {
    aggregatedAt: new Date().toISOString(),
    taskTypeFilter: taskTypeFilter ?? null,
    perTaskType,
    totalResolvedExemplars,
  };
}

function renderAggregateTable(result: AggregateResult): string {
  const lines: string[] = [];
  lines.push(`Aggregated at: ${result.aggregatedAt}`);
  if (result.taskTypeFilter) lines.push(`Filter: task-type = ${result.taskTypeFilter}`);
  lines.push('');
  lines.push('Task type                       Total   Pending   Positive   Negative   Accuracy');
  lines.push('------------------------------  ------  --------  ---------  ---------  --------');
  for (const t of result.perTaskType) {
    const resolved = t.positiveCount + t.negativeCount;
    const accuracy = resolved > 0 ? `${((t.positiveCount / resolved) * 100).toFixed(1)}%` : 'n/a';
    lines.push(
      `${t.taskType.padEnd(30)}  ${String(t.totalEntries).padStart(6)}  ${String(t.pendingCount).padStart(8)}  ${String(t.positiveCount).padStart(9)}  ${String(t.negativeCount).padStart(9)}  ${accuracy.padStart(8)}`,
    );
  }
  lines.push('');
  lines.push(`Total resolved exemplars: ${result.totalResolvedExemplars}`);
  return lines.join('\n');
}

// ── Stats ────────────────────────────────────────────────────────────────────

interface StatsTaskTypeResult {
  taskType: ClassifierTaskType;
  totalEntries: number;
  pendingCount: number;
  positiveCount: number;
  negativeCount: number;
  /** Resolved-pool accuracy: positive / (positive + negative). */
  accuracy: number | null;
  /** Override-rate inside the threshold-met pool — the AC-3 / AC-6 metric. */
  overrideRateAboveThreshold: number | null;
  /** Override-rate inside the threshold-not-met pool — useful diagnostic. */
  overrideRateBelowThreshold: number | null;
}

interface StatsResult {
  aggregatedAt: string;
  taskTypeFilter: ClassifierTaskType | null;
  perTaskType: StatsTaskTypeResult[];
}

function stats(
  repoRoot: string,
  corpusDir: string | undefined,
  taskTypeFilter: ClassifierTaskType | undefined,
): StatsResult {
  const taskTypes = taskTypeFilter ? [taskTypeFilter] : ALL_TASK_TYPES;
  const perTaskType: StatsTaskTypeResult[] = [];
  for (const taskType of taskTypes) {
    const entries = readCorpus(repoRoot, taskType, corpusDir);
    const resolved = entries.filter((e) => e.polarity !== 'pending');
    const positive = resolved.filter((e) => e.polarity === 'positive').length;
    const negative = resolved.filter((e) => e.polarity === 'negative').length;
    const above = resolved.filter((e) => e.metBehindThreshold);
    const below = resolved.filter((e) => !e.metBehindThreshold);
    const aboveOverrides = above.filter((e) => e.polarity === 'negative').length;
    const belowOverrides = below.filter((e) => e.polarity === 'negative').length;
    perTaskType.push({
      taskType,
      totalEntries: entries.length,
      pendingCount: entries.length - resolved.length,
      positiveCount: positive,
      negativeCount: negative,
      accuracy: positive + negative > 0 ? positive / (positive + negative) : null,
      overrideRateAboveThreshold: above.length > 0 ? aboveOverrides / above.length : null,
      overrideRateBelowThreshold: below.length > 0 ? belowOverrides / below.length : null,
    });
  }
  return {
    aggregatedAt: new Date().toISOString(),
    taskTypeFilter: taskTypeFilter ?? null,
    perTaskType,
  };
}

function renderStatsTable(result: StatsResult): string {
  const lines: string[] = [];
  lines.push(`Aggregated at: ${result.aggregatedAt}`);
  if (result.taskTypeFilter) lines.push(`Filter: task-type = ${result.taskTypeFilter}`);
  lines.push('');
  lines.push(
    'Task type                       Total   Accuracy   Above-thresh Override   Below-thresh Override',
  );
  lines.push(
    '------------------------------  ------  ---------  ----------------------  ----------------------',
  );
  for (const t of result.perTaskType) {
    const acc = t.accuracy === null ? 'n/a' : `${(t.accuracy * 100).toFixed(1)}%`;
    const aboveOv =
      t.overrideRateAboveThreshold === null
        ? 'n/a'
        : `${(t.overrideRateAboveThreshold * 100).toFixed(1)}%`;
    const belowOv =
      t.overrideRateBelowThreshold === null
        ? 'n/a'
        : `${(t.overrideRateBelowThreshold * 100).toFixed(1)}%`;
    lines.push(
      `${t.taskType.padEnd(30)}  ${String(t.totalEntries).padStart(6)}  ${acc.padStart(9)}  ${aboveOv.padStart(22)}  ${belowOv.padStart(22)}`,
    );
  }
  return lines.join('\n');
}

// ── CLI router ───────────────────────────────────────────────────────────────

interface CommonOpts {
  taskType?: string;
  corpusDir?: string;
  format?: 'json' | 'table';
  repoRoot?: string;
}

function applyCommonOptions(y: Argv): Argv<CommonOpts> {
  return y
    .option('task-type', {
      type: 'string',
      description: 'Restrict to a single task type (default: all 5).',
    })
    .option('corpus-dir', {
      type: 'string',
      description: 'Corpus directory override (default: <repoRoot>/.ai-sdlc/classifier-corpus/).',
    })
    .option('format', {
      type: 'string',
      choices: ['json', 'table'] as const,
      default: 'json' as const,
    })
    .option('repo-root', {
      type: 'string',
      description: 'Project root (default: cwd).',
    }) as unknown as Argv<CommonOpts>;
}

/**
 * Entry point used by the `cli-classifier` bin shim. Exported so other
 * packages can drive the router programmatically (tests + the orchestrator).
 *
 * `argv` defaults to `hideBin(process.argv)` for the bin-shim caller; tests
 * pass an explicit array.
 */
export async function runClassifierCli(argv: string[] = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName('cli-classifier')
    .strict()
    .demandCommand(1, 'A subcommand is required (corpus).')
    .command(
      'corpus <subcommand>',
      'Corpus aggregator + sweeper + stats.',
      (y) =>
        y
          .command(
            'aggregate',
            'Emit the aggregated training corpus (AC-5).',
            (yy) => applyCommonOptions(yy),
            (args) => {
              const taskType = validateTaskType(args['task-type']);
              const repoRoot = (args['repo-root'] as string | undefined) ?? process.cwd();
              const result = aggregate(
                repoRoot,
                args['corpus-dir'] as string | undefined,
                taskType,
              );
              if (args.format === 'table') emitText(renderAggregateTable(result));
              else emitJson(result);
            },
          )
          .command(
            'stats',
            'Per-task-type accuracy + override-rate summary.',
            (yy) => applyCommonOptions(yy),
            (args) => {
              const taskType = validateTaskType(args['task-type']);
              const repoRoot = (args['repo-root'] as string | undefined) ?? process.cwd();
              const result = stats(repoRoot, args['corpus-dir'] as string | undefined, taskType);
              if (args.format === 'table') emitText(renderStatsTable(result));
              else emitJson(result);
            },
          )
          .command(
            'resolve-silence',
            'Sweep `pending` entries past the override window → `positive` (AC-7).',
            (yy) =>
              yy
                .option('task-type', {
                  type: 'string',
                  description: 'Restrict to a single task type (default: all 5).',
                })
                .option('corpus-dir', {
                  type: 'string',
                  description: 'Corpus directory override.',
                })
                .option('repo-root', {
                  type: 'string',
                  description: 'Project root (default: cwd).',
                }),
            (args) => {
              const taskType = validateTaskType(args['task-type'] as string | undefined);
              const repoRoot = (args['repo-root'] as string | undefined) ?? process.cwd();
              const result = resolveSilenceAsPositive({
                repoRoot,
                taskTypes: taskType ? [taskType] : undefined,
                corpusDir: args['corpus-dir'] as string | undefined,
              });
              emitJson({
                ...result,
                corpusDir: resolveCorpusDir(repoRoot, args['corpus-dir'] as string | undefined),
                windowHours: resolveOverrideWindowHours(repoRoot),
              });
            },
          )
          .demandCommand(
            1,
            'A corpus subcommand is required (aggregate | stats | resolve-silence).',
          ),
      () => {
        /* group; handlers above */
      },
    )
    .help()
    .parseAsync();
}

// Silence unused-import warning if join is not used elsewhere in this file.
void join;
