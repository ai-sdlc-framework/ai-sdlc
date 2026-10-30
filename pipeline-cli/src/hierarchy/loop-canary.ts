/**
 * Hierarchy loop canary (AISDLC-1102): a synthetic docs-only task driven through the live
 * session hierarchy, with a deadline per stage.
 *
 * Unit tests cannot see the lifecycle break between sessions (a verdict marker that never
 * matched, a rotate request nobody read, a clear that never ran). The canary enqueues two
 * synthetic tasks, `CANARY-<n>` (the probe) and `CANARY-<n+1>` (the re-claim probe), and
 * checks the board for five stages in order:
 *
 *  1. `claimed`          an executor claimed the probe
 *  2. `developed`        the probe's verdict landed in `done/`
 *  3. `verdictRecorded`  the dispatch tick handled that verdict
 *  4. `executorCleared`  the executor that wrote it was cleared (or downed): a clear stamp
 *  5. `reclaimed`        the re-claim probe was claimed afterwards
 *
 * A stage that misses its deadline writes a failure record naming it and a planner message.
 * Records live under `<board>/canary-runs/` and the synthetic ids are excluded from the
 * board's done and failed counts (`peekQueue`).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { boardStateOf, isOnBoard, readInflightManifest, retireQueued } from '../dispatch/board.js';
import { enqueueTasks } from '../dispatch/enqueue.js';

/** Task id prefix of every synthetic task; the board counts skip it. */
export const CANARY_TASK_PREFIX = 'CANARY-';
/** The five stages, in order. */
export const CANARY_STAGES = [
  'claimed',
  'developed',
  'verdictRecorded',
  'executorCleared',
  'reclaimed',
] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];

const MIN = 60_000;
/** Default time allowed for each stage, counted from the previous stage (or the start). */
export const CANARY_DEFAULT_DEADLINES_MS: Record<CanaryStage, number> = {
  claimed: 15 * MIN,
  developed: 30 * MIN,
  verdictRecorded: 10 * MIN,
  executorCleared: 10 * MIN,
  reclaimed: 15 * MIN,
};
/** The canary runs this often once it has run. */
export const CANARY_INTERVAL_MS = 24 * 60 * MIN;

const DIR = 'canary-runs';
const DUE_FILE = '.due';

/** True for a synthetic canary task id. */
export function isCanaryTask(taskId: string): boolean {
  return taskId.startsWith(CANARY_TASK_PREFIX);
}

/** One canary run record. */
export interface CanaryRun {
  runId: string;
  taskId: string;
  followTaskId: string;
  startedAt: string;
  status: 'running' | 'pass' | 'fail';
  /** ISO time each stage was first seen. */
  stages: Partial<Record<CanaryStage, string>>;
  /** Roster name of the executor that wrote the probe's verdict. */
  executor?: string;
  finishedAt?: string;
  failedStage?: CanaryStage;
  reason?: string;
}

function dirOf(boardDir: string): string {
  return path.join(boardDir, DIR);
}

function runPath(boardDir: string, runId: string): string {
  return path.join(dirOf(boardDir), `${runId}.json`);
}

function writeRun(boardDir: string, run: CanaryRun): void {
  mkdirSync(dirOf(boardDir), { recursive: true });
  const target = runPath(boardDir, run.runId);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(run, null, 2) + '\n', 'utf-8');
  renameSync(tmp, target);
}

/** Every run record, oldest first. */
export function listCanaryRuns(boardDir: string): CanaryRun[] {
  const dir = dirOf(boardDir);
  if (!existsSync(dir)) return [];
  const out: CanaryRun[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!/^run-\d+\.json$/.test(f)) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as CanaryRun);
    } catch {
      /* an unreadable record contributes nothing */
    }
  }
  return out;
}

/** The run still in flight, if any. */
export function runningCanary(boardDir: string): CanaryRun | undefined {
  return listCanaryRuns(boardDir).find((r) => r.status === 'running');
}

/** Ask for a run on the next tick (`up` calls this). */
export function markCanaryDue(boardDir: string): void {
  mkdirSync(dirOf(boardDir), { recursive: true });
  writeFileSync(path.join(dirOf(boardDir), DUE_FILE), '', 'utf-8');
}

/** True when no run is in flight and one was asked for, never ran, or last ran over an interval ago. */
export function canaryDue(boardDir: string, now: Date, intervalMs = CANARY_INTERVAL_MS): boolean {
  if (runningCanary(boardDir)) return false;
  if (existsSync(path.join(dirOf(boardDir), DUE_FILE))) return true;
  const last = listCanaryRuns(boardDir).at(-1);
  if (!last) return true;
  return now.getTime() - Date.parse(last.startedAt) >= intervalMs;
}

/** The clear stamp of an executor: written when it is cleared or downed after a verdict. */
export function clearStampPath(boardDir: string, executor: string): string {
  return path.join(dirOf(boardDir), 'cleared', `${executor}.json`);
}

/** Record that `executor` was cleared (or downed) at `at`. Never throws: it must not stop a tick. */
export function writeClearStamp(boardDir: string, executor: string, at: Date): void {
  try {
    const file = clearStampPath(boardDir, executor);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ executor, at: at.toISOString() }) + '\n', 'utf-8');
  } catch {
    /* best effort */
  }
}

/** Inputs of {@link startCanaryRun}. */
export interface StartDeps {
  boardDir: string;
  /** Repo root: the synthetic task files are written under the board, addressed relative to it. */
  workDir: string;
  baseSha: string;
  dispatchedBy: string;
  now: () => Date;
}

function taskMarkdown(id: string, role: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: hierarchy loop canary ${role}`,
    'status: To Do',
    '---',
    '',
    `Synthetic docs-only task of the hierarchy loop canary (${role}). Do not develop it:`,
    'report a `success` verdict with the note "canary" and stop; no worktree, no pull request.',
    '',
  ].join('\n');
}

/** Enqueue the two synthetic tasks and write the run record. Refuses while a run is in flight. */
export function startCanaryRun(deps: StartDeps): CanaryRun {
  if (runningCanary(deps.boardDir)) throw new Error('a canary run is already in flight');
  const at = deps.now();
  let n = Math.floor(at.getTime() / 1000);
  while (
    isOnBoard(deps.boardDir, `${CANARY_TASK_PREFIX}${n}`) ||
    isOnBoard(deps.boardDir, `${CANARY_TASK_PREFIX}${n + 1}`)
  )
    n += 2;
  const taskId = `${CANARY_TASK_PREFIX}${n}`;
  const followTaskId = `${CANARY_TASK_PREFIX}${n + 1}`;
  const tasksDir = path.join(dirOf(deps.boardDir), 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const rel = new Map<string, string>();
  for (const [id, role] of [
    [taskId, 'probe'],
    [followTaskId, 're-claim probe'],
  ] as const) {
    const file = path.join(tasksDir, `${id.toLowerCase()} - hierarchy loop canary.md`);
    writeFileSync(file, taskMarkdown(id, role), 'utf-8');
    rel.set(id, path.relative(deps.workDir, file));
  }
  enqueueTasks(deps.boardDir, [{ taskId }, { taskId: followTaskId, after: [] }], {
    baseSha: deps.baseSha,
    dispatchedBy: deps.dispatchedBy,
    resolveTaskFile: (id) => rel.get(id),
    workDir: deps.workDir,
    now: deps.now,
  });
  rmSync(path.join(dirOf(deps.boardDir), DUE_FILE), { force: true });
  const run: CanaryRun = {
    runId: `run-${n}`,
    taskId,
    followTaskId,
    startedAt: at.toISOString(),
    status: 'running',
    stages: {},
  };
  writeRun(deps.boardDir, run);
  return run;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Whether the dispatch tick has recorded the verdict (`state.handled`). */
function verdictHandled(boardDir: string, taskId: string): boolean {
  const state = readJson(path.join(boardDir, 'operator-dispatch.state.json'));
  const handled = Array.isArray(state?.handled) ? (state.handled as unknown[]) : [];
  return handled.some((k) => typeof k === 'string' && k.includes(`:${taskId}:`));
}

function claimed(boardDir: string, taskId: string): boolean {
  const s = boardStateOf(boardDir, taskId);
  return s !== undefined && s !== 'queue' && s !== 'blocked';
}

/** Result of one {@link advanceCanaryRun}. */
export interface AdvanceResult {
  run: CanaryRun;
  /** Set once, on the call that ended the run. */
  finished?: 'pass' | 'fail';
  /** Planner message for a failure. */
  message?: string;
}

/**
 * Observe the board and move the run forward: record every stage now reached, then end the run
 * as `pass` (all five seen) or `fail` (the first unseen stage is past its deadline, or the probe
 * failed). Held boards are the caller's business: this never starts or fails a run for them.
 */
export function advanceCanaryRun(
  boardDir: string,
  run: CanaryRun,
  now: Date,
  deadlines: Record<CanaryStage, number> = CANARY_DEFAULT_DEADLINES_MS,
): AdvanceResult {
  if (run.status !== 'running') return { run };
  const stamp = now.toISOString();
  const verdictFile = path.join(boardDir, 'done', `${run.taskId}.verdict.json`);
  const failedVerdict = ['.verdict.json', '.diagnostic.json'].some((s) =>
    existsSync(path.join(boardDir, 'failed', `${run.taskId}${s}`)),
  );
  const verdict = readJson(verdictFile);
  const inflight = readInflightManifest(boardDir, run.taskId);
  const seen: Record<CanaryStage, () => boolean> = {
    claimed: () => claimed(boardDir, run.taskId),
    developed: () => verdict !== undefined,
    verdictRecorded: () => verdictHandled(boardDir, run.taskId),
    executorCleared: () => {
      const executor = run.executor ?? String(verdict?.workerId ?? inflight?.workerId ?? '');
      if (!executor) return false;
      const s = readJson(clearStampPath(boardDir, executor));
      const at = Date.parse(String(s?.at ?? ''));
      const done = Date.parse(String(verdict?.completedAt ?? ''));
      return Number.isFinite(at) && Number.isFinite(done) && at >= done;
    },
    reclaimed: () => claimed(boardDir, run.followTaskId),
  };
  if (typeof verdict?.workerId === 'string') run.executor = verdict.workerId;
  let previous = run.startedAt;
  for (const stage of CANARY_STAGES) {
    if (run.stages[stage] === undefined && seen[stage]()) run.stages[stage] = stamp;
    const reached = run.stages[stage];
    if (reached !== undefined) {
      previous = reached;
      continue;
    }
    let reason: string | undefined;
    if (stage === 'developed' && failedVerdict) {
      reason = `the probe ${run.taskId} reported a failed verdict`;
    } else if (now.getTime() - Date.parse(previous) > deadlines[stage]) {
      reason = `stage ${stage} missed its ${Math.round(deadlines[stage] / MIN)} min deadline`;
    }
    if (reason === undefined) {
      writeRun(boardDir, run);
      return { run };
    }
    run.status = 'fail';
    run.failedStage = stage;
    run.reason = reason;
    run.finishedAt = stamp;
    cleanupQueued(boardDir, run);
    writeRun(boardDir, run);
    return {
      run,
      finished: 'fail',
      message: `hierarchy loop canary FAILED at ${stage} (${run.runId}): ${reason}. Record: ${DIR}/${run.runId}.json`,
    };
  }
  run.status = 'pass';
  run.finishedAt = stamp;
  writeRun(boardDir, run);
  return { run, finished: 'pass' };
}

/** Retire synthetic tasks still queued so a failed run leaves no claimable canary behind. */
function cleanupQueued(boardDir: string, run: CanaryRun): void {
  for (const id of [run.taskId, run.followTaskId]) {
    try {
      if (boardStateOf(boardDir, id) === 'queue') retireQueued(boardDir, id, 'canary run failed');
    } catch {
      /* best effort */
    }
  }
}
