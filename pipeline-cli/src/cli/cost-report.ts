/**
 * `cli-cost-report --unified` — RFC-0019 §10 OQ-7 re-walkthrough (AISDLC-340).
 *
 * Aggregates `inputTokens` + `outputTokens` + `embeddingTokens` + SubscriptionLedger
 * window consumption (cost-converted) into a single view labelled by `costModel`.
 * Answers finance's monthly-spend query in ONE place without re-running multiple
 * substrate-specific CLIs.
 *
 * The CLI is self-contained: it reads JSONL/JSON files directly (no
 * `@ai-sdlc/orchestrator` import) so pipeline-cli stays orchestrator-free.
 *
 * Input sources (each is OPTIONAL; absent = zero rows from that substrate):
 *   --cost-ledger-jsonl <path>   JSONL one record per line; cost ledger export
 *                                emitted by the orchestrator (`pipelineType`,
 *                                `model`, `inputTokens`, `outputTokens`,
 *                                `costUsd`, `createdAt`, `agentName`, `stageName`).
 *   --ledger-dir <path>          Subscription ledger directory ($ARTIFACTS_DIR/_ledger).
 *                                Reads every `*.json` file as PersistedState and
 *                                cost-converts via `--subscription-monthly-usd`.
 *
 * Output:
 *   --format text|json|csv       Default: text (operator-friendly table).
 *
 * Filtering:
 *   --since <ISO>                Only include cost-ledger rows with createdAt >= since.
 *
 * Subscription cost-conversion math (deliberately simple for v1):
 *   For each ledger file, costUsd = consumedTokens / windowTokens * monthlyUsd /
 *   (24 * 30 / windowHours). Defaults to Claude Code Max-20x: $200/mo, 5h window.
 *   Operators override per-plan via `--subscription-monthly-usd` and
 *   `--subscription-window-hours`. The CLI emits ONE row per ledger file with
 *   `costModel='subscription-quota'`.
 *
 * Subagent assumption: pipeline-cli does NOT read SQLite. Operators who run the
 * orchestrator with the SQLite cost store should export to JSONL first via
 * `node -e 'const {Orchestrator} = ...; for (const e of orch.cost.entries()) console.log(JSON.stringify(e));'`
 * Documented in the operator runbook.
 *
 * @module cli/cost-report
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ── Types (mirror orchestrator's CostLedgerEntry/PersistedState, NO IMPORT) ──

/** Minimal cost-ledger entry shape we care about for the unified report. */
interface CostLedgerEntryLike {
  /** 'inputTokens'/'outputTokens'/'embeddingTokens' or harness-specific kinds. */
  pipelineType?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Consumer label (RFC-0019 OQ-6); for embedding rows == consumerLabel. */
  agentName?: string;
  stageName?: string;
  createdAt?: string;
}

/** Subscription-ledger persisted state (mirrors orchestrator/scheduling/ledger.ts). */
interface PersistedLedgerState {
  windowStart: string;
  consumedTokens: number;
}

// ── Row shape ────────────────────────────────────────────────────────────────

/**
 * One row of the unified-cost-report.
 *
 * `costModel` discriminates `'pay-per-token'` (LLM input/output + embedding
 * billed against an API key) from `'subscription-quota'` (window quota
 * consumption cost-converted to USD). Per OQ-7 re-walkthrough.
 */
export interface UnifiedCostRow {
  /** 'pay-per-token' | 'subscription-quota'. */
  costModel: 'pay-per-token' | 'subscription-quota';
  /** 'inputTokens' | 'outputTokens' | 'embeddingTokens' | 'subscription-window'. */
  category: string;
  /** Provider/model identifier (e.g., 'openai-text-embedding-3-small@2024-01-25'). */
  source: string;
  /** Consumer attribution (OQ-6); 'unspecified' for unlabeled LLM rows. */
  consumer: string;
  /** Aggregate token count across the bucket. */
  tokens: number;
  /** Aggregate cost in USD. */
  costUsd: number;
  /** Count of underlying records in the bucket. */
  recordCount: number;
}

/** Bucket key for aggregation. */
function rowKey(r: Omit<UnifiedCostRow, 'tokens' | 'costUsd' | 'recordCount'>): string {
  return [r.costModel, r.category, r.source, r.consumer].join('');
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Classify a cost-ledger entry into one of the unified-report categories.
 *
 * - `pipelineType==='embeddingTokens'` → embedding (consumer = agentName per
 *   the cost-tracker encoding convention; see `recordEmbeddingCost`).
 * - Anything else with input/output tokens → split into two rows
 *   (`inputTokens`/`outputTokens`), each cost-prorated by token share.
 */
function classifyCostLedgerEntry(entry: CostLedgerEntryLike): UnifiedCostRow[] {
  const totalIn = entry.inputTokens ?? 0;
  const totalOut = entry.outputTokens ?? 0;
  const totalCost = entry.costUsd ?? 0;
  const totalTokens = totalIn + totalOut;

  if (entry.pipelineType === 'embeddingTokens') {
    return [
      {
        costModel: 'pay-per-token',
        category: 'embeddingTokens',
        source: entry.model ?? '(unknown)',
        // The cost-tracker convention is: agentName == consumerLabel
        // (see orchestrator/src/cost-tracker.ts recordEmbeddingCost()).
        consumer: entry.agentName ?? 'unspecified',
        tokens: totalIn,
        costUsd: totalCost,
        recordCount: 1,
      },
    ];
  }

  if (totalTokens === 0) {
    return totalCost > 0
      ? [
          {
            costModel: 'pay-per-token',
            category: 'other',
            source: entry.model ?? '(unknown)',
            consumer: entry.agentName ?? 'unspecified',
            tokens: 0,
            costUsd: totalCost,
            recordCount: 1,
          },
        ]
      : [];
  }

  const rows: UnifiedCostRow[] = [];
  if (totalIn > 0) {
    rows.push({
      costModel: 'pay-per-token',
      category: 'inputTokens',
      source: entry.model ?? '(unknown)',
      consumer: entry.agentName ?? 'unspecified',
      tokens: totalIn,
      costUsd: (totalCost * totalIn) / totalTokens,
      recordCount: 1,
    });
  }
  if (totalOut > 0) {
    rows.push({
      costModel: 'pay-per-token',
      category: 'outputTokens',
      source: entry.model ?? '(unknown)',
      consumer: entry.agentName ?? 'unspecified',
      tokens: totalOut,
      costUsd: (totalCost * totalOut) / totalTokens,
      recordCount: 1,
    });
  }
  return rows;
}

/** Aggregate per-entry rows by (costModel, category, source, consumer). */
function aggregate(rows: UnifiedCostRow[]): UnifiedCostRow[] {
  const buckets = new Map<string, UnifiedCostRow>();
  for (const row of rows) {
    const key = rowKey(row);
    const existing = buckets.get(key);
    if (existing) {
      existing.tokens += row.tokens;
      existing.costUsd += row.costUsd;
      existing.recordCount += row.recordCount;
    } else {
      buckets.set(key, { ...row });
    }
  }
  return [...buckets.values()].sort((a, b) => {
    if (a.costModel !== b.costModel) return a.costModel.localeCompare(b.costModel);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.consumer.localeCompare(b.consumer);
  });
}

/**
 * Parse a cost-ledger JSONL file into per-entry rows.
 * Silently skips blank lines + malformed JSON (logged via stderr).
 */
export function loadCostLedgerJsonl(
  path: string,
  options: { since?: Date } = {},
): UnifiedCostRow[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const rows: UnifiedCostRow[] = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: CostLedgerEntryLike;
    try {
      entry = JSON.parse(line) as CostLedgerEntryLike;
    } catch {
      process.stderr.write(`[cli-cost-report] skipping malformed line in ${path}\n`);
      continue;
    }
    if (options.since && entry.createdAt) {
      if (new Date(entry.createdAt) < options.since) continue;
    }
    for (const row of classifyCostLedgerEntry(entry)) rows.push(row);
  }
  return rows;
}

/**
 * Convert subscription-window consumption into a single cost row per
 * ledger file using a simple monthly-cost-proportional model.
 *
 * Reasoning: Claude Code Max-20x is $200/mo with a 5h sliding window. If
 * the window quota is consumed, the operator is effectively paying that
 * pro-rated fraction of the monthly subscription. The math is intentionally
 * approximate — surfaces "subscription dollars at play" without claiming
 * line-item accuracy a subscription-billed substrate cannot provide.
 *
 * Per-window cost = monthlyUsd * (consumedTokens / windowTokens)
 *                              * (windowHours / (24 * 30))
 */
export function convertSubscriptionWindowToCost(
  state: PersistedLedgerState,
  filename: string,
  monthlyUsd: number,
  windowHours: number,
  windowTokens: number,
): UnifiedCostRow {
  const consumptionFraction = windowTokens > 0 ? state.consumedTokens / windowTokens : 0;
  const windowsPerMonth = (24 * 30) / windowHours;
  const perWindowCost = monthlyUsd / windowsPerMonth;
  const costUsd = perWindowCost * consumptionFraction;
  return {
    costModel: 'subscription-quota',
    category: 'subscription-window',
    source: filename,
    consumer: 'unspecified',
    tokens: state.consumedTokens,
    costUsd,
    recordCount: 1,
  };
}

/** Walk a `_ledger/` directory of `*.json` files. */
export function loadSubscriptionLedgerDir(
  ledgerDir: string,
  monthlyUsd: number,
  windowHours: number,
  windowTokens: number,
): UnifiedCostRow[] {
  if (!existsSync(ledgerDir) || !statSync(ledgerDir).isDirectory()) return [];
  const rows: UnifiedCostRow[] = [];
  for (const file of readdirSync(ledgerDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = join(ledgerDir, file);
    try {
      const state = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedLedgerState;
      rows.push(
        convertSubscriptionWindowToCost(state, file, monthlyUsd, windowHours, windowTokens),
      );
    } catch {
      process.stderr.write(`[cli-cost-report] skipping unparseable ledger file ${filePath}\n`);
    }
  }
  return rows;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Render rows as a plain-text table. */
export function renderTextTable(rows: UnifiedCostRow[]): string {
  if (rows.length === 0) return '[cli-cost-report] No cost data found.\n';

  const header = ['costModel', 'category', 'source', 'consumer', 'tokens', 'costUsd', 'records'];
  const data = rows.map((r) => [
    r.costModel,
    r.category,
    r.source,
    r.consumer,
    r.tokens.toLocaleString('en-US'),
    `$${r.costUsd.toFixed(4)}`,
    String(r.recordCount),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');

  const lines: string[] = [];
  lines.push(fmt(header));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of data) lines.push(fmt(row));

  // Totals.
  const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  lines.push(
    `TOTAL: tokens=${totalTokens.toLocaleString('en-US')}  costUsd=$${totalCost.toFixed(4)}\n`,
  );
  return lines.join('\n') + '\n';
}

export function renderCsv(rows: UnifiedCostRow[]): string {
  const header = 'costModel,category,source,consumer,tokens,costUsd,recordCount';
  const body = rows
    .map(
      (r) =>
        `${r.costModel},${r.category},${escapeCsv(r.source)},${escapeCsv(r.consumer)},` +
        `${r.tokens},${r.costUsd.toFixed(6)},${r.recordCount}`,
    )
    .join('\n');
  return header + '\n' + body + (rows.length > 0 ? '\n' : '');
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface UnifiedReportOptions {
  costLedgerJsonl?: string;
  ledgerDir?: string;
  since?: Date;
  subscriptionMonthlyUsd?: number;
  subscriptionWindowHours?: number;
  subscriptionWindowTokens?: number;
}

/** Default subscription-cost-conversion knobs (Claude Code Max-20x). */
export const SUBSCRIPTION_DEFAULTS = {
  monthlyUsd: 200,
  windowHours: 5,
  windowTokens: 200_000,
} as const;

/**
 * Build the unified-cost report from the supplied data sources.
 * Pure function — easy to test without spawning the CLI.
 */
export function buildUnifiedReport(options: UnifiedReportOptions): UnifiedCostRow[] {
  const rows: UnifiedCostRow[] = [];

  if (options.costLedgerJsonl) {
    rows.push(...loadCostLedgerJsonl(options.costLedgerJsonl, { since: options.since }));
  }

  if (options.ledgerDir) {
    rows.push(
      ...loadSubscriptionLedgerDir(
        options.ledgerDir,
        options.subscriptionMonthlyUsd ?? SUBSCRIPTION_DEFAULTS.monthlyUsd,
        options.subscriptionWindowHours ?? SUBSCRIPTION_DEFAULTS.windowHours,
        options.subscriptionWindowTokens ?? SUBSCRIPTION_DEFAULTS.windowTokens,
      ),
    );
  }

  return aggregate(rows);
}

// ── CLI router ───────────────────────────────────────────────────────────────

export async function runCostReportCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('cli-cost-report')
    .usage('$0 [options]')
    .option('unified', {
      type: 'boolean',
      default: true,
      description: 'Emit the unified cost report (default). Reserved for future modes.',
    })
    .option('cost-ledger-jsonl', {
      type: 'string',
      description:
        'Path to a cost-ledger JSONL export (one CostLedgerEntry per line). ' +
        'Emit from orchestrator using a small script that JSON.stringifies each entry.',
    })
    .option('ledger-dir', {
      type: 'string',
      description:
        'Path to SubscriptionLedger persistence directory (default $ARTIFACTS_DIR/_ledger).',
      default: process.env.ARTIFACTS_DIR ? join(process.env.ARTIFACTS_DIR, '_ledger') : undefined,
    })
    .option('since', {
      type: 'string',
      description: 'ISO 8601 timestamp. Only include cost-ledger entries with createdAt >= since.',
    })
    .option('subscription-monthly-usd', {
      type: 'number',
      default: SUBSCRIPTION_DEFAULTS.monthlyUsd,
      description: 'Subscription monthly cost in USD (default: 200, Claude Code Max-20x).',
    })
    .option('subscription-window-hours', {
      type: 'number',
      default: SUBSCRIPTION_DEFAULTS.windowHours,
      description: 'Subscription window length in hours (default: 5).',
    })
    .option('subscription-window-tokens', {
      type: 'number',
      default: SUBSCRIPTION_DEFAULTS.windowTokens,
      description: 'Subscription window total token quota (default: 200000).',
    })
    .option('format', {
      type: 'string',
      choices: ['text', 'json', 'csv'] as const,
      default: 'text',
      description: 'Output format.',
    })
    .help()
    .strict()
    .parseAsync();

  if (!argv['cost-ledger-jsonl'] && !argv['ledger-dir']) {
    process.stderr.write(
      '[cli-cost-report] At least one of --cost-ledger-jsonl or --ledger-dir is required.\n' +
        'See docs/operations/embedding-providers.md#unified-cost-report for the runbook.\n',
    );
    process.exit(1);
  }

  const since = argv.since ? new Date(argv.since) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    process.stderr.write(`[cli-cost-report] Invalid --since value: ${argv.since}\n`);
    process.exit(1);
  }

  const rows = buildUnifiedReport({
    costLedgerJsonl: argv['cost-ledger-jsonl'],
    ledgerDir: argv['ledger-dir'],
    since,
    subscriptionMonthlyUsd: argv['subscription-monthly-usd'],
    subscriptionWindowHours: argv['subscription-window-hours'],
    subscriptionWindowTokens: argv['subscription-window-tokens'],
  });

  switch (argv.format) {
    case 'json':
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      break;
    case 'csv':
      process.stdout.write(renderCsv(rows));
      break;
    case 'text':
    default:
      process.stdout.write(renderTextTable(rows));
      break;
  }
}
