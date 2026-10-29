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
import type { TranscriptInspector } from './transcript-inspect.js';
import {
  roleFromSessionName,
  type BudgetRole,
  type RoleBudget,
  type WindowSpec,
} from './usage-config.js';
import { bucketStarter, recordTimes } from './windows.js';
import { csvEscape } from './csv.js';

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

/** How many single-turn context growths are listed per session. */
export const TOP_GROWTH_COUNT = 10;

export interface ContextGrowth {
  /** Provider message id of the call that grew the context. */
  callId: string;
  ts: string;
  /** Tokens newly written to the cache by the call (`cache_creation_input_tokens`). */
  tokens: number;
  /**
   * Tool(s) invoked by the preceding call, whose results entered the context
   * here; `(session start)` for the first call, `(no tool)` when the preceding
   * call invoked none, `-` when the transcript could not be read.
   */
  tool: string;
}

export interface ContextRow {
  session: string;
  agent: string;
  scope: 'framework' | 'other';
  /** Input-side tokens of the session's first call: the fixed prefix every later turn re-reads. */
  firstCallTokens: number;
  /** Input-side tokens of the session's last call: its context size now. */
  contextTokens: number;
  turns: number;
  /** Calls since the last `/clear` recorded in the transcript; equals `turns` when none or unreadable. */
  turnsSinceClear: number;
  totalCacheRead: number;
  /** Hierarchy role resolved from the session name; absent when unknown. */
  role?: BudgetRole;
  /** Over the role's context or turn budget; null when the role is unknown or the row is a subagent. */
  overBudget: boolean | null;
  /** The largest single-turn context growths, biggest first. */
  topGrowths: ContextGrowth[];
  /** Transcript path; present for framework scope only. */
  path?: string;
}

export interface ContextViewOptions {
  /** Budgets per role; without them `overBudget` is null. */
  roles?: Record<BudgetRole, RoleBudget>;
  /** Role to assume for main sessions whose name does not resolve. */
  defaultRole?: BudgetRole;
  /** Reads the transcript of framework sessions; without it the view uses the ledger alone. */
  inspect?: TranscriptInspector;
}

const inputSide = (r: ModelCallRecord): number =>
  r.tokens.input + r.tokens.cacheWrite5m + r.tokens.cacheWrite1h + r.tokens.cacheRead;

const cacheWritten = (r: ModelCallRecord): number => r.tokens.cacheWrite5m + r.tokens.cacheWrite1h;

/** Per-session context overhead, largest total cache read first. */
export function buildContextView(
  records: readonly ModelCallRecord[],
  options: ContextViewOptions = {},
): ContextRow[] {
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
    const last = list[list.length - 1];
    const scope = list.every((r) => r.scope === 'framework') ? 'framework' : 'other';
    const file = scope === 'framework' ? first.source?.file : undefined;

    // The ten calls that wrote the most to the cache; the tool is whatever the call before them ran.
    const growthIdx = list
      .map((_, i) => i)
      .filter((i) => cacheWritten(list[i]) > 0)
      .sort((a, b) => cacheWritten(list[b]) - cacheWritten(list[a]) || a - b)
      .slice(0, TOP_GROWTH_COUNT);
    const wanted = new Set(growthIdx.filter((i) => i > 0).map((i) => list[i - 1].callId));
    const facts = file && options.inspect ? options.inspect(file, wanted) : undefined;

    const lastClear = facts?.clearTimes.length ? Math.max(...facts.clearTimes) : undefined;
    const turnsSinceClear =
      lastClear === undefined
        ? list.length
        : list.filter((r) => Date.parse(r.ts) > lastClear).length;

    const role = first.agentId
      ? undefined
      : (roleFromSessionName(facts?.sessionName) ?? options.defaultRole);
    const budget = role ? options.roles?.[role] : undefined;
    const overBudget = budget
      ? inputSide(last) > budget.contextBudgetTokens || turnsSinceClear > budget.turnBudget
      : null;

    const toolOf = (i: number): string => {
      if (i === 0) return '(session start)';
      if (!facts?.readable) return '-';
      const names = facts.toolsByCallId.get(list[i - 1].callId);
      return names && names.length > 0 ? names.join(',') : '(no tool)';
    };

    rows.push({
      session: first.sessionId,
      agent: first.agentId ?? first.agentRole,
      scope,
      firstCallTokens: inputSide(first),
      contextTokens: inputSide(last),
      turns: list.length,
      turnsSinceClear,
      totalCacheRead: list.reduce((s, r) => s + r.tokens.cacheRead, 0),
      ...(role ? { role } : {}),
      overBudget,
      topGrowths: growthIdx.map((i) => ({
        callId: list[i].callId,
        ts: list[i].ts,
        tokens: cacheWritten(list[i]),
        tool: toolOf(i),
      })),
      // An other-scope session never shows a path, even if a record carried one.
      ...(file ? { path: file } : {}),
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
    'role',
    'first_call_tokens',
    'context_tokens',
    'turns',
    'turnsSinceClear',
    'overBudget',
    'total_cache_read',
    'path',
  ];
  const body = rows.map((r) => [
    r.session,
    r.agent,
    r.scope,
    r.role ?? '-',
    INT(r.firstCallTokens),
    INT(r.contextTokens),
    INT(r.turns),
    INT(r.turnsSinceClear),
    r.overBudget === null ? 'n/a' : String(r.overBudget),
    INT(r.totalCacheRead),
    r.path ?? '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const out = [fmt(header), ...body.map(fmt)];
  for (const r of rows) {
    if (r.topGrowths.length === 0) continue;
    out.push('', `Largest single-turn context growths, ${r.session} (${r.agent}):`);
    r.topGrowths.forEach((g, i) => {
      out.push(`  ${String(i + 1).padStart(2)}. +${INT(g.tokens)} tokens  ${g.tool}  ${g.ts}`);
    });
  }
  return `${out.join('\n')}\n`;
}
