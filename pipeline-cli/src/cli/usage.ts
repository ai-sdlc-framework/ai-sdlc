/**
 * `cli-usage` - usage ledger and model price tooling (RFC-0050).
 *
 * Subcommands:
 *   ingest [--backfill] [--json]                read Claude Code transcripts into the ledger
 *   report [--group-by ...] [--format ...]      usage by model, role, task, repo, pool, day, window
 *   window | task <id> | context                fixed views: allotment windows, one task, context overhead
 *   snapshot --window <n> --used-pct <p>        record a calibration point
 *   allotment [--window <n>]                    implied allotment series and change detection
 *   prices refresh [--source <name>] [--json]   fetch public price sources
 *   prices list [--json]                        prices in force, source, age, held rows
 *   prices confirm <model>                      promote a held row to active
 *   prices set <model> --input ... --output ... manual price row
 *
 * `ingest` reads Claude Code transcripts and appends one record per model call
 * to the ledger. It prints counts only, never any transcript content.
 *
 * Each command family lives in its own `register*Commands` function; add
 * further top-level subcommands in `buildUsageCli`.
 *
 * @module cli/usage
 */

import {
  DEFAULT_CHANGE_FACTOR,
  DEFAULT_STALE_AFTER_DAYS,
  DEFAULT_TOLERANCE,
  confirmHeldPrice,
  defaultPriceSources,
  listPrices,
  refreshPrices,
  reportCapabilityOutcome,
  resolveUsageDir,
  setManualPrice,
  type FetchFn,
  type PriceListEntry,
  type PriceSource,
  type RefreshResult,
} from '@ai-sdlc/reference';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { writeEvent, type OrchestratorEvent } from '../orchestrator/events.js';
import { emitPriceChanges } from '../orchestrator/price-refresh.js';
import { registerUsageViewCommands, type UsageViewDeps } from '../usage/commands.js';
import {
  DEFAULT_MAX_SECONDS,
  ingestClaudeTranscripts,
  type IngestResult,
} from '../usage/ingest-claude.js';

/** Collaborators, injectable so tests never touch the network, home dir or clock. */
export interface UsageCliDeps extends UsageViewDeps {
  fetch?: FetchFn;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  onCapability?: (outcome: 'live' | 'degraded', reason?: string) => void;
  /** Reports the `usage.ingest` capability (tests). */
  onIngestCapability?: (outcome: 'live' | 'degraded', reason?: string) => void;
  /** Replaces the transcript ingester (tests). */
  ingest?: typeof ingestClaudeTranscripts;
  /** Replaces the default sources (tests). */
  sources?: readonly PriceSource[];
  /** Exit code sink; defaults to `process.exitCode`. */
  setExitCode?: (code: number) => void;
}

function formatPrice(n: number): string {
  return Number(n.toPrecision(6)).toString();
}

export function formatPriceList(entries: readonly PriceListEntry[]): string {
  if (entries.length === 0) return 'No prices on record.\n';
  const lines: string[] = [];
  for (const e of entries) {
    if (e.active) {
      const a = e.active;
      const flags = [e.stale ? 'STALE' : undefined, a.status === 'manual' ? 'manual' : undefined]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `${e.model}  in=${formatPrice(a.inputPer1M)} out=${formatPrice(a.outputPer1M)} ` +
          `read=${formatPrice(a.cacheReadPer1M)} w5m=${formatPrice(a.cacheWrite5mPer1M)} ` +
          `w1h=${formatPrice(a.cacheWrite1hPer1M)}  source=${a.source}  age=${e.ageDays}d` +
          (flags ? `  [${flags}]` : ''),
      );
    } else {
      lines.push(`${e.model}  (no active price)`);
    }
    if (e.held) {
      const h = e.held;
      lines.push(
        `  HELD ${e.model}  in=${formatPrice(h.inputPer1M)} out=${formatPrice(h.outputPer1M)} ` +
          `read=${formatPrice(h.cacheReadPer1M)} w5m=${formatPrice(h.cacheWrite5mPer1M)} ` +
          `w1h=${formatPrice(h.cacheWrite1hPer1M)}  source=${h.source}  ` +
          `(run: cli-usage prices confirm ${e.model})`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatRefreshSummary(r: RefreshResult): string {
  const lines = r.sources.map(
    (s) => `source ${s.name}: ${s.ok ? `${s.rows} models` : `FAILED (${s.error ?? 'error'})`}`,
  );
  lines.push(
    `appended=${r.appended} held=${r.held.length} unchanged=${r.unchanged} ` +
      `incomplete=${r.incomplete.length} rejected=${r.rejected.length}`,
  );
  for (const h of r.held) lines.push(`held ${h.model}: ${h.reason}`);
  if (!r.anySourceSucceeded)
    lines.push('Every source failed; the last known prices stay in force.');
  return `${lines.join('\n')}\n`;
}

export function renderIngestResult(result: IngestResult): string {
  if (result.disabled === 'remote-sandbox') {
    return 'Usage ingestion is not available in a remote sandbox; nothing was read.\n';
  }
  if (result.disabled === 'switched-off') {
    return 'Usage ingestion is switched off (AI_SDLC_USAGE_INGEST); nothing was read.\n';
  }
  const lines = [
    `Files scanned:   ${result.filesScanned}`,
    `Calls written:   ${result.callsWritten}`,
    `Repeats skipped: ${result.repeatsSkipped}`,
    `Errors:          ${result.errors}`,
    `Limit events:    ${result.limitEvents}`,
  ];
  if (result.otherScopeSkipped > 0) {
    lines.push(`Other-scope skipped: ${result.otherScopeSkipped}`);
  }
  if (result.timedOut) lines.push('Stopped at the time limit; the next run continues.');
  return `${lines.join('\n')}\n`;
}

const PRICE_FLAGS = [
  ['input', 'Input price, USD per million tokens'],
  ['output', 'Output price, USD per million tokens'],
  ['cache-read', 'Cache read price, USD per million tokens'],
  ['cache-write-5m', '5-minute cache write price, USD per million tokens'],
  ['cache-write-1h', '1-hour cache write price, USD per million tokens'],
] as const;

function registerPricesCommands(
  y: Argv,
  deps: UsageCliDeps,
  io: { out: (t: string) => void; err: (t: string) => void; exit: (c: number) => void },
): Argv {
  const emit =
    deps.emit ??
    ((event: Omit<OrchestratorEvent, 'ts'>): void => {
      writeEvent({ ...event, ts: (deps.now?.() ?? new Date()).toISOString() } as OrchestratorEvent);
    });
  const store = { dir: deps.usageDir };

  return y
    .command(
      'refresh',
      'Fetch public price sources and append changed prices to the history',
      (c) =>
        c
          .option('source', { type: 'string', description: 'Only this source (by name)' })
          .option('json', { type: 'boolean', default: false })
          .option('tolerance', {
            type: 'number',
            default: DEFAULT_TOLERANCE,
            description: 'Relative disagreement between sources that holds a row',
          })
          .option('change-factor', {
            type: 'number',
            default: DEFAULT_CHANGE_FACTOR,
            description: 'Multiplicative move against the last row that holds a row',
          }),
      async (argv) => {
        const all = deps.sources ?? defaultPriceSources({ fetch: deps.fetch, now: deps.now });
        const sources = argv.source ? all.filter((s) => s.name === argv.source) : all;
        if (sources.length === 0) {
          io.err(
            `Unknown price source "${argv.source}". Known: ${all.map((s) => s.name).join(', ')}\n`,
          );
          io.exit(1);
          return;
        }
        const result = await refreshPrices({
          ...store,
          sources,
          now: deps.now,
          tolerance: argv.tolerance,
          changeFactor: argv['change-factor'],
          onCapability:
            deps.onCapability ??
            ((outcome, reason): void =>
              reportCapabilityOutcome('pricing.feed', outcome, { reason })),
        });
        emitPriceChanges(result.changes, emit);
        io.out(argv.json ? `${JSON.stringify(result, null, 2)}\n` : formatRefreshSummary(result));
      },
    )
    .command(
      'list',
      'Show the price in force per model, its source and age, and any held row',
      (c) =>
        c.option('json', { type: 'boolean', default: false }).option('stale-days', {
          type: 'number',
          default: DEFAULT_STALE_AFTER_DAYS,
          description: 'Days without a successful refresh before prices are stale',
        }),
      (argv) => {
        const entries = listPrices({ ...store, now: deps.now, staleAfterDays: argv['stale-days'] });
        io.out(argv.json ? `${JSON.stringify(entries, null, 2)}\n` : formatPriceList(entries));
      },
    )
    .command(
      'confirm <model>',
      'Promote a held price row to active',
      (c) => c.positional('model', { type: 'string', demandOption: true }),
      (argv) => {
        const done = confirmHeldPrice(String(argv.model), { ...store, now: deps.now });
        if (!done) {
          io.err(`No held price row for ${argv.model}.\n`);
          io.exit(1);
          return;
        }
        emitPriceChanges(done.changes, emit);
        io.out(`Confirmed held price for ${argv.model}.\n`);
      },
    )
    .command(
      'set <model>',
      'Write a manual price row, which wins over fetched rows',
      (c) => {
        let b = c.positional('model', { type: 'string', demandOption: true });
        for (const [flag, description] of PRICE_FLAGS) {
          b = b.option(flag, { type: 'number', demandOption: true, description });
        }
        return b.option('effective-from', {
          type: 'string',
          description: 'Date the price applies from (default today)',
        });
      },
      (argv) => {
        try {
          const row = setManualPrice(
            String(argv.model),
            {
              input: argv.input as number,
              output: argv.output as number,
              cacheRead: argv['cache-read'] as number,
              cacheWrite5m: argv['cache-write-5m'] as number,
              cacheWrite1h: argv['cache-write-1h'] as number,
            },
            { ...store, now: deps.now, effectiveFrom: argv['effective-from'] },
          );
          io.out(`Manual price written for ${row.model} effective ${row.effectiveFrom}.\n`);
        } catch (err) {
          io.err(`${err instanceof Error ? err.message : String(err)}\n`);
          io.exit(1);
        }
      },
    )
    .demandCommand(1, 'Specify a prices subcommand: refresh, list, confirm or set');
}

/** Build the `cli-usage` parser. Exported so tests drive it without `process.argv`. */
export function buildUsageCli(
  args: string[] = hideBin(process.argv),
  deps: UsageCliDeps = {},
): Argv {
  const io = {
    out: deps.stdout ?? ((t: string): void => void process.stdout.write(t)),
    err: deps.stderr ?? ((t: string): void => void process.stderr.write(t)),
    exit:
      deps.setExitCode ??
      ((code: number): void => {
        process.exitCode = code;
      }),
  };
  const cli = yargs(args)
    .scriptName('cli-usage')
    .usage('Usage: $0 <command> [options]')
    .command(
      'ingest',
      'Read Claude Code transcripts and append their model calls to the usage ledger.',
      (y) =>
        y
          .option('backfill', {
            describe: 'Ignore stored cursors and read every transcript from the start.',
            type: 'boolean',
            default: false,
          })
          .option('projects-dir', {
            describe: "Transcript projects directory. Defaults to the harness's standard location.",
            type: 'string',
          })
          .option('max-seconds', {
            describe: 'Stop starting new work after this many seconds.',
            type: 'number',
            default: DEFAULT_MAX_SECONDS,
          })
          .option('json', {
            describe: 'Print the result as JSON.',
            type: 'boolean',
            default: false,
          }),
      async (args) => {
        const report =
          deps.onIngestCapability ??
          ((outcome: 'live' | 'degraded', reason?: string): void =>
            reportCapabilityOutcome('usage.ingest', outcome, {
              reason,
              // The ingester often runs detached with no repository cwd, so state
              // goes to $ARTIFACTS_DIR when set, else to the usage directory.
              artifactsDir: process.env.ARTIFACTS_DIR || resolveUsageDir({ dir: deps.usageDir }),
              now: deps.now,
            }));
        let result: IngestResult;
        try {
          result = await (deps.ingest ?? ingestClaudeTranscripts)({
            backfill: args.backfill,
            ...(typeof args['projects-dir'] === 'string'
              ? { projectsDir: args['projects-dir'] }
              : {}),
            maxSeconds: args['max-seconds'],
          });
        } catch (err) {
          report('degraded', 'ingest failed');
          throw err;
        }
        // A switched-off or sandboxed ingest never ran; it says nothing about health.
        if (!result.disabled) {
          if (result.errors > 0) report('degraded', `${result.errors} transcript errors`);
          else report('live');
        }
        io.out(args.json ? `${JSON.stringify(result)}\n` : renderIngestResult(result));
      },
    )
    .command('prices', 'Model price feed and price history', (y) =>
      registerPricesCommands(y, deps, io),
    );
  const viewDeps: UsageViewDeps = {
    ...deps,
    emit:
      deps.emit ??
      ((event: Omit<OrchestratorEvent, 'ts'>): void => {
        writeEvent({
          ...event,
          ts: (deps.now?.() ?? new Date()).toISOString(),
        } as OrchestratorEvent);
      }),
  };
  return registerUsageViewCommands(cli, viewDeps, io)
    .demandCommand(1, 'Specify a command, for example: ingest, report or prices')
    .strict()
    .help();
}

export async function runUsageCli(deps: UsageCliDeps = {}): Promise<void> {
  await buildUsageCli(hideBin(process.argv), deps).parseAsync();
}
