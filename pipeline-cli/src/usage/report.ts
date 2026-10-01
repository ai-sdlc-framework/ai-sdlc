/**
 * Usage report aggregation and rendering (RFC-0050 A5).
 *
 * Rows carry calls, the five token classes separately, weighted units and
 * API-equivalent cost. A model with no price row is `unpriced`: it is left out
 * of cost totals and the total is labelled partial. Nothing here reads or
 * prints anything but counts, ids and attribution.
 *
 * @module usage/report
 */

import {
  UNPRICED,
  priceCallBreakdown,
  type ModelCallRecord,
  type PriceRow,
} from '@ai-sdlc/reference';
import { describeWeights, hasModelWeight, unitsForCall, type UnitWeights } from './units.js';
import type { WindowSpec } from './usage-config.js';
import { bucketStarter, recordTimes } from './windows.js';

export const GROUP_KEYS = ['model', 'role', 'task', 'repo', 'pool', 'day', 'window'] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export type CostStatus = 'priced' | 'partial' | 'unpriced';

export interface ReportRow {
  /** One entry per requested grouping, in the order requested. */
  keys: Partial<Record<GroupKey, string>>;
  calls: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  units: number;
  /** API-equivalent cost of the priced calls in the row, USD. */
  costUsd: number;
  costStatus: CostStatus;
}

export interface ReportTotals extends Omit<ReportRow, 'keys'> {
  /** True when some calls were unpriced and left out of `costUsd`. */
  costPartial: boolean;
}

export interface UsageReport {
  groupBy: GroupKey[];
  rows: ReportRow[];
  totals: ReportTotals;
  unpricedModels: string[];
  /** Models counted at a neutral 1.0 multiplier for units because no weight is known. */
  unweightedModels: string[];
  unitsNote: string;
}

export interface BuildReportInput {
  records: readonly ModelCallRecord[];
  groupBy: readonly GroupKey[];
  weights: UnitWeights;
  priceRows: ReadonlyArray<PriceRow>;
  /** Window spec used for the `window` grouping. */
  windowSpec?: WindowSpec;
}

function dayOf(ts: string): string {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 'unknown' : new Date(ms).toISOString().slice(0, 10);
}

interface Acc {
  keys: Partial<Record<GroupKey, string>>;
  calls: number;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  units: number;
  costUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

function emptyAcc(keys: Partial<Record<GroupKey, string>>): Acc {
  return {
    keys,
    calls: 0,
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    units: 0,
    costUsd: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
  };
}

function statusOf(a: Pick<Acc, 'pricedCalls' | 'unpricedCalls'>): CostStatus {
  if (a.unpricedCalls === 0) return 'priced';
  return a.pricedCalls === 0 ? 'unpriced' : 'partial';
}

function windowLabel(spec: WindowSpec, startMs: number): string {
  return `${spec.name} ${new Date(startMs).toISOString().slice(0, 16)}Z`;
}

export function buildUsageReport(input: BuildReportInput): UsageReport {
  const { records, groupBy, weights, priceRows } = input;
  const startOf =
    groupBy.includes('window') && input.windowSpec
      ? bucketStarter(input.windowSpec, recordTimes(records))
      : undefined;

  const groups = new Map<string, Acc>();
  const total = emptyAcc({});
  const unpriced = new Set<string>();
  const unweighted = new Set<string>();

  for (const r of records) {
    const keys: Partial<Record<GroupKey, string>> = {};
    for (const g of groupBy) {
      switch (g) {
        case 'model':
          keys.model = r.model;
          break;
        case 'role':
          keys.role = r.agentRole;
          break;
        case 'task':
          keys.task = r.taskId ?? '(none)';
          break;
        case 'repo':
          keys.repo = r.repo ?? '(none)';
          break;
        case 'pool':
          keys.pool = r.billingPool;
          break;
        case 'day':
          keys.day = dayOf(r.ts);
          break;
        case 'window': {
          const t = Date.parse(r.ts);
          keys.window =
            startOf && input.windowSpec && !Number.isNaN(t)
              ? windowLabel(input.windowSpec, startOf(t))
              : 'unknown';
          break;
        }
      }
    }
    const id = groupBy.map((g) => keys[g]).join('\u0000');
    let acc = groups.get(id);
    if (!acc) {
      acc = emptyAcc(keys);
      groups.set(id, acc);
    }

    const units = unitsForCall(r, weights);
    if (!hasModelWeight(r.model, weights)) unweighted.add(r.model);
    const cost = priceCallBreakdown(r, { rows: priceRows });
    for (const a of [acc, total]) {
      a.calls += 1;
      a.input += r.tokens.input;
      a.cacheWrite5m += r.tokens.cacheWrite5m;
      a.cacheWrite1h += r.tokens.cacheWrite1h;
      a.cacheRead += r.tokens.cacheRead;
      a.output += r.tokens.output;
      a.units += units;
      if (cost === UNPRICED) {
        a.unpricedCalls += 1;
      } else {
        a.pricedCalls += 1;
        a.costUsd += cost.total;
      }
    }
    if (cost === UNPRICED) unpriced.add(r.model);
  }

  const rows: ReportRow[] = [...groups.values()]
    .sort((a, b) => {
      for (const g of groupBy) {
        const c = (a.keys[g] ?? '').localeCompare(b.keys[g] ?? '');
        if (c !== 0) return c;
      }
      return 0;
    })
    .map(({ pricedCalls, unpricedCalls, ...rest }) => ({
      ...rest,
      costStatus: statusOf({ pricedCalls, unpricedCalls }),
    }));

  const { pricedCalls, unpricedCalls, keys: _keys, ...totalRest } = total;
  void _keys;
  return {
    groupBy: [...groupBy],
    rows,
    totals: {
      ...totalRest,
      costStatus: statusOf({ pricedCalls, unpricedCalls }),
      costPartial: unpricedCalls > 0,
    },
    unpricedModels: [...unpriced].sort(),
    unweightedModels: [...unweighted].sort(),
    unitsNote: describeWeights(weights),
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const INT = (n: number): string => Math.round(n).toLocaleString('en-US');

function costCell(costUsd: number, status: CostStatus): string {
  if (status === 'unpriced') return 'unpriced';
  const s = `$${costUsd.toFixed(4)}`;
  return status === 'partial' ? `${s} (partial)` : s;
}

const NUMERIC_HEADERS = [
  'calls',
  'input',
  'cache_write_5m',
  'cache_write_1h',
  'cache_read',
  'output',
  'units',
  'cost_usd',
] as const;

function cells(row: Pick<ReportRow, Exclude<keyof ReportRow, 'keys'>>): string[] {
  return [
    INT(row.calls),
    INT(row.input),
    INT(row.cacheWrite5m),
    INT(row.cacheWrite1h),
    INT(row.cacheRead),
    INT(row.output),
    INT(row.units),
    costCell(row.costUsd, row.costStatus),
  ];
}

function padTable(header: string[], body: string[][], keyCols: number): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r.map((c, i) => (i < keyCols ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(fmt)];
}

export function renderReportText(report: UsageReport): string {
  if (report.totals.calls === 0) return 'No usage recorded for this range.\n';
  const keyCols = report.groupBy.length;
  const header = [...report.groupBy, ...NUMERIC_HEADERS];
  const body = report.rows.map((r) => [...report.groupBy.map((g) => r.keys[g] ?? ''), ...cells(r)]);
  const totalRow = [
    ...report.groupBy.map((_, i) => (i === 0 ? 'TOTAL' : '')),
    ...cells(report.totals),
  ];
  const out = padTable(header, keyCols ? [...body, totalRow] : [totalRow], keyCols);
  if (report.totals.costPartial) {
    const n = report.unpricedModels.length;
    out.push(
      `Cost total is partial: ${report.unpricedModels.join(', ')} ${n === 1 ? 'has' : 'have'} no price and ${n === 1 ? 'is' : 'are'} left out.`,
    );
  }
  if (report.unweightedModels.length) {
    out.push(
      `No unit weight for ${report.unweightedModels.join(', ')}; counted at the neutral multiplier 1.`,
    );
  }
  out.push(report.unitsNote);
  return `${out.join('\n')}\n`;
}

export function renderReportJson(report: UsageReport): string {
  const row = (r: ReportRow): Record<string, unknown> => ({
    ...r.keys,
    calls: r.calls,
    input: r.input,
    cacheWrite5m: r.cacheWrite5m,
    cacheWrite1h: r.cacheWrite1h,
    cacheRead: r.cacheRead,
    output: r.output,
    units: r.units,
    costUsd: r.costStatus === 'unpriced' ? null : r.costUsd,
    costStatus: r.costStatus,
  });
  return `${JSON.stringify(
    {
      groupBy: report.groupBy,
      rows: report.rows.map(row),
      totals: { ...row({ keys: {}, ...report.totals }), costPartial: report.totals.costPartial },
      unpricedModels: report.unpricedModels,
      unitsNote: report.unitsNote,
    },
    null,
    2,
  )}\n`;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderReportCsv(report: UsageReport): string {
  const header = [...report.groupBy, ...NUMERIC_HEADERS, 'cost_status'];
  const line = (keys: string[], r: Omit<ReportRow, 'keys'>): string =>
    [
      ...keys,
      r.calls,
      r.input,
      r.cacheWrite5m,
      r.cacheWrite1h,
      r.cacheRead,
      r.output,
      r.units,
      r.costStatus === 'unpriced' ? 'unpriced' : r.costUsd,
      r.costStatus,
    ]
      .map((v) => csvEscape(String(v)))
      .join(',');
  const lines = [
    header.join(','),
    ...report.rows.map((r) =>
      line(
        report.groupBy.map((g) => r.keys[g] ?? ''),
        r,
      ),
    ),
  ];
  // An ungrouped report is one row that already is the total.
  if (report.groupBy.length > 0) {
    lines.push(
      line(
        report.groupBy.map((_, i) => (i === 0 ? 'TOTAL' : '')),
        report.totals,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── Task and context views ──────────────────────────────────────────────────

export interface ContextRow {
  session: string;
  agent: string;
  scope: 'framework' | 'other';
  /** Input-side tokens of the session's first call: the fixed prefix every later turn re-reads. */
  firstCallTokens: number;
  turns: number;
  totalCacheRead: number;
  /** Transcript path; present for framework scope only. */
  path?: string;
}

/** Per-session context overhead, largest total cache read first. */
export function buildContextView(records: readonly ModelCallRecord[]): ContextRow[] {
  const bySession = new Map<string, ModelCallRecord[]>();
  for (const r of records) {
    const key = `${r.sessionId}\u0000${r.agentId ?? ''}`;
    const list = bySession.get(key) ?? [];
    list.push(r);
    bySession.set(key, list);
  }
  const rows: ContextRow[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const first = list[0];
    const t = first.tokens;
    const scope = list.every((r) => r.scope === 'framework') ? 'framework' : 'other';
    rows.push({
      session: first.sessionId,
      agent: first.agentId ?? first.agentRole,
      scope,
      firstCallTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
      turns: list.length,
      totalCacheRead: list.reduce((s, r) => s + r.tokens.cacheRead, 0),
      // An other-scope session never shows a path, even if a record carried one.
      ...(scope === 'framework' && first.source?.file ? { path: first.source.file } : {}),
    });
  }
  return rows.sort((a, b) => b.totalCacheRead - a.totalCacheRead);
}

export function renderContextText(rows: readonly ContextRow[]): string {
  if (rows.length === 0) return 'No sessions recorded for this range.\n';
  const header = [
    'session',
    'agent',
    'scope',
    'first_call_tokens',
    'turns',
    'total_cache_read',
    'path',
  ];
  const body = rows.map((r) => [
    r.session,
    r.agent,
    r.scope,
    INT(r.firstCallTokens),
    INT(r.turns),
    INT(r.totalCacheRead),
    r.path ?? '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return `${[fmt(header), ...body.map(fmt)].join('\n')}\n`;
}
