/**
 * One wake-up of the dispatch session's loop (`/ai-sdlc operator-dispatch`).
 *
 * A tick does the mechanical work and returns what the session has to say:
 *
 *  1. Ingest: every new brief under `<board>/briefs/` becomes manifests, once.
 *     A brief is marked ingested in the loop's state file, so a later tick never
 *     enqueues it again. A brief the board refuses is not retried until the file
 *     changes.
 *  2. Verdict watch: every new verdict in `done/` or `failed/` is recorded, then
 *     the executor that produced it is cleared (once per verdict), then the
 *     unblocking playbook runs on failures.
 *  3. Reports: a progress line at the configured cadence, and one summary when
 *     every task of an ingested brief has reached a final state.
 *
 * Messages are not sent from here. The tick returns escalations and reports and
 * the skill sends them, so this module never types into another session.
 *
 * A verdict is marked handled before anything is done for it: a crash can skip
 * a clear, but can never send a second one.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { collectVerdicts, peekQueue, TASK_ID_RE } from '../dispatch/board.js';
import type { EnqueueEntry } from '../dispatch/enqueue.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { oneLine, sanitizeVerdict } from '../dispatch/verdict-fields.js';
import { parseBrief, type ParsedBrief } from './brief-format.js';
import type { ClearResult } from './clear.js';
import type { PlaybookOutcome } from './playbook.js';
import { readRosterChecked } from './roster.js';

/** Filename of the loop's state under the board directory. */
export const LOOP_STATE_FILENAME = 'operator-dispatch.state.json';
/** Default spacing of planner progress reports. */
export const DEFAULT_REPORT_EVERY_MS = 15 * 60 * 1000;

/** What the loop remembers between ticks. */
export interface LoopState {
  schemaVersion: 'v1';
  /** Brief filename -> the tasks it enqueued. */
  ingested: Record<string, { tasks: string[]; summarised: boolean }>;
  /** Brief filename -> modification time (ms) at which the board refused it. */
  rejected: Record<string, number>;
  /** Verdicts already handled, as `<state>:<task>:<completedAt>`. */
  handled: string[];
  lastReportAt?: string;
}

function emptyState(): LoopState {
  return { schemaVersion: 'v1', ingested: {}, rejected: {}, handled: [] };
}

/** Path of the loop state file. */
export function loopStatePath(boardDir: string): string {
  return path.join(boardDir, LOOP_STATE_FILENAME);
}

/** Read the loop state; a missing or unreadable file is a fresh state. */
export function readLoopState(boardDir: string): LoopState {
  try {
    const parsed = JSON.parse(readFileSync(loopStatePath(boardDir), 'utf-8')) as Partial<LoopState>;
    if (parsed?.schemaVersion !== 'v1') return emptyState();
    return {
      schemaVersion: 'v1',
      ingested: parsed.ingested ?? {},
      rejected: parsed.rejected ?? {},
      handled: Array.isArray(parsed.handled) ? parsed.handled : [],
      ...(parsed.lastReportAt ? { lastReportAt: parsed.lastReportAt } : {}),
    };
  } catch {
    return emptyState();
  }
}

function saveState(boardDir: string, state: LoopState): void {
  mkdirSync(boardDir, { recursive: true });
  const target = loopStatePath(boardDir);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

/** Map a parsed brief to the entries the board enqueues (the same mapping `cli-dispatch enqueue --from-brief` uses). */
export function briefToEnqueueEntries(brief: ParsedBrief): EnqueueEntry[] {
  return brief.entries.map(
    (e): EnqueueEntry => ({
      taskId: e.task,
      ...(e.after.length > 0 ? { after: e.after } : {}),
      ...(e.sequenceGroup ? { sequenceGroup: e.sequenceGroup } : {}),
      ...(e.priority !== undefined ? { priority: e.priority } : {}),
      wave: e.wave,
    }),
  );
}

/** What a clear attempt did for one verdict. */
export interface ClearReport {
  status: 'cleared' | 'degraded' | 'refused' | 'not-permitted' | 'skipped';
  executor?: string;
  reason?: string;
}

/** What the tick did with one verdict. */
export interface VerdictReport {
  taskId: string;
  state: 'done' | 'failed';
  outcome: string;
  workerId: string;
  clear: ClearReport;
  playbook?: PlaybookOutcome;
  /** Decision ids on the verdict that passed validation (never the raw field). */
  decisionIds?: string[];
  /** Verdict fields that failed validation and were dropped, never forwarded. */
  rejectedFields?: string[];
}

/** One line for the planner. */
export interface PlannerReport {
  kind: 'progress' | 'brief-complete';
  text: string;
}

/** Everything a tick did. */
export interface TickResult {
  ingested: { file: string; tasks: string[] }[];
  ingestErrors: { file: string; error: string }[];
  verdicts: VerdictReport[];
  /** Failures the playbook could not fix; the skill messages the planner with each. */
  escalations: { taskId: string; message: string }[];
  reports: PlannerReport[];
}

/** Collaborators of {@link runDispatchTick}; every one is injected in tests. */
export interface LoopDeps {
  boardDir: string;
  /** Roster name of the dispatch session. */
  workerId: string;
  now: () => Date;
  /** Writes manifests for the entries, or throws without writing any. */
  enqueue: (entries: EnqueueEntry[]) => string[];
  /** Clears one executor's context. */
  clear: (opts: { executor: string; taskId: string }) => Promise<ClearResult>;
  /** Applies the unblocking playbook to a failure. */
  playbook: (verdict: DispatchVerdict) => PlaybookOutcome | Promise<PlaybookOutcome>;
  /** Actions the policy grants the dispatch role. */
  operational: ReadonlySet<string>;
  reportEveryMs?: number;
}

function ingestBriefs(
  deps: LoopDeps,
  state: LoopState,
): Pick<TickResult, 'ingested' | 'ingestErrors'> {
  const result: Pick<TickResult, 'ingested' | 'ingestErrors'> = { ingested: [], ingestErrors: [] };
  const dir = path.join(deps.boardDir, 'briefs');
  if (!existsSync(dir)) return result;
  for (const file of readdirSync(dir).sort()) {
    const full = path.join(dir, file);
    // lstat: a symlink named like a brief is never followed.
    if (!file.endsWith('.md') || !lstatSync(full).isFile()) continue;
    if (state.ingested[file]) continue;
    const mtime = statSync(full).mtimeMs;
    if (state.rejected[file] === mtime) continue;
    try {
      const entries = briefToEnqueueEntries(parseBrief(readFileSync(full, 'utf-8')));
      if (entries.length > 0) deps.enqueue(entries);
      state.ingested[file] = { tasks: entries.map((e) => e.taskId), summarised: false };
      delete state.rejected[file];
      saveState(deps.boardDir, state);
      result.ingested.push({ file, tasks: entries.map((e) => e.taskId) });
    } catch (err) {
      state.rejected[file] = mtime;
      saveState(deps.boardDir, state);
      result.ingestErrors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

function stateOf(verdict: DispatchVerdict): 'done' | 'failed' {
  return verdict.outcome === 'success' || verdict.outcome === 'iterate-needed' ? 'done' : 'failed';
}

async function watchVerdicts(
  deps: LoopDeps,
  state: LoopState,
): Promise<Pick<TickResult, 'verdicts' | 'escalations'>> {
  const out: Pick<TickResult, 'verdicts' | 'escalations'> = { verdicts: [], escalations: [] };
  const executors = new Set(
    readRosterChecked(deps.boardDir)
      .roster.sessions.filter((e) => e.role === 'executor' && e.status === 'running')
      .map((e) => e.name),
  );
  for (const raw of collectVerdicts(deps.boardDir)) {
    const verdictState = stateOf(raw);
    const key = `${verdictState}:${raw.taskId}:${raw.completedAt}`;
    if (state.handled.includes(key)) continue;
    state.handled.push(key);
    saveState(deps.boardDir, state);

    // Everything below this line, and everything printed for the session, comes
    // from the checked copy: a hand-written verdict file never reaches the model,
    // the planner or a command line in its raw form.
    const { verdict, dropped } = sanitizeVerdict(raw);
    const report: VerdictReport = {
      taskId: TASK_ID_RE.test(String(raw.taskId)) ? raw.taskId : oneLine(String(raw.taskId), 40),
      state: verdictState,
      outcome: verdict.outcome,
      workerId: verdict.workerId,
      clear: { status: 'skipped', reason: 'the verdict was not written by a roster executor' },
      ...(verdict.decisionIds ? { decisionIds: verdict.decisionIds } : {}),
      ...(dropped.length > 0 ? { rejectedFields: dropped } : {}),
    };
    if (executors.has(verdict.workerId)) {
      report.clear = await clearOnce(deps, verdict);
    }
    if (verdictState === 'failed') {
      const outcome = await deps.playbook(verdict);
      report.playbook = outcome;
      if (outcome.escalation) out.escalations.push(outcome.escalation);
    }
    out.verdicts.push(report);
  }
  return out;
}

async function clearOnce(deps: LoopDeps, verdict: DispatchVerdict): Promise<ClearReport> {
  const executor = verdict.workerId;
  if (!deps.operational.has('clear-executor-context')) {
    return { status: 'not-permitted', executor, reason: 'clear-executor-context is not granted' };
  }
  try {
    const r = await deps.clear({ executor, taskId: verdict.taskId });
    return r.resumed
      ? { status: 'cleared', executor }
      : { status: 'degraded', executor, reason: 'the executor did not report back in time' };
  } catch (err) {
    return {
      status: 'refused',
      executor,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function isDone(boardDir: string, taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) return false;
  if (existsSync(path.join(boardDir, 'done', `${taskId}.completed.json`))) return true;
  try {
    const v = JSON.parse(
      readFileSync(path.join(boardDir, 'done', `${taskId}.verdict.json`), 'utf-8'),
    ) as DispatchVerdict;
    return v.outcome === 'success';
  } catch {
    return false;
  }
}

function isFailed(boardDir: string, taskId: string): boolean {
  if (!TASK_ID_RE.test(taskId)) return false;
  return ['.verdict.json', '.diagnostic.json'].some((s) =>
    existsSync(path.join(boardDir, 'failed', `${taskId}${s}`)),
  );
}

function buildReports(deps: LoopDeps, state: LoopState, handledCount: number): PlannerReport[] {
  const reports: PlannerReport[] = [];
  for (const [file, brief] of Object.entries(state.ingested)) {
    if (brief.summarised || brief.tasks.length === 0) continue;
    const done = brief.tasks.filter((t) => isDone(deps.boardDir, t));
    const failed = brief.tasks.filter((t) => !done.includes(t) && isFailed(deps.boardDir, t));
    if (done.length + failed.length < brief.tasks.length) continue;
    brief.summarised = true;
    reports.push({
      kind: 'brief-complete',
      text:
        `Brief ${file} is finished: ${done.length} of ${brief.tasks.length} tasks done` +
        (failed.length > 0 ? `, ${failed.length} failed (${failed.join(', ')})` : ''),
    });
  }
  const every = deps.reportEveryMs ?? DEFAULT_REPORT_EVERY_MS;
  const last = state.lastReportAt ? Date.parse(state.lastReportAt) : Number.NaN;
  const nowMs = deps.now().getTime();
  if (Number.isNaN(last) || nowMs - last >= every) {
    const c = peekQueue(deps.boardDir);
    if (c.queued + c.inflight + c.done + c.failed > 0) {
      reports.push({
        kind: 'progress',
        text:
          `Progress: ${c.queued} queued, ${c.inflight} inflight, ${c.done} done, ${c.failed} failed` +
          (handledCount > 0 ? `; ${handledCount} new verdict(s) this wake-up` : ''),
      });
      state.lastReportAt = deps.now().toISOString();
    }
  }
  return reports;
}

/** Run one wake-up of the dispatch loop. */
export async function runDispatchTick(deps: LoopDeps): Promise<TickResult> {
  const state = readLoopState(deps.boardDir);
  const ingest = ingestBriefs(deps, state);
  const watch = await watchVerdicts(deps, state);
  const reports = buildReports(deps, state, watch.verdicts.length);
  saveState(deps.boardDir, state);
  return { ...ingest, ...watch, reports };
}
