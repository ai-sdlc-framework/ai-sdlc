/**
 * Data for the operator TUI usage pane (RFC-0050 A5): the window view, the top
 * consumers of the current weekly window, the latest limit event and any
 * suspected allotment change. It composes the existing ledger reader and the
 * window, report and snapshot functions; it adds no report logic of its own and
 * never reads message text. Counts, model ids, agent roles and timestamps only.
 *
 * @module usage/pane-data
 */

import {
  readModelCalls,
  readPriceHistory,
  type ModelCallRecord,
  type PriceRow,
} from '@ai-sdlc/reference';
import { allSnapshots } from './commands.js';
import { buildUsageReport, type ReportRow } from './report.js';
import {
  buildAllotmentSeries,
  latestAllotments,
  readLimitObservations,
  type AllotmentRow,
  type LimitObservation,
} from './snapshots.js';
import { deriveUnitWeights } from './units.js';
import {
  loadUsageConfig,
  type LoadUsageConfigOptions,
  type ResolvedUsageConfig,
  type WindowSpec,
} from './usage-config.js';
import { recordTimes, viewWindow, windowRangeAt, type WindowView } from './windows.js';

/** Consumers shown per grouping. */
export const TOP_CONSUMERS = 5;

export interface UsagePaneDeps {
  now?: () => Date;
  /** Usage directory override; otherwise `AI_SDLC_USAGE_DIR` then the home default. */
  usageDir?: string;
  /** Replaces the whole config load (tests). */
  loadConfig?: (opts: LoadUsageConfigOptions) => ResolvedUsageConfig;
  priceRows?: ReadonlyArray<PriceRow>;
  /** Replaces the ledger read (tests). */
  readRecords?: () => Promise<ModelCallRecord[]>;
}

export interface UsagePaneData {
  /** True when the ledger has no records at all. */
  empty: boolean;
  windows: WindowView[];
  /** Name of the window the consumers are drawn from. */
  consumerWindow?: string;
  topByRole: ReportRow[];
  topByModel: ReportRow[];
  lastLimitEvent?: LimitObservation;
  allotmentChange?: AllotmentRow;
}

/** The weekly window: the one named `weekly`, else the longest. */
export function pickConsumerWindow(windows: readonly WindowSpec[]): WindowSpec | undefined {
  return (
    windows.find((w) => w.name === 'weekly') ??
    [...windows].sort((a, b) => b.lengthHours - a.lengthHours)[0]
  );
}

function rowName(r: ReportRow): string {
  return Object.values(r.keys).join('\u0000');
}

/** Highest units first; equal units are ordered by name so the list never reshuffles. */
export function top(rows: readonly ReportRow[]): ReportRow[] {
  return [...rows]
    .sort((a, b) => b.units - a.units || rowName(a).localeCompare(rowName(b)))
    .slice(0, TOP_CONSUMERS);
}

const HOUR_MS = 3_600_000;

async function collect(deps: UsagePaneDeps, from?: string): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls(from ? { from } : {}, { dir: deps.usageDir })) out.push(r);
  return out;
}

/**
 * Read the records the view needs without scanning the whole ledger on every
 * refresh. Correctness comes first: the result is identical to a full read for
 * everything the pane shows.
 *
 * The oldest record it must see is the start of the longest window, or the start
 * of the window a limit observation refers to when that is older (those
 * observations are turned into snapshots using the records of their window).
 * A first-use window opens at the first call after a gap as long as the window,
 * so where that window starts depends on older history. The lookback therefore
 * doubles until the earliest record read follows a gap of at least the longest
 * first-use window (older history can then no longer move any window start) or
 * the start of the ledger is reached.
 */
async function readNeeded(
  deps: UsagePaneDeps,
  config: ResolvedUsageConfig,
  now: number,
  observations: readonly LimitObservation[],
): Promise<{ records: ModelCallRecord[]; ledgerEmpty: boolean }> {
  if (deps.readRecords) {
    const records = await deps.readRecords();
    return { records, ledgerEmpty: records.length === 0 };
  }
  let oldest: string | undefined;
  for await (const r of readModelCalls({}, { dir: deps.usageDir })) {
    oldest = r.ts;
    break;
  }
  if (oldest === undefined) return { records: [], ledgerEmpty: true };
  const oldestMs = Date.parse(oldest);
  const maxLen = Math.max(1, ...config.windows.map((w) => w.lengthHours)) * HOUR_MS;
  const gapNeeded =
    Math.max(0, ...config.windows.filter((w) => w.mode === 'first-use').map((w) => w.lengthHours)) *
    HOUR_MS;
  let obsStart = Number.POSITIVE_INFINITY;
  for (const o of observations) {
    const len = o.windowMinutes !== undefined ? o.windowMinutes * 60_000 : maxLen;
    const resets = o.resetsAt ? Date.parse(o.resetsAt) : Number.NaN;
    obsStart = Math.min(obsStart, (Number.isNaN(resets) ? Date.parse(o.ts) : resets) - len);
  }
  let span = maxLen;
  for (;;) {
    const fromMs = Math.min(now - span, obsStart - span + maxLen);
    if (!(fromMs > oldestMs)) return { records: await collect(deps), ledgerEmpty: false };
    const from = new Date(fromMs).toISOString();
    const records = await collect(deps, from);
    const earliest = records[0] ? Date.parse(records[0].ts) : Number.POSITIVE_INFINITY;
    if (earliest - fromMs >= gapNeeded) return { records, ledgerEmpty: false };
    span *= 2;
  }
}

/** Load everything the pane shows. Throws on an unreadable ledger; the pane catches it. */
export async function loadUsagePaneData(deps: UsagePaneDeps = {}): Promise<UsagePaneData> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const config = (deps.loadConfig ?? loadUsageConfig)({
    dir: deps.usageDir,
    // The pane never shells out: skip the base-ref read, use machine config or defaults.
    readBaseConfig: () => null,
  });
  const priceRows = deps.priceRows ?? readPriceHistory({ dir: deps.usageDir });
  const weights = deriveUnitWeights(priceRows, new Date(now).toISOString(), config.weights);
  const observations = readLimitObservations({ dir: deps.usageDir });
  const { records, ledgerEmpty } = await readNeeded(deps, config, now, observations);

  const series = buildAllotmentSeries(allSnapshots(deps, { config, weights }, records), config);
  const latest = latestAllotments(series);
  const windows = config.windows.map((w) =>
    viewWindow(w, records, weights, now, latest.get(w.name)),
  );

  const lastLimitEvent = [...observations].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const allotmentChange = [...series]
    .filter((r) => r.suspected)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];

  const data: UsagePaneData = {
    empty: ledgerEmpty,
    windows,
    topByRole: [],
    topByModel: [],
    ...(lastLimitEvent ? { lastLimitEvent } : {}),
    ...(allotmentChange ? { allotmentChange } : {}),
  };

  const spec = pickConsumerWindow(config.windows);
  if (spec) {
    data.consumerWindow = spec.name;
    const range = windowRangeAt(spec, recordTimes(records), now);
    if (range) {
      const inRange = records.filter((r) => {
        const t = Date.parse(r.ts);
        return t >= range.start && t <= now;
      });
      const build = (groupBy: ['role'] | ['model']): ReportRow[] =>
        top(buildUsageReport({ records: inRange, groupBy, weights, priceRows }).rows);
      data.topByRole = build(['role']);
      data.topByModel = build(['model']);
    }
  }
  return data;
}
