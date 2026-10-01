/**
 * Role and model scorecards (RFC-0050 B1).
 *
 * Joins the usage ledger (cost), the reviews ledger (quality) and the
 * assignment log (which model a task was given) by task and role. Pure
 * functions only; reading files lives in `scorecard-sources.ts`.
 *
 * Only counts, ids and attribution flow through here.
 *
 * @module usage/scorecard
 */

import type { ModelCallRecord } from '@ai-sdlc/reference';
import type { ReviewLedgerRecord } from '../attestation/reviews-ledger.js';
import type { TaskClass } from '../estimation/types.js';
import { unitsForCall, type UnitWeights } from './units.js';
import { DEFAULT_SCORECARD_MIN_TASKS } from './usage-config.js';

export const CONDUCTOR_ROLE = 'main-session';
export const DEVELOPER_ROLE = 'developer';

export type ModelSource = 'assignment-log' | 'usage-majority';

/** Quality signals for one task, derived from the reviews ledger. */
export interface TaskOutcome {
  taskId: string;
  firstPassApproved: boolean;
  /** Highest iteration recorded. */
  iterations: number;
  /** Critical and major findings recorded at iteration 1. */
  blockingFindings: number;
  /** Developer contract retries seen in orchestrator events. */
  contractRetries: number;
}

export interface TaskInfo {
  taskClass: TaskClass;
  /** T-shirt size, when an estimate was recorded. */
  size?: string;
}

/**
 * One assignment-log entry. The log is written by the model resolver; this
 * is the shape the reader expects: one JSON object per line with
 * `taskId`, `role`, `model` and either `arm` or `reason` equal to `explore`
 * for an explored assignment. Extra fields are ignored.
 */
export interface AssignmentEntry {
  model: string;
  explore: boolean;
}

/** Key for the assignment map: task id and normalized role. */
export function assignmentKey(taskId: string, role: string): string {
  return `${taskId}\u0000${normalizeRole(role)}`;
}

/** `ai-sdlc:developer` and `developer` are the same role. */
export function normalizeRole(role: string): string {
  const r = role.trim().toLowerCase();
  return r.startsWith('ai-sdlc:') ? r.slice('ai-sdlc:'.length) : r;
}

/** Derive per-task outcomes from review ledger records (all tasks mixed together). */
export function deriveOutcomes(
  records: readonly ReviewLedgerRecord[],
  contractRetries: ReadonlyMap<string, number> = new Map(),
): Map<string, TaskOutcome> {
  const byTask = new Map<string, ReviewLedgerRecord[]>();
  for (const r of records) {
    if (!r || typeof r.taskId !== 'string' || typeof r.iteration !== 'number') continue;
    const list = byTask.get(r.taskId);
    if (list) list.push(r);
    else byTask.set(r.taskId, [r]);
  }
  const out = new Map<string, TaskOutcome>();
  for (const [taskId, list] of byTask) {
    const first = list.filter((r) => r.iteration === 1);
    const blocking = first.reduce(
      (n, r) =>
        n +
        (r.findings ?? []).filter((f) => f.severity === 'critical' || f.severity === 'major')
          .length,
      0,
    );
    out.set(taskId, {
      taskId,
      firstPassApproved:
        first.length > 0 && first.every((r) => r.verdict === 'approved') && blocking === 0,
      iterations: Math.max(...list.map((r) => r.iteration)),
      blockingFindings: blocking,
      contractRetries: contractRetries.get(taskId) ?? 0,
    });
  }
  return out;
}

export interface CellTask {
  taskId: string;
  source: ModelSource;
  explore: boolean;
  size?: string;
  units: number;
}

export interface ScorecardRow {
  role: string;
  model: string;
  taskClass: TaskClass;
  tasks: number;
  /** Tasks whose arm was an exploration. */
  explored: number;
  /** Tasks first-pass approved; null for roles with no approval signal. */
  approved: number | null;
  firstPassApprovalRate: number | null;
  meanIterations: number | null;
  meanBlockingFindings: number | null;
  meanContractRetries: number | null;
  meanUnitsPerTask: number;
  /** Task counts per T-shirt size (`unknown` when no estimate). */
  sizes: Record<string, number>;
  /** Where the model came from: one source, or `mixed`. */
  source: ModelSource | 'mixed';
  insufficient: boolean;
  dateRange: { from: string; to: string };
  taskIds: string[];
  /** Per-task detail, for evidence files. */
  taskDetails: CellTask[];
}

export interface Scorecard {
  rows: ScorecardRow[];
  /** Tasks with usage but no reviews-ledger rows. */
  noOutcome: number;
  noOutcomeTaskIds: string[];
  minTasks: number;
  unitsNote?: string;
}

export interface BuildScorecardInput {
  /** Framework-scope calls of the repository being reported, with a task id. */
  records: readonly ModelCallRecord[];
  outcomes: ReadonlyMap<string, TaskOutcome>;
  taskInfo: ReadonlyMap<string, TaskInfo>;
  assignments: ReadonlyMap<string, AssignmentEntry>;
  weights: UnitWeights;
  minTasks?: number;
  /**
   * Only this role (normalized). The `noOutcome` total is computed after this
   * filter, so it counts tasks with usage for that role only.
   */
  role?: string;
}

interface TaskRoleAcc {
  taskId: string;
  role: string;
  calls: Map<string, number>;
  units: number;
  first: string;
  last: string;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function majorityModel(calls: ReadonlyMap<string, number>): string {
  let best = '';
  let bestN = -1;
  for (const [model, n] of calls) {
    if (n > bestN || (n === bestN && model < best)) {
      best = model;
      bestN = n;
    }
  }
  return best;
}

/** True when the role's tasks are judged by review outcome. */
function usesOutcome(role: string): boolean {
  return role === DEVELOPER_ROLE;
}

export function buildScorecard(input: BuildScorecardInput): Scorecard {
  const minTasks = input.minTasks ?? DEFAULT_SCORECARD_MIN_TASKS;
  const wanted = input.role ? normalizeRole(input.role) : undefined;
  const acc = new Map<string, TaskRoleAcc>();
  const usageTasks = new Set<string>();
  for (const r of input.records) {
    if (
      !r.taskId ||
      typeof r.agentRole !== 'string' ||
      typeof r.model !== 'string' ||
      typeof r.ts !== 'string'
    ) {
      continue;
    }
    const role = normalizeRole(r.agentRole);
    if (wanted && role !== wanted) continue;
    usageTasks.add(r.taskId);
    const key = `${r.taskId}\u0000${role}`;
    let a = acc.get(key);
    if (!a) {
      a = { taskId: r.taskId, role, calls: new Map(), units: 0, first: r.ts, last: r.ts };
      acc.set(key, a);
    }
    a.calls.set(r.model, (a.calls.get(r.model) ?? 0) + 1);
    const u = unitsForCall(r, input.weights);
    a.units += Number.isFinite(u) ? u : 0;
    if (r.ts < a.first) a.first = r.ts;
    if (r.ts > a.last) a.last = r.ts;
  }

  const noOutcomeTaskIds = [...usageTasks].filter((t) => !input.outcomes.has(t)).sort();

  interface Cell {
    role: string;
    model: string;
    taskClass: TaskClass;
    tasks: CellTask[];
    outcomes: TaskOutcome[];
    from: string;
    to: string;
  }
  const cells = new Map<string, Cell>();
  for (const a of acc.values()) {
    const outcome = input.outcomes.get(a.taskId);
    // Developer rows and conductor rows are only meaningful with an outcome.
    if ((usesOutcome(a.role) || a.role === CONDUCTOR_ROLE) && !outcome) continue;
    const assigned = input.assignments.get(assignmentKey(a.taskId, a.role));
    const model = assigned?.model ?? majorityModel(a.calls);
    const info = input.taskInfo.get(a.taskId);
    const taskClass: TaskClass = info?.taskClass ?? 'uncategorized';
    const key = `${a.role}\u0000${model}\u0000${taskClass}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { role: a.role, model, taskClass, tasks: [], outcomes: [], from: a.first, to: a.last };
      cells.set(key, cell);
    }
    cell.tasks.push({
      taskId: a.taskId,
      source: assigned ? 'assignment-log' : 'usage-majority',
      explore: assigned?.explore ?? false,
      ...(info?.size ? { size: info.size } : {}),
      units: a.units,
    });
    if (outcome) cell.outcomes.push(outcome);
    if (a.first < cell.from) cell.from = a.first;
    if (a.last > cell.to) cell.to = a.last;
  }

  const rows: ScorecardRow[] = [...cells.values()].map((c) => {
    c.tasks.sort((x, y) => x.taskId.localeCompare(y.taskId));
    const scored = usesOutcome(c.role);
    const approved = c.outcomes.filter((o) => o.firstPassApproved).length;
    const sources = new Set(c.tasks.map((t) => t.source));
    // A Map, then fromEntries: sizes come from recorded estimates and must not
    // reach the object prototype (`__proto__`, `constructor`, ...).
    const sizeCounts = new Map<string, number>();
    for (const t of c.tasks) {
      const k = t.size ?? 'unknown';
      sizeCounts.set(k, (sizeCounts.get(k) ?? 0) + 1);
    }
    const sizes = Object.fromEntries(sizeCounts);
    return {
      role: c.role,
      model: c.model,
      taskClass: c.taskClass,
      tasks: c.tasks.length,
      explored: c.tasks.filter((t) => t.explore).length,
      approved: scored ? approved : null,
      firstPassApprovalRate: scored ? approved / c.tasks.length : null,
      meanIterations: scored ? mean(c.outcomes.map((o) => o.iterations)) : null,
      meanBlockingFindings: scored ? mean(c.outcomes.map((o) => o.blockingFindings)) : null,
      meanContractRetries: scored ? mean(c.outcomes.map((o) => o.contractRetries)) : null,
      meanUnitsPerTask: mean(c.tasks.map((t) => t.units)),
      sizes,
      source: sources.size > 1 ? 'mixed' : [...sources][0],
      insufficient: c.tasks.length < minTasks,
      dateRange: { from: c.from, to: c.to },
      taskIds: c.tasks.map((t) => t.taskId),
      taskDetails: c.tasks,
    };
  });
  rows.sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      a.model.localeCompare(b.model) ||
      a.taskClass.localeCompare(b.taskClass),
  );
  return { rows, noOutcome: noOutcomeTaskIds.length, noOutcomeTaskIds, minTasks };
}

function pct(n: number | null, d: number): string {
  return n === null ? '-' : `${(n * 100).toFixed(0)}% (${Math.round(n * d)}/${d})`;
}

function num(n: number | null, digits = 1): string {
  return n === null ? '-' : n.toFixed(digits);
}

const HEADER = [
  'role',
  'model',
  'class',
  'tasks',
  'first_pass',
  'mean_iter',
  'mean_blocking',
  'mean_units',
  'explored',
  'model_source',
  'note',
];

function cells(r: ScorecardRow): string[] {
  return [
    r.role,
    r.model,
    r.taskClass,
    String(r.tasks),
    pct(r.firstPassApprovalRate, r.tasks),
    num(r.meanIterations),
    num(r.meanBlockingFindings),
    Math.round(r.meanUnitsPerTask).toLocaleString('en-US'),
    String(r.explored),
    r.source,
    r.insufficient ? 'insufficient' : '',
  ];
}

export function renderScorecardText(card: Scorecard): string {
  if (card.rows.length === 0) {
    return `No scored tasks yet. Tasks without review outcomes: ${card.noOutcome}.\n`;
  }
  const body = card.rows.map(cells);
  const widths = HEADER.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const lines = [fmt(HEADER), ...body.map(fmt)];
  lines.push(
    `Cells with fewer than ${card.minTasks} tasks are insufficient and are not used for a table change.`,
    `Tasks with usage but no review outcome (excluded from approval rates): ${card.noOutcome}.`,
  );
  if (card.unitsNote) lines.push(card.unitsNote);
  return `${lines.join('\n')}\n`;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function renderScorecardCsv(card: Scorecard): string {
  return `${[HEADER, ...card.rows.map(cells)].map((r) => r.map(csvEscape).join(',')).join('\n')}\n`;
}

/** JSON view: rows without the per-task detail (that goes to evidence files). */
export function renderScorecardJson(card: Scorecard): string {
  const rows = card.rows.map(({ taskDetails: _d, ...rest }) => rest);
  return `${JSON.stringify(
    {
      rows,
      noOutcome: card.noOutcome,
      noOutcomeTaskIds: card.noOutcomeTaskIds,
      minTasks: card.minTasks,
      ...(card.unitsNote ? { unitsNote: card.unitsNote } : {}),
    },
    null,
    2,
  )}\n`;
}
