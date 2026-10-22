/**
 * PRs closed unmerged: a tracked waste KPI (AISDLC-831). Every PR that ends
 * closed instead of merged carried a filing, CI runs and operator attention
 * that produced nothing; the target is zero. One classifier feeds both the
 * quality corpus (`cli-quality-corpus aggregate`) and the dispatch tick.
 */
import { taskIdFrom } from '../hierarchy/reconcile.js';
import type { CommandRunner } from '../hierarchy/types.js';

export type ClosedUnmergedCause = 're-filed' | 'superseded' | 'withdrawn' | 'unknown';

export const CLOSED_UNMERGED_CAUSES: readonly ClosedUnmergedCause[] = [
  're-filed',
  'superseded',
  'withdrawn',
  'unknown',
];

/** A PR as listed by `gh pr list --state all`. */
export interface ListedClosedPr {
  number: number;
  title?: string;
  headRefName?: string;
  state?: string;
  createdAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  labels?: { name: string }[];
}

export interface ClosedUnmergedEntry {
  number: number;
  taskId: string;
  cause: ClosedUnmergedCause;
  closedAt: string;
}

export interface ClosedUnmergedReport {
  total: number;
  byCause: Record<ClosedUnmergedCause, number>;
  /** ISO week (`YYYY-Www`) -> count. */
  byWeek: Record<string, number>;
  prs: ClosedUnmergedEntry[];
  /** Window start (inclusive), ISO-8601. */
  since: string;
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function labelCause(pr: ListedClosedPr): ClosedUnmergedCause | undefined {
  const text = [...(pr.labels ?? []).map((l) => l.name), pr.title ?? ''].join(' ').toLowerCase();
  if (/supersed/.test(text)) return 'superseded';
  if (/withdr[ae]w/.test(text)) return 'withdrawn';
  return undefined;
}

/**
 * Classify the PRs closed without merge since `since`. `re-filed` means a later
 * open or merged PR names the same task id; labels or title then give
 * `superseded` / `withdrawn`; anything else is `unknown`.
 */
export function classifyClosedUnmerged(
  prs: readonly ListedClosedPr[],
  since: Date,
): ClosedUnmergedReport {
  const sinceMs = since.getTime();
  const entries: ClosedUnmergedEntry[] = [];
  const byWeek: Record<string, number> = {};
  const byCause: Record<ClosedUnmergedCause, number> = {
    're-filed': 0,
    superseded: 0,
    withdrawn: 0,
    unknown: 0,
  };
  for (const pr of prs) {
    const closedMs = pr.closedAt ? Date.parse(pr.closedAt) : Number.NaN;
    const closedUnmerged = pr.state === 'CLOSED' && !pr.mergedAt;
    if (!closedUnmerged || !Number.isFinite(closedMs) || closedMs < sinceMs) continue;
    const taskId = taskIdFrom(pr.headRefName, pr.title);
    const createdMs = pr.createdAt ? Date.parse(pr.createdAt) : closedMs;
    const refiled =
      taskId !== '' &&
      prs.some(
        (o) =>
          o.number !== pr.number &&
          (o.state === 'OPEN' || (o.state === 'MERGED' && o.mergedAt)) &&
          taskIdFrom(o.headRefName, o.title) === taskId &&
          Date.parse(o.createdAt ?? '') > createdMs,
      );
    const cause: ClosedUnmergedCause = refiled ? 're-filed' : (labelCause(pr) ?? 'unknown');
    byCause[cause] += 1;
    const week = isoWeek(new Date(closedMs));
    byWeek[week] = (byWeek[week] ?? 0) + 1;
    entries.push({
      number: pr.number,
      taskId,
      cause,
      closedAt: new Date(closedMs).toISOString(),
    });
  }
  return {
    total: entries.length,
    byCause,
    byWeek,
    prs: entries.sort((a, b) => a.number - b.number),
    since: since.toISOString(),
  };
}

/** One `gh pr list --state all` call; undefined when GitHub cannot be read. */
export function fetchClosedUnmergedPrs(
  run: CommandRunner,
  cwd: string,
): ListedClosedPr[] | undefined {
  const r = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '300',
      '--json',
      'number,title,headRefName,state,createdAt,closedAt,mergedAt,labels',
    ],
    { cwd },
  );
  if (r.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? (parsed as ListedClosedPr[]) : undefined;
  } catch {
    return undefined;
  }
}
