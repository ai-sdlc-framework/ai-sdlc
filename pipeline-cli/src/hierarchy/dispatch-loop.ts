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
 * 4. Marker and budget: every tick writes a `DispatchTick` marker so the usage ledger can
 *    count the session's model turns per tick, and the turns-per-tick budget is reviewed.
 *
 * Messages are not sent from here. The tick returns escalations and reports and
 * the skill sends them, so this module never types into another session.
 *
 * A verdict is marked handled before anything is done for it: a crash can skip
 * a clear, but can never send a second one.
 */

import { DEFAULT_QUOTA_FLOOR, lowestRemaining, type Quota } from './gh-calls.js';
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
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { PromotedDecision } from '../decisions/escalation-chain.js';
import { boardStateOf, collectVerdicts, peekQueue, TASK_ID_RE } from '../dispatch/board.js';
import type { EnqueueEntry } from '../dispatch/enqueue.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { sanitizeVerdict } from '../dispatch/verdict-fields.js';
import { parseBrief, type ParsedBrief } from './brief-format.js';
import { pruneEvents } from './pr-snapshot.js';
import { processCanaryEvents, type CanaryReport } from './canary.js';
import {
  downRecordedExecutors,
  isEphemeralWorker,
  spawnForEligibleClaims,
  sweepFinishedExecutors,
  type EphemeralDeps,
  type EphemeralReport,
} from './ephemeral-tick.js';
import { checkDrainStall, formatDrainStall, resolveStallAfterMinutes } from './drain-stall.js';
import { readHold, type Hold } from './hold.js';
import {
  classifyHumanAttention,
  formatHumanAttentionRow,
  formatHumanAttentionStall,
  type HumanAttentionPr,
  type HumanAttentionRow,
} from './human-attention.js';
import type { ClearResult } from './clear.js';
import type { LandReport } from './land-eligible.js';
import type { DispatchTickMarker } from '../usage/dispatch-turns.js';
import type { MarkReadyReport } from './mark-ready.js';
import type { PlaybookOutcome } from './playbook.js';
import {
  classifyClosedUnmerged,
  type ClosedUnmergedReport,
  type ListedClosedPr,
} from '../kpi/closed-unmerged.js';
import { summariseLanding, takeSuppressedNote } from './reconcile.js';
import { readRosterChecked } from './roster.js';
import type { ParentUpkeepResult } from '../steps/00-parent-upkeep.js';
import { formatStall, reapStalledClaims, type StallDeps, type StalledReport } from './stall.js';

/** Filename of the loop's state under the board directory. */
export const LOOP_STATE_FILENAME = 'operator-dispatch.state.json';
/** Default spacing of planner progress reports. */
export const DEFAULT_REPORT_EVERY_MS = 15 * 60 * 1000;

/** Seconds until the next wake when a brief or a verdict was handled this tick. */
export const WAKE_PENDING_SEC = 30;
/** Seconds until the next wake when work is queued or inflight; a new verdict wakes the session sooner. */
export const WAKE_ACTIVE_SEC = 300;
/** Seconds until the next wake when the board is empty and nothing is inflight. */
export const WAKE_IDLE_SEC = 1800;

/** Why the session should wake after `nextWakeSec`. */
export type WakeReason = 'pending' | 'active' | 'idle';

/** What the loop remembers between ticks. */
export interface LoopState {
  schemaVersion: 'v1';
  /** Brief filename -> the tasks it enqueued. */
  ingested: Record<string, { tasks: string[]; summarised: boolean }>;
  /**
   * Brief filename -> the refusal record (AISDLC-952). A bare number is the older
   * format (mtime only) and is still read.
   */
  rejected: Record<string, number | RejectedBrief>;
  /** Verdicts already handled, as `<state>:<task>:<completedAt>`. */
  handled: string[];
  lastReportAt?: string;
  /** When the tick last read GitHub (AISDLC-960). */
  lastGithubReadAt?: string;
  /** Whether the board was held at the last tick; a held-to-free change is `holdLifted` (AISDLC-1089). */
  wasHeld?: boolean;
  /** When a tick last ran, and who ran it (AISDLC-1096). */
  lastTickAt?: string;
  lastTickBy?: 'host' | 'scheduler';
  /** When this drain window began (AISDLC-831); set on the first tick. */
  drainStartedAt?: string;
}

/** Why and when the board refused a brief. */
export interface RejectedBrief {
  /** Modification time (ms) of the brief when it was refused. */
  mtime: number;
  /** The refusal message. */
  error: string;
  /** Parent `HEAD` at refusal; absent when it could not be read. */
  parentHead?: string;
}

/** Parent repository `HEAD`, or undefined when it cannot be read. */
export function readParentHead(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
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
      ...(parsed.lastGithubReadAt ? { lastGithubReadAt: parsed.lastGithubReadAt } : {}),
      ...(parsed.wasHeld ? { wasHeld: true } : {}),
      ...(parsed.lastTickAt ? { lastTickAt: parsed.lastTickAt } : {}),
      ...(parsed.lastTickBy ? { lastTickBy: parsed.lastTickBy } : {}),
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
  return brief.entries.map((e): EnqueueEntry => ({
    taskId: e.task,
    ...(e.after.length > 0 ? { after: e.after } : {}),
    ...(e.sequenceGroup ? { sequenceGroup: e.sequenceGroup } : {}),
    ...(e.priority !== undefined ? { priority: e.priority } : {}),
    wave: e.wave,
    ...(e.fixesPr !== undefined ? { fixesPr: e.fixesPr } : {}),
    ...(e.prHeadRef ? { prHeadRef: e.prHeadRef } : {}),
  }));
}

/** What a clear attempt did for one verdict. */
export interface ClearReport {
  status: 'cleared' | 'failed' | 'refused' | 'not-permitted' | 'skipped';
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
  kind: 'progress' | 'brief-complete' | 'drain-stall';
  text: string;
}

/** The turns-per-tick budget check, as the loop reports it. */
export interface TurnBudgetReview {
  /** Rolling median of turns per tick over the window, null when no tick has completed. */
  median: number | null;
  budget: number;
  overBudget: boolean;
  /** Present when this tick filed a Decision. */
  decisionId?: string;
  /** Step that used the most turns, when over budget. */
  costliestStep?: string;
  /** Why no Decision was filed although over budget (one is already open). */
  skipped?: string;
}

/** Everything a tick did. */
export interface TickResult {
  ingested: { file: string; tasks: string[] }[];
  ingestErrors: { file: string; error: string }[];
  /** Brief tasks already on the board (a resume, say): skipped, the rest of the brief ingested (AISDLC-868). */
  skipped?: { file: string; taskId: string; state: string }[];
  verdicts: VerdictReport[];
  /** Failures the playbook could not fix; the skill messages the planner with each. */
  escalations: { taskId: string; message: string }[];
  reports: PlannerReport[];
  /** Stalled claims reaped this tick (AISDLC-826); the planner is not asked about them. */
  stalled?: StalledReport[];
  /** Open PRs that need a human (AISDLC-888); absent when there are none. */
  humanAttention?: HumanAttentionRow[];
  /** Seconds the session should sleep before the next wake-up (30, 300 or 1800). */
  nextWakeSec: number;
  wakeReason: WakeReason;
  /** Present when the `mark-ready-after-codeql` action is granted and a hook was supplied. */
  markReady?: MarkReadyReport;
  /** Present when the `land-eligible-prs` action is granted and a hook was supplied (AISDLC-894). */
  landed?: LandReport;
  /** Decisions moved up a tier this tick because their timebox lapsed. */
  promotions?: PromotedDecision[];
  /** Present while the board is held (AISDLC-899): claims and relaunches are skipped, reporting is not. */
  held?: Hold;
  /** Present when the tick skipped its GitHub reads for low quota (AISDLC-963). */
  quotaSkip?: { remaining: number; floor: number };
  /** Present when the parent upkeep ran this tick (AISDLC-981). */
  parentUpkeep?: ParentUpkeepResult;
  /** Present when a pipeline canary event set or lifted the hold this tick (AISDLC-1023). */
  canary?: CanaryReport;
  /** Present when the ephemeral steps downed or spawned an executor, or a spawn failed (RFC-0059). */
  ephemeral?: EphemeralReport;
  /** True on the first tick after a hold was lifted (AISDLC-1089). */
  holdLifted?: boolean;
  /** Task ids queued and eligible to claim, in claim order; filled by `cli-hierarchy tick` (AISDLC-1089). */
  eligibleQueued?: string[];
  /** Names of idle executor sessions; filled by `cli-hierarchy tick` (AISDLC-1089). */
  idleExecutors?: string[];
  /** PRs closed unmerged in the drain window (AISDLC-831); absent when GitHub was not read. */
  closedUnmerged?: number;
  /** Deterministic list of what stops the drain; the dispatch command sends it to the planner when it changes. */
  blockers: string[];
  /** The marker written for this tick. */
  tickMarker: DispatchTickMarker;
  /** Present when a budget review was supplied and did not fail. */
  turnBudget?: TurnBudgetReview;
}

/**
 * How long the session may sleep. `markReady.failedAnalyze` is deliberately not counted
 * as handled work: it is a standing condition that repeats every tick until fixed, so
 * counting it would pin the 30s wake and break the idle budget. Work handled this tick, or a brief the board
 * refused, wakes it soon; queued or inflight work is watched at a slower rate (a new
 * brief or verdict file wakes it sooner); an empty board with nothing inflight sleeps
 * the longest, so an idle session costs at most two model calls an hour.
 */
export function computeNextWake(
  boardDir: string,
  result: Pick<TickResult, 'ingested' | 'ingestErrors' | 'verdicts' | 'escalations' | 'reports'> &
    Partial<Pick<TickResult, 'stalled'>>,
  markReady?: MarkReadyReport,
): { nextWakeSec: number; wakeReason: WakeReason } {
  const handled =
    result.ingested.length > 0 ||
    result.ingestErrors.length > 0 ||
    result.verdicts.length > 0 ||
    result.escalations.length > 0 ||
    (result.stalled?.length ?? 0) > 0 ||
    (markReady !== undefined && markReady.readied.length > 0);
  if (handled) return { nextWakeSec: WAKE_PENDING_SEC, wakeReason: 'pending' };
  const c = peekQueue(boardDir);
  if (c.queued + c.inflight > 0) return { nextWakeSec: WAKE_ACTIVE_SEC, wakeReason: 'active' };
  return { nextWakeSec: WAKE_IDLE_SEC, wakeReason: 'idle' };
}

/**
 * What stops the drain, as plain lines (AISDLC-899): the hold, failures awaiting the
 * planner, queued tasks whose prerequisite has not finished, and queued work with no
 * running executor. Deterministic, so the command can send it whenever it changes.
 */
export function computeBlockers(
  boardDir: string,
  held: Hold | null,
  escalations: readonly { taskId: string }[],
): string[] {
  const out: string[] = [];
  if (held) out.push(`held: ${held.reason}`);
  for (const e of escalations) out.push(`${e.taskId}: failure awaits the planner`);
  const queueDir = path.join(boardDir, 'queue');
  let queued = 0;
  if (existsSync(queueDir)) {
    for (const f of readdirSync(queueDir).sort()) {
      if (!f.endsWith('.json')) continue;
      queued += 1;
      try {
        const m = JSON.parse(readFileSync(path.join(queueDir, f), 'utf-8')) as {
          taskId?: string;
          after?: unknown;
        };
        const waiting = (Array.isArray(m.after) ? m.after : []).filter(
          (a): a is string => typeof a === 'string' && !isDone(boardDir, a),
        );
        if (m.taskId && waiting.length > 0) {
          out.push(`${m.taskId}: waits on ${waiting.join(', ')}`);
        }
      } catch {
        /* an unreadable manifest is not a blocker line */
      }
    }
  }
  if (queued > 0) {
    try {
      const running = readRosterChecked(boardDir).roster.sessions.filter(
        (s) => s.role === 'executor' && s.status === 'running',
      );
      if (running.length === 0) out.push(`${queued} task(s) queued and no executor running`);
    } catch {
      /* no roster: nothing to say */
    }
  }
  return out;
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
  clear: (opts: { executor: string; taskId?: string }) => Promise<ClearResult>;
  /** Applies the unblocking playbook to a failure. */
  playbook: (verdict: DispatchVerdict) => PlaybookOutcome | Promise<PlaybookOutcome>;
  /** Actions the policy grants the dispatch role. */
  operational: ReadonlySet<string>;
  reportEveryMs?: number;
  /** Marks CodeQL-clean drafts ready; called only when `mark-ready-after-codeql` is granted. */
  markReady?: () => MarkReadyReport;
  /** Lands eligible own-author PRs through merge-if-eligible; called only when `land-eligible-prs` is granted. */
  landEligible?: () => Promise<LandReport>;
  /** Moves escalated decisions whose tier timebox lapsed up one tier; its failure never fails the tick. */
  promoteExpired?: () => PromotedDecision[];
  /**
   * Stall check (AISDLC-826). Absent means no check runs; `boardDir`, `now`,
   * `clear` and `requeue` default to this tick's own.
   */
  stall?: Partial<Omit<StallDeps, 'boardDir' | 'now'>>;
  /** Open PRs for the human-attention section (AISDLC-888); undefined when GitHub cannot be read. */
  listPrs?: () => HumanAttentionPr[] | undefined;
  /** Parent `HEAD`; a rejected brief is retried when it moves (AISDLC-952). */
  parentHead?: () => string | undefined;
  /** Live remaining quota (AISDLC-963); below `quotaFloor` the tick skips its GitHub reads. */
  quota?: () => Quota | undefined;
  /** Floor of remaining quota; default 300. */
  quotaFloor?: number;
  /**
   * Parent upkeep (AISDLC-981): orchestrator-state recovery, merged-worktree sweep and
   * untracked-file sync, once per tick. The executors only assert the parent.
   */
  parentUpkeep?: () => Promise<ParentUpkeepResult>;
  /** Ephemeral executors (RFC-0059): down on verdict, sweep, spawn per claim; absent means standing executors only. */
  ephemeral?: EphemeralDeps;
  /** PRs for the closed-unmerged KPI (AISDLC-831); undefined when GitHub cannot be read. */
  listAllPrs?: () => ListedClosedPr[] | undefined;
  /** Files the hotfix task for a red pipeline canary (AISDLC-1023); absent means events are not processed. */
  fileHotfix?: (opts: { sha: string; detail: string }) => string;
  /** Idle executors holding no inflight task (AISDLC-1101); absent means no drain-stall check runs. */
  idleExecutors?: () => string[];
  /** Who runs this tick; the scheduler stands in for a silent host (AISDLC-1096). Default host. */
  tickedBy?: 'host' | 'scheduler';
  /** Numbers of the open PRs, for pruning consumed webhook events; undefined when GitHub cannot be read. */
  openPrNumbers?: () => ReadonlySet<number> | undefined;
  /** Records the tick marker; its failure never fails the tick. */
  recordTick?: (marker: DispatchTickMarker) => void;
  /** Checks the turns-per-tick budget and files a Decision on an overrun; its failure never fails the tick. */
  reviewTurnBudget?: () => TurnBudgetReview | Promise<TurnBudgetReview>;
}

function ingestBriefs(
  deps: LoopDeps,
  state: LoopState,
): Pick<TickResult, 'ingested' | 'ingestErrors'> & {
  skipped: { file: string; taskId: string; state: string }[];
} {
  const result: Pick<TickResult, 'ingested' | 'ingestErrors'> & {
    skipped: { file: string; taskId: string; state: string }[];
  } = { ingested: [], ingestErrors: [], skipped: [] };
  const dir = path.join(deps.boardDir, 'briefs');
  if (!existsSync(dir)) return result;
  const head = deps.parentHead?.();
  for (const file of readdirSync(dir).sort()) {
    const full = path.join(dir, file);
    // lstat: a symlink named like a brief is never followed.
    if (!file.endsWith('.md') || !lstatSync(full).isFile()) continue;
    if (state.ingested[file]) continue;
    const mtime = statSync(full).mtimeMs;
    const prior = state.rejected[file];
    if (prior !== undefined) {
      const rec: RejectedBrief =
        typeof prior === 'number' ? { mtime: prior, error: '(error text not recorded)' } : prior;
      const headMoved =
        rec.parentHead !== undefined && head !== undefined && rec.parentHead !== head;
      if (rec.mtime === mtime && !headMoved) {
        result.ingestErrors.push({ file, error: rec.error });
        continue;
      }
    }
    try {
      const all = briefToEnqueueEntries(parseBrief(readFileSync(full, 'utf-8')));
      const entries = all.filter((e) => {
        const where = boardStateOf(deps.boardDir, e.taskId);
        if (where) result.skipped.push({ file, taskId: e.taskId, state: where });
        return !where;
      });
      if (entries.length > 0) deps.enqueue(entries);
      state.ingested[file] = { tasks: entries.map((e) => e.taskId), summarised: false };
      delete state.rejected[file];
      saveState(deps.boardDir, state);
      result.ingested.push({ file, tasks: entries.map((e) => e.taskId) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      state.rejected[file] = { mtime, error, ...(head !== undefined ? { parentHead: head } : {}) };
      saveState(deps.boardDir, state);
      result.ingestErrors.push({ file, error });
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
  held: Hold | null,
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
    // Held, the clear and the playbook do not run, so the verdict stays unhandled
    // and is processed on the first tick after `resume`.
    if (!held) {
      state.handled.push(key);
      saveState(deps.boardDir, state);
    }

    // Everything below this line, and everything printed for the session, comes
    // from the checked copy: a hand-written verdict file never reaches the model,
    // the planner or a command line in its raw form.
    const { verdict, dropped } = sanitizeVerdict(raw);
    const report: VerdictReport = {
      taskId: verdict.taskId,
      state: verdictState,
      outcome: verdict.outcome,
      workerId: verdict.workerId,
      clear: { status: 'skipped', reason: 'the verdict was not written by a roster executor' },
      ...(verdict.decisionIds ? { decisionIds: verdict.decisionIds } : {}),
      ...(dropped.length > 0 ? { rejectedFields: dropped } : {}),
    };
    if (held) {
      report.clear = { status: 'skipped', reason: `the board is held: ${held.reason}` };
      if (verdictState === 'failed') {
        // The playbook re-queues and relaunches; held, the planner decides instead.
        out.escalations.push({
          taskId: verdict.taskId,
          message: `${verdict.taskId} failed (${verdict.outcome}) while the board is held (${held.reason}); the playbook did not run.`,
        });
      }
    } else {
      if (deps.ephemeral && isEphemeralWorker(deps.boardDir, verdict.workerId)) {
        // The executor ends with its task: dispatch downs it in this tick instead of clearing it.
        report.clear = {
          status: 'skipped',
          executor: verdict.workerId,
          reason: 'ephemeral executor: downed',
        };
      } else if (executors.has(verdict.workerId)) {
        report.clear = await clearOnce(deps, state, verdict);
      }
      if (verdictState === 'failed') {
        const outcome = await deps.playbook(verdict);
        report.playbook = outcome;
        if (outcome.escalation) out.escalations.push(outcome.escalation);
      }
    }
    out.verdicts.push(report);
  }
  return out;
}

async function clearOnce(
  deps: LoopDeps,
  state: LoopState,
  verdict: DispatchVerdict,
): Promise<ClearReport> {
  const executor = verdict.workerId;
  if (!deps.operational.has('clear-executor-context')) {
    return { status: 'not-permitted', executor, reason: 'clear-executor-context is not granted' };
  }
  try {
    // The task id goes on the clear event only when it is well formed.
    const taskId = TASK_ID_RE.test(verdict.taskId) ? verdict.taskId : undefined;
    // The pane is driven here, on the tick that consumes the verdict (AISDLC-1107).
    const r = await deps.clear({ executor, ...(taskId ? { taskId } : {}) });
    return r.ok
      ? { status: 'cleared', executor }
      : { status: 'failed', executor, reason: r.reason ?? 'the pane did not reach a fresh prompt' };
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

function buildReports(
  deps: LoopDeps,
  state: LoopState,
  handledCount: number,
  closedUnmerged?: ClosedUnmergedReport,
): PlannerReport[] {
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
    const suppressed = takeSuppressedNote(deps.boardDir);
    const prs = [summariseLanding(deps.boardDir), suppressed].filter(Boolean).join('; ');
    if (c.queued + c.inflight + c.done + c.failed > 0 || prs !== '') {
      reports.push({
        kind: 'progress',
        text:
          `Progress: ${c.queued} queued, ${c.inflight} inflight, ${c.done} done, ${c.failed} failed` +
          (handledCount > 0 ? `; ${handledCount} new verdict(s) this wake-up` : '') +
          (prs === '' ? '' : `; PRs: ${prs}`) +
          (closedUnmerged ? `; closedUnmerged: ${closedUnmerged.total}` : ''),
      });
      state.lastReportAt = deps.now().toISOString();
    }
  }
  return reports;
}

/**
 * Reap stalled claims. The failure record is marked handled first, so the
 * verdict watch never clears the holder a second time.
 */
async function checkStalls(
  deps: LoopDeps,
  state: LoopState,
  held: Hold | null,
): Promise<StalledReport[]> {
  const stall = deps.stall;
  if (!stall || held) return [];
  const standardClear: StallDeps['clear'] = deps.operational.has('clear-executor-context')
    ? async (o) => {
        const r = await clearOnce(deps, state, {
          taskId: o.taskId,
          workerId: o.executor,
        } as DispatchVerdict);
        return { status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
      }
    : undefined;
  // A crashed ephemeral executor is downed, not cleared (RFC-0059); the others keep the clear.
  const stallClear: StallDeps['clear'] = deps.ephemeral
    ? async (o) => {
        if (isEphemeralWorker(deps.boardDir, o.executor)) {
          const r = await deps.ephemeral!.down(o.executor);
          return { status: r.ok ? 'downed' : 'failed', ...(r.reason ? { reason: r.reason } : {}) };
        }
        return standardClear ? standardClear(o) : { status: 'not-permitted' };
      }
    : standardClear;
  try {
    return await reapStalledClaims(
      {
        ...stall,
        boardDir: deps.boardDir,
        now: deps.now,
        isEphemeral: deps.ephemeral ? (w) => isEphemeralWorker(deps.boardDir, w) : undefined,
        clear: stallClear,
        requeue: deps.operational.has('requeue') ? stall.requeue : undefined,
      },
      (v) => {
        state.handled.push(`failed:${v.taskId}:${v.completedAt}`);
        saveState(deps.boardDir, state);
      },
    );
  } catch {
    return [];
  }
}

/**
 * RFC-0059 order: verdicts are recorded (by the caller), then finished executors are
 * downed, the sweep catches any still alive 5 minutes after its verdict, crashed ones are
 * reaped by the stall path (which downs rather than clears them), then a spawn per
 * eligible claim up to the cap. Held, nothing is downed or spawned.
 */
async function runEphemeralSteps(
  deps: LoopDeps,
  verdicts: readonly VerdictReport[],
  held: Hold | null,
  quotaSkip: TickResult['quotaSkip'],
  reap: () => Promise<StalledReport[]>,
): Promise<{ stalled: StalledReport[]; report?: EphemeralReport }> {
  const eph = deps.ephemeral;
  if (!eph || held) return { stalled: await reap() };
  const report: EphemeralReport = { downed: [], spawned: [], spawnErrors: [] };
  await downRecordedExecutors(deps.boardDir, eph, verdicts, report);
  try {
    await sweepFinishedExecutors(deps.boardDir, eph, deps.now().getTime(), report);
  } catch {
    /* an unreadable verdict must not stop the dispatch loop */
  }
  const stalled = await reap();
  if (!quotaSkip) {
    try {
      await spawnForEligibleClaims(deps.boardDir, eph, deps.now, report);
    } catch {
      /* an unreadable queue must not stop the dispatch loop */
    }
  }
  return { stalled, report };
}

/** GitHub reads happen at most this often unless a webhook wake is newer (AISDLC-960). */
export const GITHUB_READ_INTERVAL_MS = 5 * 60 * 1000;

/** True when the last GitHub read is under the interval old and no webhook wake followed it. */
function githubReadFresh(deps: LoopDeps, state: LoopState): boolean {
  const last = state.lastGithubReadAt ? Date.parse(state.lastGithubReadAt) : Number.NaN;
  if (!Number.isFinite(last)) return false;
  if (deps.now().getTime() - last >= GITHUB_READ_INTERVAL_MS) return false;
  try {
    return statSync(path.join(deps.boardDir, '.reconcile-wake')).mtimeMs <= last;
  } catch {
    return true;
  }
}

/** Collect the steps of a tick in the order they ran, each with its start time. */
class StepLog {
  readonly steps: { name: string; startedAt: string }[] = [];
  constructor(private readonly now: () => Date) {}
  start(name: string): void {
    this.steps.push({ name, startedAt: this.now().toISOString() });
  }
}

/** Run one wake-up of the dispatch loop. */
export async function runDispatchTick(deps: LoopDeps): Promise<TickResult> {
  const startedAt = deps.now().toISOString();
  const log = new StepLog(deps.now);
  const state = readLoopState(deps.boardDir);
  log.start('ingest');
  const { skipped, ...ingestRest } = ingestBriefs(deps, state);
  const ingest = { ...ingestRest, ...(skipped.length > 0 ? { skipped } : {}) };
  // AISDLC-1023: a canary event sets or lifts the hold before this tick reads it.
  let canary: CanaryReport | undefined;
  if (deps.fileHotfix) {
    try {
      const r = processCanaryEvents({
        boardDir: deps.boardDir,
        now: deps.now,
        fileHotfix: deps.fileHotfix,
      });
      if (r.held || r.lifted || r.filed || r.errors.length > 0) canary = r;
    } catch {
      /* an unreadable event must not stop the dispatch loop */
    }
  }
  const held = readHold(deps.boardDir);
  const holdLifted = state.wasHeld === true && !held;
  if (held) state.wasHeld = true;
  else delete state.wasHeld;
  let quotaSkip: TickResult['quotaSkip'];
  try {
    const remaining = lowestRemaining(deps.quota?.());
    const floor = deps.quotaFloor ?? DEFAULT_QUOTA_FLOOR;
    if (remaining !== undefined && remaining < floor) quotaSkip = { remaining, floor };
  } catch {
    /* an unreadable quota must not stop the dispatch loop */
  }
  let parentUpkeep: ParentUpkeepResult | undefined;
  if (deps.parentUpkeep) {
    try {
      parentUpkeep = quotaSkip ? undefined : await deps.parentUpkeep();
    } catch (err) {
      parentUpkeep = {
        ok: false,
        swept: 0,
        reason: `parent upkeep threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const githubFresh = githubReadFresh(deps, state);
  const readGithub = !quotaSkip && !githubFresh;
  log.start('verdicts');
  const watch = await watchVerdicts(deps, state, held);
  const ephemeral = await runEphemeralSteps(deps, watch.verdicts, held, quotaSkip, async () => {
    const stalled = await checkStalls(deps, state, held);
    return stalled;
  });
  const stalled = ephemeral.stalled;
  state.drainStartedAt ??= deps.now().toISOString();
  let closedUnmerged: ClosedUnmergedReport | undefined;
  try {
    const all = readGithub ? deps.listAllPrs?.() : undefined;
    if (all) closedUnmerged = classifyClosedUnmerged(all, new Date(state.drainStartedAt));
  } catch {
    /* an unreadable PR list must not stop the dispatch loop */
  }
  log.start('reports');
  const reports = [...buildReports(deps, state, watch.verdicts.length, closedUnmerged)];
  if (canary?.held) {
    reports.push({
      kind: 'progress',
      text: `${canary.held}: board held${canary.filed ? `, hotfix ${canary.filed.task} filed` : ''}`,
    });
  }
  if (canary?.lifted) {
    reports.push({ kind: 'progress', text: `pipeline canary green: lifted "${canary.lifted}"` });
  }
  for (const e of canary?.errors ?? []) reports.push({ kind: 'progress', text: e });
  if (quotaSkip) {
    reports.push({
      kind: 'progress',
      text: `skipped GitHub reads: remaining quota ${quotaSkip.remaining} is below the floor ${quotaSkip.floor}`,
    });
  }
  if (parentUpkeep && !parentUpkeep.ok) {
    reports.push({ kind: 'progress', text: `parent upkeep refused: ${parentUpkeep.reason}` });
  }
  for (const s of stalled) reports.push({ kind: 'progress', text: formatStall(s) });
  if (deps.idleExecutors) {
    try {
      const ds = checkDrainStall({
        boardDir: deps.boardDir,
        now: deps.now,
        held,
        idleExecutors: deps.idleExecutors,
      });
      if (ds.opened) {
        reports.push({
          kind: 'drain-stall',
          text: formatDrainStall(ds.opened, resolveStallAfterMinutes(deps.boardDir)),
        });
      }
      if (ds.closed) {
        reports.push({
          kind: 'progress',
          text: `drain-stall closed: the drain moved again (was stalled at ${ds.closed.stage})`,
        });
      }
    } catch {
      /* a detector failure must not stop the dispatch loop */
    }
  }
  let humanAttention: HumanAttentionRow[] = [];
  try {
    humanAttention = !readGithub ? [] : classifyHumanAttention(deps.listPrs?.() ?? [], deps.now());
  } catch {
    /* an unreadable PR list must not stop the dispatch loop */
  }
  for (const r of humanAttention) {
    reports.push({ kind: 'progress', text: formatHumanAttentionRow(r) });
    if (r.stalled) reports.push({ kind: 'progress', text: formatHumanAttentionStall(r) });
  }
  if (readGithub && (deps.listPrs || deps.markReady || deps.landEligible)) {
    state.lastGithubReadAt = deps.now().toISOString();
  }
  state.lastTickAt = deps.now().toISOString();
  state.lastTickBy = deps.tickedBy ?? 'host';
  saveState(deps.boardDir, state);
  try {
    pruneEvents(deps.boardDir, readGithub ? deps.openPrNumbers?.() : undefined);
  } catch {
    /* pruning must not stop the dispatch loop */
  }
  if (readGithub) log.start('github');
  const markReady =
    readGithub && deps.markReady && deps.operational.has('mark-ready-after-codeql')
      ? deps.markReady()
      : undefined;
  let landed: LandReport | undefined;
  if (readGithub && deps.landEligible && deps.operational.has('land-eligible-prs')) {
    try {
      landed = await deps.landEligible();
    } catch (err) {
      landed = {
        landed: [],
        refused: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  let promotions: PromotedDecision[] = [];
  if (deps.promoteExpired) {
    log.start('promotions');
    try {
      promotions = deps.promoteExpired();
    } catch {
      /* an unreadable decision log must not stop the dispatch loop */
    }
  }
  const eph = ephemeral.report;
  const ephemeralActive =
    eph !== undefined &&
    (eph.downed.length > 0 || eph.spawned.length > 0 || eph.spawnErrors.length > 0);
  const wake = computeNextWake(deps.boardDir, { ...ingest, ...watch, reports, stalled }, markReady);
  if (ephemeralActive) {
    wake.nextWakeSec = Math.min(wake.nextWakeSec, WAKE_PENDING_SEC);
    wake.wakeReason = 'pending';
  }
  const blockers = computeBlockers(deps.boardDir, held, watch.escalations);

  const tickMarker: DispatchTickMarker = {
    tickId: `${deps.workerId}@${startedAt}`,
    startedAt,
    endedAt: deps.now().toISOString(),
    steps: log.steps,
    nextWakeSec: wake.nextWakeSec,
  };
  try {
    deps.recordTick?.(tickMarker);
  } catch {
    /* a marker is observability; losing one must not stop the loop */
  }
  let turnBudget: TurnBudgetReview | undefined;
  try {
    turnBudget = await deps.reviewTurnBudget?.();
  } catch {
    /* an unreadable ledger must not stop the dispatch loop */
  }
  return {
    blockers,
    ...(closedUnmerged ? { closedUnmerged: closedUnmerged.total } : {}),
    ...(held ? { held } : {}),
    ...(holdLifted ? { holdLifted } : {}),
    ...ingest,
    ...watch,
    reports,
    ...(quotaSkip ? { quotaSkip } : {}),
    ...(parentUpkeep ? { parentUpkeep } : {}),
    ...(canary ? { canary } : {}),
    ...(stalled.length > 0 ? { stalled } : {}),
    ...(ephemeralActive ? { ephemeral: eph } : {}),
    ...(humanAttention.length > 0 ? { humanAttention } : {}),
    ...wake,
    tickMarker,
    ...(markReady ? { markReady } : {}),
    ...(landed ? { landed } : {}),
    ...(promotions.length > 0 ? { promotions } : {}),
    ...(turnBudget ? { turnBudget } : {}),
  };
}
