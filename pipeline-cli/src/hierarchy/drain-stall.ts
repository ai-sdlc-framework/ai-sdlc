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

import { collectVerdicts, listBoard, peekQueue } from '../dispatch/board.js';
import { listLanding } from './reconcile.js';
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
  /** Spawn errors of this tick (AISDLC-1117); with no live executor they count as a stall. */
  spawnErrors?: number;
  /** Live dynamic executors in the roster. */
  liveExecutors?: number;
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
    `(${r.idleExecutors.join(', ') || 'none; spawn errors with no live executor'}), no progress since ${r.since} (over ${minutes} min). ` +
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
  const spawnStalled = (deps.spawnErrors ?? 0) > 0 && (deps.liveExecutors ?? 0) === 0;
  const condition = eligible > 0 && (idle.length > 0 || spawnStalled) && !deps.held;

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

// ---------------------------------------------------------------------------
// Stuck-PR signature (AISDLC-1156)
// ---------------------------------------------------------------------------

/**
 * Invariant (DEC-0291, RFC-0051 section 8 amendment): every failed verdict ends in exactly one of
 * (i) repaired and re-queued or delivered, (ii) a Decision Catalog entry with a timebox and an
 * autonomous fallback, (iii) an operator notification with a deadline. A failed verdict that carries a
 * signature or a review record, in none of those states past `stuckAfterMinutes`, is itself a stall.
 * Incidents: #2246 (AISDLC-1136) and #2282 (AISDLC-1153) sat as unowned drafts for hours.
 */
export const DEFAULT_STUCK_AFTER_MINUTES = 60;
/** Hours the stuck-PR Decision waits before its autonomous fallback applies. */
export const DEFAULT_STUCK_TIMEBOX_HOURS = 4;

const STUCK_STATE_FILE = 'stuck-prs.json';

function numberConfig(boardDir: string, key: string, fallback: number): number {
  try {
    const file = configPath(boardDir);
    if (!existsSync(file)) return fallback;
    const v = (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** `stuckAfterMinutes` from `<board-dir>/config.json` when a positive number, else 60. */
export function resolveStuckAfterMinutes(boardDir: string): number {
  return numberConfig(boardDir, 'stuckAfterMinutes', DEFAULT_STUCK_AFTER_MINUTES);
}

/** `stuckDecisionTimeboxHours` from `<board-dir>/config.json` when a positive number, else 4. */
export function resolveStuckTimeboxHours(boardDir: string): number {
  return numberConfig(boardDir, 'stuckDecisionTimeboxHours', DEFAULT_STUCK_TIMEBOX_HOURS);
}

/** The terminal states a failed verdict can end in; `missing` on a stuck PR names those it has not reached. */
export type StuckMissing = 'repair-or-delivery' | 'decision' | 'notification';

/** One failed verdict that is not in a terminal state. */
export interface StuckPrCandidate {
  pr: number;
  taskId: string;
  headSha?: string;
  cause: string;
  /** When the failed verdict was written. */
  since: string;
}

/** One open `stuck-pr` stall. */
export interface StuckPrRecord extends StuckPrCandidate {
  kind: 'stuck-pr';
  openedAt: string;
  decisionId?: string;
  notifiedAt?: string;
}

/** A stuck entry as `status` prints it. */
export interface StuckPrRow extends StuckPrCandidate {
  ageMinutes: number;
  missing: StuckMissing[];
}

const NOT_FAILED = new Set(['success', 'iterate-needed']);

/**
 * Failed verdicts with a signature or a review record and a PR, that are not delivered, landed,
 * re-queued or parked on the board. Pure reads.
 */
export function findStuckCandidates(boardDir: string, now: () => Date): StuckPrCandidate[] {
  const verdicts = collectVerdicts(boardDir);
  const landing = listLanding(boardDir);
  // Queued, inflight or parked work is a re-queue or a Decision: a terminal state of the invariant.
  const onBoard = new Set(
    listBoard(boardDir, now)
      .filter((e) => e.state === 'queue' || e.state === 'inflight' || e.state === 'blocked')
      .map((e) => e.taskId.toLowerCase()),
  );
  const latest = new Map<string, (typeof verdicts)[number]>();
  for (const v of verdicts) latest.set(v.taskId.toLowerCase(), v);
  const out: StuckPrCandidate[] = [];
  for (const [id, v] of latest) {
    if (NOT_FAILED.has(v.outcome) || typeof v.prNumber !== 'number') continue;
    if (!v.signedAt && !v.reviewerCompletedAt) continue;
    if (onBoard.has(id)) continue;
    const rec = landing.find((r) => r.pr === v.prNumber);
    if (rec && (rec.delivered !== undefined || rec.landed !== undefined || rec.closedUnlanded)) {
      continue;
    }
    const headSha = rec?.headSha ?? v.commitSha ?? undefined;
    out.push({
      pr: v.prNumber,
      taskId: v.taskId,
      ...(headSha ? { headSha } : {}),
      cause: v.cause ?? String(v.outcome),
      since: v.completedAt,
    });
  }
  return out;
}

interface StuckState {
  open: Record<string, StuckPrRecord>;
}

function stuckKey(c: StuckPrCandidate): string {
  return `${c.pr}|${c.headSha ?? ''}`;
}

function readStuckState(boardDir: string): StuckState {
  try {
    const s = JSON.parse(
      readFileSync(path.join(boardDir, STUCK_STATE_FILE), 'utf-8'),
    ) as StuckState;
    return { open: s.open ?? {} };
  } catch {
    return { open: {} };
  }
}

/** Open `stuck-pr` stalls; read by `cli-hierarchy status`. Never throws. */
export function readOpenStuckPrs(boardDir: string): StuckPrRecord[] {
  return Object.values(readStuckState(boardDir).open);
}

/** Every stuck candidate with its age and the terminal states it has not reached; `status` prints these. */
export function listStuckPrs(boardDir: string, now: () => Date): StuckPrRow[] {
  const open = readStuckState(boardDir).open;
  const nowMs = now().getTime();
  return findStuckCandidates(boardDir, now).map((c) => {
    const rec = open[stuckKey(c)];
    const missing: StuckMissing[] = ['repair-or-delivery'];
    if (rec?.decisionId === undefined) missing.push('decision');
    if (rec?.notifiedAt === undefined) missing.push('notification');
    const since = Date.parse(c.since);
    return {
      ...c,
      ageMinutes: Number.isFinite(since) ? Math.max(0, Math.floor((nowMs - since) / 60_000)) : 0,
      missing,
    };
  });
}

export interface StuckPrDeps {
  boardDir: string;
  now: () => Date;
  minutes?: number;
  /** Files the timeboxed Decision; returns its id. Called once per open stall. */
  fileDecision?: (r: StuckPrRecord) => string;
  /** Raises the operator notification. Called once per open stall. */
  notify?: (r: StuckPrRecord) => void;
}

export interface StuckPrResult {
  opened: StuckPrRecord[];
  closed: (StuckPrRecord & { closedAt: string })[];
  open: StuckPrRecord[];
}

/** Planner message for a newly opened stuck-PR stall. */
export function formatStuckPr(r: StuckPrRecord, minutes: number): string {
  return (
    `stuck-pr: #${r.pr} (${r.taskId}) head ${r.headSha ?? 'unknown'} has a signed failed verdict (${r.cause}) ` +
    `since ${r.since}, not delivered after ${minutes} min` +
    (r.decisionId ? `; decision ${r.decisionId} filed with a timebox` : '') +
    '.'
  );
}

/**
 * Check the board once for stuck PRs. Opens one stall per (PR, head), files one Decision and raises one
 * notification on opening (a second open of the same PR and head is a no-op), and closes the stall when the
 * PR is delivered, landed or re-queued.
 */
export function checkStuckPrs(deps: StuckPrDeps): StuckPrResult {
  const nowIso = deps.now().toISOString();
  const nowMs = deps.now().getTime();
  const minutes = deps.minutes ?? resolveStuckAfterMinutes(deps.boardDir);
  const state = readStuckState(deps.boardDir);
  const candidates = findStuckCandidates(deps.boardDir, deps.now);
  const keys = new Set(candidates.map(stuckKey));
  const result: StuckPrResult = { opened: [], closed: [], open: [] };
  const next: StuckState = { open: {} };
  for (const [key, rec] of Object.entries(state.open)) {
    if (keys.has(key)) {
      next.open[key] = rec;
      continue;
    }
    result.closed.push({ ...rec, closedAt: nowIso });
    log(deps.boardDir, { event: 'closed', at: nowIso, reason: 'delivered', ...rec });
  }
  for (const c of candidates) {
    const key = stuckKey(c);
    if (next.open[key]) continue;
    const since = Date.parse(c.since);
    if (!Number.isFinite(since) || nowMs - since < minutes * 60_000) continue;
    const rec: StuckPrRecord = { ...c, kind: 'stuck-pr', openedAt: nowIso };
    try {
      const id = deps.fileDecision?.(rec);
      if (id) rec.decisionId = id;
    } catch {
      /* a decision-log failure must not stop the stall from opening */
    }
    try {
      deps.notify?.(rec);
      if (deps.notify) rec.notifiedAt = nowIso;
    } catch {
      /* a notifier failure must not stop the stall from opening */
    }
    next.open[key] = rec;
    result.opened.push(rec);
    log(deps.boardDir, { event: 'opened', ...rec });
  }
  result.open = Object.values(next.open);
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(
    path.join(deps.boardDir, STUCK_STATE_FILE),
    JSON.stringify(next, null, 2) + '\n',
    'utf-8',
  );
  return result;
}
