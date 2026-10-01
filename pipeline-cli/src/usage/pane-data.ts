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

function top(rows: readonly ReportRow[]): ReportRow[] {
  return [...rows].sort((a, b) => b.units - a.units).slice(0, TOP_CONSUMERS);
}

async function readAll(deps: UsagePaneDeps): Promise<ModelCallRecord[]> {
  if (deps.readRecords) return deps.readRecords();
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls({}, { dir: deps.usageDir })) out.push(r);
  return out;
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
  const records = await readAll(deps);

  const series = buildAllotmentSeries(allSnapshots(deps, { config, weights }, records), config);
  const latest = latestAllotments(series);
  const windows = config.windows.map((w) =>
    viewWindow(w, records, weights, now, latest.get(w.name)),
  );

  const observations = readLimitObservations({ dir: deps.usageDir });
  const lastLimitEvent = [...observations].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  const allotmentChange = [...series]
    .filter((r) => r.suspected)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];

  const data: UsagePaneData = {
    empty: records.length === 0,
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
