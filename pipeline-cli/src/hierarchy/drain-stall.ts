/**
 * Drain-stall detector (AISDLC-1101). A drain that stops moving is a silent no-op per tick: every break
 * (marker never matched, rotate flag never read, status line not classified) shows the same symptom, eligible
 * queued work, an idle executor and no claim. This records that symptom once, names the stage that did not
 * run, and closes the record when the board moves, without operator action.
 *
 * State is `<board-dir>/drain-stall.json`; opens and closes are appended to `<board-dir>/drain-stalls.jsonl`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { listBoard, peekQueue } from '../dispatch/board.js';
import { configPath } from './thresholds.js';
import { listInflight } from './inflight.js';
import type { Hold } from './hold.js';

/** Minutes of no progress, with eligible work and an idle executor, before a stall is recorded. */
export const DEFAULT_DRAIN_STALL_MINUTES = 30;

const STATE_FILE = 'drain-stall.json';
const LOG_FILE = 'drain-stalls.jsonl';

/** What last moved on the board; the stage after it is the one that did not run. */
export type ProgressKind = 'verdict' | 'ingest' | 'claim' | 'other';

/** The stage that did not run, named for the planner. */
export type StalledStage = 'clear-and-wake-after-verdict' | 'wake-after-ingest' | 'claim' | 'wake';

const STAGE_AFTER: Record<ProgressKind, StalledStage> = {
  verdict: 'clear-and-wake-after-verdict',
  ingest: 'wake-after-ingest',
  claim: 'claim',
  other: 'wake',
};

/** One open stall. */
export interface DrainStallRecord {
  stage: StalledStage;
  since: string;
  openedAt: string;
  eligible: number;
  idleExecutors: string[];
}

interface Counts {
  queued: number;
  inflight: number;
  done: number;
  failed: number;
}

interface State {
  /** Board signature at the last check. */
  sig?: string;
  counts?: Counts;
  lastKind?: ProgressKind;
  /** When the signature last changed or the stall condition last began. */
  since?: string;
  open?: DrainStallRecord;
}

export interface DrainStallDeps {
  boardDir: string;
  now: () => Date;
  held: Hold | null;
  /** Roster names of executors that are idle and hold no inflight task. */
  idleExecutors: () => string[];
  minutes?: number;
}

export interface DrainStallResult {
  /** Present on the tick that opened a stall; the caller tells the planner once. */
  opened?: DrainStallRecord;
  /** Present on the tick that closed one. */
  closed?: DrainStallRecord & { closedAt: string };
  open?: DrainStallRecord;
}

/** `stallAfterMinutes` from `<board-dir>/config.json` when a positive number, else the default. */
export function resolveStallAfterMinutes(boardDir: string): number {
  try {
    const file = configPath(boardDir);
    if (!existsSync(file)) return DEFAULT_DRAIN_STALL_MINUTES;
    const v = (JSON.parse(readFileSync(file, 'utf-8')) as { stallAfterMinutes?: unknown })
      .stallAfterMinutes;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_DRAIN_STALL_MINUTES;
  } catch {
    return DEFAULT_DRAIN_STALL_MINUTES;
  }
}

function statePath(boardDir: string): string {
  return path.join(boardDir, STATE_FILE);
}

function readState(boardDir: string): State {
  try {
    return JSON.parse(readFileSync(statePath(boardDir), 'utf-8')) as State;
  } catch {
    return {};
  }
}

/** The open stall, or undefined; read by `cli-hierarchy status`. Never throws. */
export function readOpenDrainStall(boardDir: string): DrainStallRecord | undefined {
  return readState(boardDir).open;
}

function writeState(boardDir: string, state: State): void {
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(statePath(boardDir), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function log(boardDir: string, event: Record<string, unknown>): void {
  appendFileSync(path.join(boardDir, LOG_FILE), JSON.stringify(event) + '\n', 'utf-8');
}

function kindOf(prev: Counts | undefined, next: Counts): ProgressKind {
  if (!prev) return 'other';
  if (next.done + next.failed > prev.done + prev.failed) return 'verdict';
  if (next.inflight > prev.inflight) return 'claim';
  if (next.queued > prev.queued) return 'ingest';
  return 'other';
}

/** Format the planner message for a newly opened stall. */
export function formatDrainStall(r: DrainStallRecord, minutes: number): string {
  return (
    `drain-stall: ${r.eligible} eligible task(s) queued, ${r.idleExecutors.length} idle executor(s) ` +
    `(${r.idleExecutors.join(', ')}), no progress since ${r.since} (over ${minutes} min). ` +
    `Stalled stage: ${r.stage}.`
  );
}

/** Check the board once. Call on every tick; it opens at most one record per stall and closes it on progress. */
export function checkDrainStall(deps: DrainStallDeps): DrainStallResult {
  const nowIso = deps.now().toISOString();
  const nowMs = deps.now().getTime();
  const state = readState(deps.boardDir);
  const counts = peekQueue(deps.boardDir);
  const inflightIds = listInflight(deps.boardDir).map((i) => i.taskId);
  const sig = `${counts.queued}|${counts.inflight}|${counts.done}|${counts.failed}|${inflightIds.join(',')}`;
  const moved = state.sig !== undefined && state.sig !== sig;
  const kind = moved ? kindOf(state.counts, counts) : (state.lastKind ?? 'other');
  const next: State = { sig, counts, lastKind: kind, since: state.since ?? nowIso };
  const result: DrainStallResult = {};

  const eligible = listBoard(deps.boardDir, deps.now).filter(
    (e) => e.state === 'queue' && e.eligible,
  ).length;
  const idle = eligible > 0 && !deps.held ? deps.idleExecutors() : [];
  const condition = eligible > 0 && idle.length > 0 && !deps.held;

  if (moved || !condition) next.since = nowIso;

  if (state.open && (moved || !condition)) {
    result.closed = { ...state.open, closedAt: nowIso };
    log(deps.boardDir, {
      event: 'closed',
      at: nowIso,
      reason: moved ? 'progress' : 'cleared',
      ...state.open,
    });
  } else if (state.open) {
    next.open = state.open;
    result.open = state.open;
  }

  const minutes = deps.minutes ?? resolveStallAfterMinutes(deps.boardDir);
  if (condition && !next.open && nowMs - Date.parse(next.since ?? nowIso) >= minutes * 60_000) {
    const record: DrainStallRecord = {
      stage: STAGE_AFTER[kind],
      since: next.since ?? nowIso,
      openedAt: nowIso,
      eligible,
      idleExecutors: idle,
    };
    next.open = record;
    result.opened = record;
    result.open = record;
    log(deps.boardDir, { event: 'opened', ...record });
  }
  writeState(deps.boardDir, next);
  return result;
}
