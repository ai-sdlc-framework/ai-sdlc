/**
 * Per-task, per-role and per-day cost views (AISDLC-1122).
 *
 * Work spend and polling spend are separate columns so a polling loop cannot
 * drown the cost of the work. A call is polling when every tool it invoked is
 * a wait or poll tool; a call that invoked any other tool, or none, is work.
 * Cost is API-equivalent USD over priced calls; unpriced calls are skipped.
 *
 * @module usage/split-views
 */

import {
  UNPRICED,
  priceCallBreakdown,
  type ModelCallRecord,
  type PriceRow,
} from '@ai-sdlc/reference';

export type SplitKey = 'task' | 'role' | 'day';

/** Tools whose only purpose is waiting for or checking on something. */
export const POLLING_TOOLS: ReadonlySet<string> = new Set([
  'ScheduleWakeup',
  'Monitor',
  'TaskOutput',
  'TaskList',
  'CronList',
]);

export interface SplitRow {
  key: string;
  calls: number;
  workCalls: number;
  pollingCalls: number;
  workUsd: number;
  pollingUsd: number;
}

export function isPollingCall(r: Pick<ModelCallRecord, 'toolNames'>): boolean {
  const names = r.toolNames;
  return !!names && names.length > 0 && names.every((n) => POLLING_TOOLS.has(n));
}

function keyOf(r: ModelCallRecord, key: SplitKey): string {
  if (key === 'task') return r.taskId ?? '(none)';
  if (key === 'role') return r.agentRole || '(none)';
  const ms = Date.parse(r.ts);
  return Number.isNaN(ms) ? 'unknown' : new Date(ms).toISOString().slice(0, 10);
}

/** Rows sorted by total spend, largest first (days sort ascending). */
export function buildSplitReport(
  records: readonly ModelCallRecord[],
  key: SplitKey,
  priceRows: ReadonlyArray<PriceRow>,
): SplitRow[] {
  const rows = new Map<string, SplitRow>();
  for (const r of records) {
    const k = keyOf(r, key);
    let row = rows.get(k);
    if (!row) {
      row = { key: k, calls: 0, workCalls: 0, pollingCalls: 0, workUsd: 0, pollingUsd: 0 };
      rows.set(k, row);
    }
    const cost = priceCallBreakdown(r, { rows: priceRows });
    const usd = cost === UNPRICED ? 0 : cost.total;
    row.calls++;
    if (isPollingCall(r)) {
      row.pollingCalls++;
      row.pollingUsd += usd;
    } else {
      row.workCalls++;
      row.workUsd += usd;
    }
  }
  const list = [...rows.values()];
  return key === 'day'
    ? list.sort((a, b) => a.key.localeCompare(b.key))
    : list.sort((a, b) => b.workUsd + b.pollingUsd - (a.workUsd + a.pollingUsd));
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

export function renderSplitText(key: SplitKey, rows: readonly SplitRow[]): string {
  if (rows.length === 0) return 'No usage recorded for this range.\n';
  const header = [key, 'calls', 'work_calls', 'work_usd', 'polling_calls', 'polling_usd'];
  const body = rows.map((r) => [
    r.key,
    String(r.calls),
    String(r.workCalls),
    usd(r.workUsd),
    String(r.pollingCalls),
    usd(r.pollingUsd),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return `${[fmt(header), ...body.map(fmt)].join('\n')}\n`;
}
