/**
 * `cli-usage` report, window, task, context, snapshot and allotment commands
 * (RFC-0050 A4 and A5). Every collaborator is injectable so tests never touch
 * the home directory, the clock or git.
 *
 * @module usage/commands
 */

import {
  readModelCalls,
  readPriceHistory,
  type ModelCallFilter,
  type ModelCallRecord,
  type PriceRow,
} from '@ai-sdlc/reference';
import type { Argv } from 'yargs';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import {
  GROUP_KEYS,
  buildContextView,
  buildUsageReport,
  renderContextText,
  renderReportCsv,
  renderReportJson,
  renderReportText,
  type GroupKey,
} from './report.js';
import {
  appendSnapshot,
  buildAllotmentSeries,
  latestAllotments,
  readLimitObservations,
  readSnapshots,
  snapshotsFromObservations,
  type AllotmentRow,
  type Snapshot,
} from './snapshots.js';
import { UNITS_PROXY_NOTE, deriveUnitWeights, describeWeights, type UnitWeights } from './units.js';
import {
  loadUsageConfig,
  type LoadUsageConfigOptions,
  type ResolvedUsageConfig,
  type WindowSpec,
} from './usage-config.js';
import {
  recordTimes,
  usageInRange,
  viewWindow,
  windowRangeAt,
  type WindowView,
} from './windows.js';

export interface UsageViewDeps {
  now?: () => Date;
  /** Usage directory override; otherwise `AI_SDLC_USAGE_DIR` then the home default. */
  usageDir?: string;
  /** Repository root for the base-ref config read. */
  workDir?: string;
  /** Base-ref config reader (tests). */
  readBaseConfig?: LoadUsageConfigOptions['readBaseConfig'];
  /** Replaces the whole config load (tests). */
  loadConfig?: (opts: LoadUsageConfigOptions) => ResolvedUsageConfig;
  /** Price rows (tests); otherwise the price history in the usage directory. */
  priceRows?: ReadonlyArray<PriceRow>;
  emit?: (event: Omit<OrchestratorEvent, 'ts'>) => void;
}

export interface UsageIo {
  out: (text: string) => void;
  err: (text: string) => void;
  exit: (code: number) => void;
}

interface Context {
  now: Date;
  config: ResolvedUsageConfig;
  weights: UnitWeights;
  priceRows: ReadonlyArray<PriceRow>;
}

function context(deps: UsageViewDeps, io: UsageIo): Context {
  const now = deps.now?.() ?? new Date();
  const config = (deps.loadConfig ?? loadUsageConfig)({
    dir: deps.usageDir,
    workDir: deps.workDir,
    readBaseConfig: deps.readBaseConfig,
  });
  for (const w of config.warnings) io.err(`${w}\n`);
  const priceRows = deps.priceRows ?? readPriceHistory({ dir: deps.usageDir });
  const weights = deriveUnitWeights(priceRows, now.toISOString(), config.weights);
  return { now, config, weights, priceRows };
}

async function loadRecords(
  deps: UsageViewDeps,
  filter: ModelCallFilter,
): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls(filter, { dir: deps.usageDir })) out.push(r);
  return out;
}

function parseInstant(label: string, v: string | undefined, io: UsageIo): Date | undefined | 'bad' {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    io.err(`Invalid ${label} value "${v}"; use an ISO date or timestamp.\n`);
    io.exit(1);
    return 'bad';
  }
  return d;
}

interface RangeArgs {
  since?: string;
  until?: string;
  scope?: string;
}

function rangeFilter(args: RangeArgs, io: UsageIo): ModelCallFilter | undefined {
  const from = parseInstant('--since', args.since, io);
  const to = parseInstant('--until', args.until, io);
  if (from === 'bad' || to === 'bad') return undefined;
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(args.scope === 'framework' || args.scope === 'other' ? { scope: args.scope } : {}),
  };
}

function withRange<T>(y: Argv<T>) {
  return y
    .option('since', { type: 'string', description: 'Include calls at or after this ISO date' })
    .option('until', { type: 'string', description: 'Include calls before this ISO date' })
    .option('scope', {
      type: 'string',
      choices: ['framework', 'other', 'all'] as const,
      default: 'all',
      description: 'Which attribution scope to include',
    });
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function renderWindowViews(views: readonly WindowView[], weights: UnitWeights): string {
  const lines: string[] = [];
  for (const v of views) {
    lines.push(`${v.window} window (${v.lengthHours}h)`);
    if (!v.start) {
      lines.push('  no window is open; no calls in range');
    } else {
      lines.push(`  window:  ${v.start} to ${v.end}`);
      lines.push(`  used:    ${fmtNum(v.units)} units over ${v.calls} calls`);
    }
    if (v.impliedAllotment !== undefined) {
      const pct =
        v.percentOfAllotment !== undefined ? ` (${v.percentOfAllotment.toFixed(1)}% used)` : '';
      lines.push(`  implied allotment: ${fmtNum(v.impliedAllotment)} units${pct}`);
    } else {
      lines.push('  implied allotment: unknown (record one with: cli-usage snapshot)');
    }
    if (v.ratePerHour !== undefined) {
      const proj =
        v.hoursToLimit !== undefined
          ? `; projected time to the limit ${v.hoursToLimit.toFixed(1)} hours`
          : '';
      lines.push(`  rate:    ${fmtNum(v.ratePerHour)} units/hour${proj}`);
    }
  }
  lines.push(describeWeights(weights));
  return `${lines.join('\n')}\n`;
}

export function renderAllotmentRows(rows: readonly AllotmentRow[], tolerance: number): string {
  if (rows.length === 0) {
    return 'No snapshots yet. Record one with: cli-usage snapshot --window <name> --used-pct <n>\n';
  }
  const header = ['window', 'time', 'used_pct', 'units', 'implied_allotment', 'change', 'note'];
  const body = rows.map((r) => [
    r.window,
    r.ts,
    r.usedPercent.toFixed(1),
    fmtNum(r.units),
    fmtNum(r.impliedAllotment),
    r.changeRatio === undefined ? '-' : `${(r.changeRatio * 100).toFixed(1)}%`,
    r.suspected ? 'probable allotment change' : '',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return `${[
    fmt(header),
    ...body.map(fmt),
    `Change tolerance ${(tolerance * 100).toFixed(0)}%, compared only when the model mix is similar.`,
    UNITS_PROXY_NOTE,
  ].join('\n')}\n`;
}

/** Manual snapshots plus the observations harnesses wrote to the limit-event log. */
export function allSnapshots(
  deps: Pick<UsageViewDeps, 'usageDir'>,
  ctx: Pick<Context, 'config' | 'weights'>,
  records: readonly ModelCallRecord[],
): Snapshot[] {
  const auto = snapshotsFromObservations(
    readLimitObservations({ dir: deps.usageDir }),
    records,
    ctx.config.windows,
    ctx.weights,
  );
  return [...readSnapshots({ dir: deps.usageDir }), ...auto];
}

export function registerUsageViewCommands(y: Argv, deps: UsageViewDeps, io: UsageIo): Argv {
  const emit = (event: Omit<OrchestratorEvent, 'ts'>): void => deps.emit?.(event);

  return y
    .command(
      'report',
      'Usage by model, role, task, repo, pool, day or window',
      (c) =>
        withRange(c)
          .option('group-by', {
            type: 'string',
            array: true,
            choices: [...GROUP_KEYS],
            default: [] as string[],
            description: 'Grouping (repeatable): model, role, task, repo, pool, day, window',
          })
          .option('format', {
            type: 'string',
            choices: ['text', 'json', 'csv'] as const,
            default: 'text',
          }),
      async (argv) => {
        const filter = rangeFilter(argv, io);
        if (!filter) return;
        const ctx = context(deps, io);
        const records = await loadRecords(deps, filter);
        const windowSpec = [...ctx.config.windows].sort((a, b) => a.lengthHours - b.lengthHours)[0];
        const report = buildUsageReport({
          records,
          groupBy: (argv['group-by'] as string[]).filter((g): g is GroupKey =>
            (GROUP_KEYS as readonly string[]).includes(g),
          ),
          weights: ctx.weights,
          priceRows: ctx.priceRows,
          windowSpec,
        });
        if (argv.format === 'json') io.out(renderReportJson(report));
        else if (argv.format === 'csv') {
          io.out(renderReportCsv(report));
          io.err(`${report.unitsNote}\n`);
        } else io.out(renderReportText(report));
      },
    )
    .command(
      'window',
      'Units used in the current windows, implied allotment and projected time to the limit',
      (c) =>
        c.option('format', { type: 'string', choices: ['text', 'json'] as const, default: 'text' }),
      async (argv) => {
        const ctx = context(deps, io);
        const records = await loadRecords(deps, {});
        const series = buildAllotmentSeries(allSnapshots(deps, ctx, records), ctx.config);
        const latest = latestAllotments(series);
        const views = ctx.config.windows.map((w) =>
          viewWindow(w, records, ctx.weights, ctx.now.getTime(), latest.get(w.name)),
        );
        io.out(
          argv.format === 'json'
            ? `${JSON.stringify({ windows: views, unitsNote: describeWeights(ctx.weights) }, null, 2)}\n`
            : renderWindowViews(views, ctx.weights),
        );
      },
    )
    .command(
      'task <id>',
      'Tokens and units for one task, split by role',
      (c) =>
        c.positional('id', { type: 'string', demandOption: true }).option('format', {
          type: 'string',
          choices: ['text', 'json', 'csv'] as const,
          default: 'text',
        }),
      async (argv) => {
        const ctx = context(deps, io);
        const records = await loadRecords(deps, { taskId: String(argv.id) });
        const report = buildUsageReport({
          records,
          groupBy: ['role'],
          weights: ctx.weights,
          priceRows: ctx.priceRows,
        });
        if (argv.format === 'json') io.out(renderReportJson(report));
        else if (argv.format === 'csv') {
          io.out(renderReportCsv(report));
          io.err(`${report.unitsNote}\n`);
        } else {
          io.out(
            records.length === 0
              ? `No usage recorded for task ${argv.id}.\n`
              : `Task ${argv.id}\n${renderReportText(report)}`,
          );
        }
      },
    )
    .command(
      'context',
      'Context overhead per session: first-call tokens, turns and total cache read',
      (c) =>
        withRange(c)
          .option('limit', { type: 'number', default: 20, description: 'Rows to show' })
          .option('format', {
            type: 'string',
            choices: ['text', 'json'] as const,
            default: 'text',
          }),
      async (argv) => {
        const filter = rangeFilter(argv, io);
        if (!filter) return;
        const rows = buildContextView(await loadRecords(deps, filter)).slice(
          0,
          Math.max(1, argv.limit),
        );
        io.out(
          argv.format === 'json' ? `${JSON.stringify(rows, null, 2)}\n` : renderContextText(rows),
        );
      },
    )
    .command(
      'snapshot',
      'Record the percentage the provider shows for a window as a calibration point',
      (c) =>
        c
          .option('window', { type: 'string', demandOption: true, description: 'Window name' })
          .option('used-pct', {
            type: 'number',
            demandOption: true,
            description: 'Percent of the window the provider shows as used (above 0, at most 100)',
          })
          .option('at', { type: 'string', description: 'Observation time (default now)' }),
      async (argv) => {
        const ctx = context(deps, io);
        const spec: WindowSpec | undefined = ctx.config.windows.find((w) => w.name === argv.window);
        if (!spec) {
          io.err(
            `Unknown window "${argv.window}". Known: ${ctx.config.windows.map((w) => w.name).join(', ')}\n`,
          );
          io.exit(1);
          return;
        }
        const at = parseInstant('--at', argv.at, io);
        if (at === 'bad') return;
        const atMs = (at ?? ctx.now).getTime();
        const records = await loadRecords(deps, {});
        const range = windowRangeAt(spec, recordTimes(records), atMs);
        const usage = range ? usageInRange(records, range.start, atMs, ctx.weights) : undefined;
        if (!usage || usage.units <= 0) {
          io.err(`No usage in the ${spec.name} window at that time, so it cannot be calibrated.\n`);
          io.exit(1);
          return;
        }
        const snap: Snapshot = {
          ts: new Date(atMs).toISOString(),
          window: spec.name,
          usedPercent: argv['used-pct'],
          units: usage.units,
          source: 'manual',
          modelMix: usage.modelMix,
        };
        try {
          appendSnapshot(snap, { dir: deps.usageDir });
        } catch (err) {
          io.err(`${err instanceof Error ? err.message : String(err)}\n`);
          io.exit(1);
          return;
        }
        const series = buildAllotmentSeries(readSnapshots({ dir: deps.usageDir }), ctx.config);
        const row = series.filter((r) => r.window === spec.name && r.ts === snap.ts).pop();
        io.out(
          `Recorded ${spec.name} snapshot: ${fmtNum(snap.units)} units at ${snap.usedPercent}% ` +
            `implies an allotment of ${fmtNum(row?.impliedAllotment ?? 0)} units.\n`,
        );
        emit({
          type: 'UsageLimitObserved',
          window: spec.name,
          usedPercent: snap.usedPercent,
          unitsInWindow: snap.units,
          impliedAllotment: row?.impliedAllotment,
          observationSource: 'manual',
        });
        if (row?.suspected && row.previousAllotment !== undefined) {
          emit({
            type: 'AllotmentChangeSuspected',
            window: spec.name,
            previousAllotment: row.previousAllotment,
            impliedAllotment: row.impliedAllotment,
            changeRatio: row.changeRatio,
          });
          io.out(
            `Probable allotment change: ${((row.changeRatio ?? 0) * 100).toFixed(1)}% against the previous snapshot.\n`,
          );
        }
      },
    )
    .command(
      'allotment',
      'Implied allotment per window from the calibration snapshots',
      (c) =>
        c.option('window', { type: 'string', description: 'Only this window' }).option('format', {
          type: 'string',
          choices: ['text', 'json'] as const,
          default: 'text',
        }),
      async (argv) => {
        const ctx = context(deps, io);
        const records = await loadRecords(deps, {});
        let rows = buildAllotmentSeries(allSnapshots(deps, ctx, records), ctx.config);
        if (argv.window) rows = rows.filter((r) => r.window === argv.window);
        io.out(
          argv.format === 'json'
            ? `${JSON.stringify({ rows, unitsNote: describeWeights(ctx.weights) }, null, 2)}\n`
            : renderAllotmentRows(rows, ctx.config.allotmentTolerance),
        );
      },
    );
}
