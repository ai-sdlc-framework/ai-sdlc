/**
 * PR throughput KPI (AISDLC-877): opened vs landed per UTC day, split by PR
 * class (task / record / dependency / other), plus open-to-land latency for
 * task PRs. Pure functions; no I/O, no model calls.
 */

export type PrClass = 'task' | 'record' | 'dependency' | 'other';

export interface PrRecord {
  headRefName: string;
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
}

export interface ClassCounts {
  opened: number;
  landed: number;
  closedUnmerged: number;
}

export interface Latency {
  count: number;
  medianHours: number;
  p90Hours: number;
  maxHours: number;
}

export interface DayRow {
  day: string;
  all: ClassCounts;
  task: ClassCounts;
  record: ClassCounts;
  dependency: ClassCounts;
  other: ClassCounts;
  /** landed / opened, null when opened is 0. */
  ratioAll: number | null;
  ratioTask: number | null;
  /** Task PR open-to-land latency, for task PRs landed that day. */
  latencyTask: Latency | null;
}

export interface ThroughputReport {
  from: string;
  to: string;
  days: DayRow[];
  total: Omit<DayRow, 'day'>;
}

const RECORD_PATTERNS: RegExp[] = [
  /^ai-sdlc\/file-/,
  /^ai-sdlc\/decisions-sync/,
  /^chore\/sync-tasks/,
  /^release-please--/,
  /^rfc-/,
  /^audit-/,
];

export function classifyPr(headRefName: string): PrClass {
  if (/^ai-sdlc\/aisdlc-\d/i.test(headRefName)) return 'task';
  if (RECORD_PATTERNS.some((p) => p.test(headRefName))) return 'record';
  if (/^dependabot\//.test(headRefName)) return 'dependency';
  return 'other';
}

function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

const zero = (): ClassCounts => ({ opened: 0, landed: 0, closedUnmerged: 0 });

/** Nearest-rank percentile on a sorted ascending array (p in 0..1). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function latencyOf(hours: number[]): Latency | null {
  if (hours.length === 0) return null;
  const s = [...hours].sort((a, b) => a - b);
  return {
    count: s.length,
    medianHours: median(s),
    p90Hours: percentile(s, 0.9),
    maxHours: s[s.length - 1],
  };
}

const ratio = (c: ClassCounts): number | null => (c.opened === 0 ? null : c.landed / c.opened);

export function computeThroughput(
  prs: PrRecord[],
  fromDay: string,
  toDay: string,
): ThroughputReport {
  const days = new Map<string, DayRow>();
  const taskLatencies = new Map<string, number[]>();
  const allTaskLatencies: number[] = [];
  const mk = (day: string): DayRow => ({
    day,
    all: zero(),
    task: zero(),
    record: zero(),
    dependency: zero(),
    other: zero(),
    ratioAll: null,
    ratioTask: null,
    latencyTask: null,
  });
  for (let t = Date.parse(fromDay); t <= Date.parse(toDay); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.set(d, mk(d));
    taskLatencies.set(d, []);
  }
  const total = mk('total');

  const bump = (day: string, cls: PrClass, kind: keyof ClassCounts): void => {
    const row = days.get(day);
    if (!row) return;
    row.all[kind] += 1;
    row[cls][kind] += 1;
    total.all[kind] += 1;
    total[cls][kind] += 1;
  };

  for (const pr of prs) {
    const cls = classifyPr(pr.headRefName);
    bump(utcDay(pr.createdAt), cls, 'opened');
    if (pr.mergedAt) {
      const day = utcDay(pr.mergedAt);
      bump(day, cls, 'landed');
      if (cls === 'task' && days.has(day)) {
        const hours = (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 3_600_000;
        taskLatencies.get(day)!.push(hours);
        allTaskLatencies.push(hours);
      }
    } else if (pr.closedAt) {
      bump(utcDay(pr.closedAt), cls, 'closedUnmerged');
    }
  }

  const rows = [...days.values()];
  for (const row of rows) {
    row.ratioAll = ratio(row.all);
    row.ratioTask = ratio(row.task);
    row.latencyTask = latencyOf(taskLatencies.get(row.day)!);
  }
  total.ratioAll = ratio(total.all);
  total.ratioTask = ratio(total.task);
  total.latencyTask = latencyOf(allTaskLatencies);
  const { day: _day, ...totalRest } = total;
  return { from: fromDay, to: toDay, days: rows, total: totalRest };
}

const fmtRatio = (r: number | null): string => (r === null ? '-' : r.toFixed(2));
const fmtHours = (h: number): string => `${Math.round(h * 10) / 10}h`;

export function renderMarkdownTable(report: ThroughputReport): string {
  const head =
    '| Day (UTC) | Task opened/landed | Record opened/landed | Closed unmerged | Ratio (all) | Ratio (task) | Task latency median/p90/max |';
  const sep = '|---|---|---|---|---|---|---|';
  const line = (label: string, r: Omit<DayRow, 'day'>): string => {
    const l = r.latencyTask;
    const lat = l
      ? `${fmtHours(l.medianHours)} / ${fmtHours(l.p90Hours)} / ${fmtHours(l.maxHours)}`
      : '-';
    return `| ${label} | ${r.task.opened}/${r.task.landed} | ${r.record.opened}/${r.record.landed} | ${r.all.closedUnmerged} | ${fmtRatio(r.ratioAll)} | ${fmtRatio(r.ratioTask)} | ${lat} |`;
  };
  return [
    head,
    sep,
    ...report.days.map((d) => line(d.day, d)),
    line(`**${report.from}..${report.to}**`, report.total),
  ].join('\n');
}

/** One line for the operator digest. */
export function summaryLine(report: ThroughputReport): string {
  const t = report.total;
  const l = t.latencyTask;
  const lat = l
    ? `, task latency median ${fmtHours(l.medianHours)} p90 ${fmtHours(l.p90Hours)}`
    : '';
  return `PR throughput ${report.from}..${report.to}: task ${t.task.opened} opened / ${t.task.landed} landed (ratio ${fmtRatio(t.ratioTask)}), record ${t.record.opened}/${t.record.landed}${lat}`;
}

export const SECTION_BEGIN = '<!-- pr-throughput:begin -->';
export const SECTION_END = '<!-- pr-throughput:end -->';

/** Replace the marked block in `page`, appending a section when absent. */
export function refreshPage(page: string, report: ThroughputReport): string {
  const block = `${SECTION_BEGIN}\n${renderMarkdownTable(report)}\n\n${summaryLine(report)}\n${SECTION_END}`;
  const b = page.indexOf(SECTION_BEGIN);
  const e = page.indexOf(SECTION_END);
  if (b >= 0 && e > b) return page.slice(0, b) + block + page.slice(e + SECTION_END.length);
  return `${page.replace(/\s*$/, '')}\n\n## PR throughput\n\n${block}\n`;
}
