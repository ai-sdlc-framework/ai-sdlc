/**
 * Implicit outcome label extractor (RFC-0062 OQ-3, DEC-0387).
 *
 * One row per landed, abandoned or parked task with four weak signals:
 * outcome, operator priority edit direction, queue age at claim relative to
 * the bucket median, and hold/park decision records naming the task. Pure
 * recording: nothing here scores, weights or fits.
 *
 * @module labels/extract
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseTaskFrontmatter } from './task-file.js';

export const COMBINATION_RULE =
  'Recording only. outcome: landed (completed task, status Done/Approved), abandoned ' +
  '(Withdrawn/Superseded/Cancelled), parked (open task that is blocked or parked). ' +
  'priorityEdit: direction of the net change between the first and last priority in the task file git history ' +
  '(up, down, none). queueAge: days from created_date to the first commit that set status In Progress, ' +
  'with the median of the same priority bucket and the ratio. holdDecisions: decision ids whose summary or ' +
  'body names the task and mentions hold or park. A downstream rule that combines these into a label is not part of this task.';

export type Outcome = 'landed' | 'abandoned' | 'parked';
export type PriorityDirection = 'up' | 'down' | 'none';

export interface LabelRow {
  kind: 'row';
  taskId: string;
  outcome: Outcome;
  priorityEdit: { direction: PriorityDirection; from: string | null; to: string | null };
  queueAge: {
    days: number | null;
    bucket: string | null;
    bucketMedianDays: number | null;
    ratio: number | null;
  };
  holdDecisions: string[];
}

const RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4, highest: 4 };

export interface GitHistory {
  priorities: string[];
  claimedAt: string | null;
}

/** Walk a task file's git history, oldest first. Never throws. */
export function readGitHistory(repoRoot: string, file: string): GitHistory {
  let out: string;
  try {
    out = execFileSync(
      'git',
      [
        'log',
        '--follow',
        '--reverse',
        '-p',
        '-U0',
        '--format=@@TS@@%aI',
        '--',
        relative(repoRoot, file),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return { priorities: [], claimedAt: null };
  }
  const priorities: string[] = [];
  let claimedAt: string | null = null;
  let ts = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('@@TS@@')) {
      ts = line.slice(6).trim();
      continue;
    }
    const p = /^[+]priority:\s*['"]?([A-Za-z]+)/.exec(line);
    if (p) priorities.push(p[1].toLowerCase());
    if (!claimedAt && /^[+]status:\s*['"]?In Progress/.test(line)) claimedAt = ts;
  }
  return { priorities, claimedAt };
}

export function priorityDirection(priorities: readonly string[]): {
  direction: PriorityDirection;
  from: string | null;
  to: string | null;
} {
  if (priorities.length === 0) return { direction: 'none', from: null, to: null };
  const from = priorities[0];
  const to = priorities[priorities.length - 1];
  const d = (RANK[to] ?? 0) - (RANK[from] ?? 0);
  return { direction: d > 0 ? 'up' : d < 0 ? 'down' : 'none', from, to };
}

function median(v: number[]): number | null {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hold and park decision ids by task id, from the decision event log. */
export function readHoldDecisions(repoRoot: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = join(repoRoot, '.ai-sdlc', '_decisions', 'events');
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'decision-opened' || typeof e.decisionId !== 'string') continue;
    const text = `${String(e.summary ?? '')}\n${String(e.body ?? '')}`;
    if (!/\b(hold|park|parked|parking)\b/i.test(text)) continue;
    for (const id of new Set(text.match(/\b[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/g) ?? [])) {
      if (id.startsWith('DEC-') || id.startsWith('RFC-')) continue;
      const list = out.get(id) ?? [];
      if (!list.includes(e.decisionId)) list.push(e.decisionId);
      out.set(id, list);
    }
  }
  return out;
}

function outcomeOf(
  dir: 'tasks' | 'completed',
  status: string | undefined,
  blocked: boolean,
): Outcome | undefined {
  const s = (status ?? '').toLowerCase();
  if (/withdrawn|superseded|cancel|abandon/.test(s)) return 'abandoned';
  if (dir === 'completed') return 'landed';
  if (blocked || /park/.test(s)) return 'parked';
  return undefined;
}

export function extractLabels(
  repoRoot: string,
  deps: { history?: (file: string) => GitHistory } = {},
): LabelRow[] {
  const history = deps.history ?? ((f: string) => readGitHistory(repoRoot, f));
  const holds = readHoldDecisions(repoRoot);
  const rows: LabelRow[] = [];
  const ages: { row: LabelRow; priority: string }[] = [];
  for (const sub of ['completed', 'tasks'] as const) {
    const dir = join(repoRoot, 'backlog', sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const file = join(dir, name);
      const fm = parseTaskFrontmatter(readFileSync(file, 'utf8'));
      if (!fm?.id) continue;
      const outcome = outcomeOf(sub, fm.status, fm.blocked);
      if (!outcome) continue;
      const h = history(file);
      const created = fm.createdDate ? Date.parse(fm.createdDate) : NaN;
      const claimed = h.claimedAt ? Date.parse(h.claimedAt) : NaN;
      const days =
        Number.isFinite(created) && Number.isFinite(claimed)
          ? Math.max(0, (claimed - created) / 86_400_000)
          : null;
      const row: LabelRow = {
        kind: 'row',
        taskId: fm.id,
        outcome,
        priorityEdit: priorityDirection(h.priorities),
        queueAge: { days, bucket: fm.priority ?? null, bucketMedianDays: null, ratio: null },
        holdDecisions: holds.get(fm.id) ?? [],
      };
      rows.push(row);
      if (days !== null) ages.push({ row, priority: fm.priority ?? '' });
    }
  }
  const byBucket = new Map<string, number[]>();
  for (const a of ages)
    byBucket.set(a.priority, [...(byBucket.get(a.priority) ?? []), a.row.queueAge.days as number]);
  for (const a of ages) {
    const m = median(byBucket.get(a.priority) ?? []);
    a.row.queueAge.bucketMedianDays = m;
    a.row.queueAge.ratio = m && m > 0 ? (a.row.queueAge.days as number) / m : null;
  }
  return rows;
}

export function renderLabelsJsonl(rows: readonly LabelRow[]): string {
  const header = { kind: 'header', rule: COMBINATION_RULE, rows: rows.length };
  return [header, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n';
}
