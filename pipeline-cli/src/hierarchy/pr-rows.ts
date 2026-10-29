/**
 * Per-PR decision rows (AISDLC-1095): lane, action, reason, owner, age.
 *
 * The reconcile scheduler appends one row per open PR per run to
 * `<board>/log/reconcile.log` and copies the same fields onto each row of
 * `pr-snapshot.json`; `cli-hierarchy status` prints the table from the landing records.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listLanding, recordLastActionAt, type LandingRecord } from './reconcile.js';

/** One open PR's decision, as logged, snapshotted and printed. */
export interface PrRow {
  pr: number;
  lane: string;
  action: string;
  reason: string;
  owner: string;
  lastActionAt?: string;
}

export const reconcileLogPath = (boardDir: string): string =>
  path.join(boardDir, 'log', 'reconcile.log');

/** Why the record sits in its state: the failing line, ruling or note, else the state. */
export function rowReason(r: LandingRecord): string {
  return (r.failingLine ?? r.ruling ?? r.note ?? r.state).replace(/\s+/g, ' ').trim();
}

export function rowFromRecord(r: LandingRecord): PrRow {
  const at = recordLastActionAt(r);
  return {
    pr: r.pr,
    lane: r.kind,
    action: r.action,
    reason: rowReason(r),
    owner: r.owner,
    ...(at === undefined ? {} : { lastActionAt: at }),
  };
}

/** One row per PR number in `open`; a PR with no record (the release PR) is reported only. */
export function rowsForOpen(boardDir: string, open: readonly number[]): PrRow[] {
  const byPr = new Map(listLanding(boardDir).map((r) => [r.pr, r]));
  return open.map((pr) => {
    const rec = byPr.get(pr);
    return rec
      ? rowFromRecord(rec)
      : { pr, lane: 'release', action: 'report', reason: 'not acted on', owner: 'operator' };
  });
}

export function formatRow(row: PrRow): string {
  return `#${row.pr} lane=${row.lane} action=${row.action} owner=${row.owner} reason=${row.reason}${
    row.lastActionAt ? ` lastActionAt=${row.lastActionAt}` : ''
  }`;
}

/** Append one row per PR to the reconcile log. */
export function appendReconcileLog(boardDir: string, rows: readonly PrRow[], now: Date): void {
  if (rows.length === 0) return;
  const file = reconcileLogPath(boardDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const ts = now.toISOString();
  appendFileSync(file, rows.map((r) => `${ts} ${formatRow(r)}\n`).join(''), 'utf-8');
}

/** Copy lane, action, reason, owner and lastActionAt onto the stored snapshot's PR rows. */
export function annotateSnapshot(boardDir: string, rows: readonly PrRow[]): void {
  const file = path.join(boardDir, 'pr-snapshot.json');
  let snap: { prs?: Record<string, unknown>[] };
  try {
    snap = JSON.parse(readFileSync(file, 'utf-8')) as typeof snap;
  } catch {
    return;
  }
  if (!Array.isArray(snap.prs)) return;
  const byPr = new Map(rows.map((r) => [r.pr, r]));
  for (const p of snap.prs) {
    const row = byPr.get(Number(p['number']));
    if (!row) continue;
    p['lane'] = row.lane;
    p['action'] = row.action;
    p['reason'] = row.reason;
    p['owner'] = row.owner;
    if (row.lastActionAt !== undefined) p['lastActionAt'] = row.lastActionAt;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap) + '\n', 'utf-8');
  renameSync(tmp, file);
}

/** Age such as `5m`, `2h10m` or `3d`. */
function age(at: string | undefined, nowMs: number): string {
  const ms = nowMs - Date.parse(at ?? '');
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  return min < 1440 ? `${Math.floor(min / 60)}h${min % 60}m` : `${Math.floor(min / 1440)}d`;
}

/** The status table over the open landing records. Empty when there are none. */
export function formatPrTable(boardDir: string, nowMs: number): string[] {
  const open = listLanding(boardDir).filter((r) => !r.landed && !r.closedUnlanded);
  if (open.length === 0) return [];
  return [
    'open PRs:',
    ...open.map((r) => {
      const row = rowFromRecord(r);
      return `  #${row.pr} lane ${row.lane}, action ${row.action}, reason ${row.reason}, owner ${row.owner}, age ${age(row.lastActionAt, nowMs)}`;
    }),
  ];
}
