/**
 * Resume a finished task with feedback (AISDLC-738).
 *
 * A task whose verdict is in `done/` may need another round (a coverage
 * shortfall, a stale attestation after a rebase, reviewer findings). Without a
 * path back, the only options were a duplicate pull request or a failed Step 3.
 * `resumeDone` returns the task to `queue/` with a feedback note on its
 * manifest; the next claim hands the note to the executor, and the pipeline
 * re-enters the task's existing worktree and branch instead of creating new ones.
 *
 * `completeTask` keeps a copy of the manifest next to a success verdict
 * (`snapshotDoneManifest`) so the branch, worktree and ordering survive; a task
 * finished before that existed gets a manifest rebuilt from the verdict.
 * `resumeDone` checks everything before it writes anything.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { now } from '../clock.js';
import { ensureBoardDirs, readInflightManifest, TASK_ID_RE, writeManifest } from './board.js';
import { DEFAULT_VERIFY_COMMANDS } from './enqueue.js';
import type { DispatchManifest, DispatchVerdict, ResumeFeedback } from './types.js';
import { oneLine } from './verdict-fields.js';

/** Filename suffix of the manifest copy kept in `done/`. */
export const DONE_MANIFEST_SUFFIX = '.manifest.json';
const MAX_NOTE_CHARS = 4000;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_CHARS = 200;

function assertId(taskId: string): void {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new Error(`'${String(taskId)}' is not a valid task id`);
  }
}

/** Keep a copy of a finished task's manifest in `done/` so it can be resumed. */
export function snapshotDoneManifest(boardDir: string, manifest: DispatchManifest): string {
  assertId(manifest.taskId);
  ensureBoardDirs(boardDir);
  const target = path.join(boardDir, 'done', `${manifest.taskId}${DONE_MANIFEST_SUFFIX}`);
  const tmp = `${target}.tmp-${process.pid}-${now().getTime()}`;
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}

/** What the caller supplies when resuming a task. */
export interface ResumeInput {
  note: string;
  prNumber?: number;
  failingChecks?: readonly string[];
  findings?: readonly string[];
}

/** Collaborators of {@link resumeDone}. */
export interface ResumeDoneOptions {
  /** Who resumes the task (audit only). */
  resumedBy: string;
  now?: () => Date;
  /** Used to rebuild a manifest when none was kept; the repo-relative task file, or undefined. */
  resolveTaskFile?: (taskId: string) => string | undefined;
  /** Used only with `resolveTaskFile`, to rebuild the base commit. */
  resolveBaseSha?: () => string | undefined;
}

/** Result of a successful resume. */
export interface ResumeResult {
  taskId: string;
  queuePath: string;
  resume: ResumeFeedback;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function cleanList(label: string, items: readonly string[] | undefined): string[] | undefined {
  if (!items || items.length === 0) return undefined;
  if (items.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} may have at most ${MAX_LIST_ITEMS} entries`);
  }
  const out = items.map((i) => oneLine(i, MAX_ITEM_CHARS)).filter((i) => i.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Send a finished task back to `queue/` with feedback.
 * @throws, writing nothing, when the id is malformed, the note is empty or too
 *   long, the task has no success verdict in `done/`, it is already queued,
 *   inflight, blocked or failed, or no manifest can be rebuilt.
 */
export function resumeDone(
  boardDir: string,
  taskId: string,
  input: ResumeInput,
  opts: ResumeDoneOptions,
): ResumeResult {
  assertId(taskId);
  const note = input.note.replace(/\r\n/g, '\n').trim();
  if (note.length === 0) throw new Error('a resume needs a feedback note');
  if (note.length > MAX_NOTE_CHARS) {
    throw new Error(`the feedback note may have at most ${MAX_NOTE_CHARS} characters`);
  }
  if (
    input.prNumber !== undefined &&
    (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1)
  ) {
    throw new Error('the pull request number must be a positive integer');
  }
  const failingChecks = cleanList('failing checks', input.failingChecks);
  const findings = cleanList('findings', input.findings);

  const doneDir = path.join(boardDir, 'done');
  const verdictFile = path.join(doneDir, `${taskId}.verdict.json`);
  const markerFile = path.join(doneDir, `${taskId}.completed.json`);
  const verdict = existsSync(verdictFile) ? readJson<DispatchVerdict>(verdictFile) : undefined;
  const marker = existsSync(markerFile)
    ? readJson<{ completedAt?: string }>(markerFile)
    : undefined;
  if (!verdict && !marker) {
    throw new Error(`${taskId} is not in done/; only a finished task can be resumed`);
  }
  if (verdict && verdict.outcome !== 'success') {
    throw new Error(`${taskId} is in done/ with outcome '${verdict.outcome}'; it is still running`);
  }
  for (const sub of ['queue', 'inflight', 'blocked'] as const) {
    if (existsSync(path.join(boardDir, sub, `${taskId}.dispatch.json`))) {
      throw new Error(`${taskId} is already in ${sub}/`);
    }
  }
  for (const f of ['verdict', 'diagnostic']) {
    if (existsSync(path.join(boardDir, 'failed', `${taskId}.${f}.json`))) {
      throw new Error(`${taskId} is in failed/; use requeue instead`);
    }
  }

  const snapshotFile = path.join(doneDir, `${taskId}${DONE_MANIFEST_SUFFIX}`);
  const saved = existsSync(snapshotFile) ? readJson<DispatchManifest>(snapshotFile) : undefined;
  let base: DispatchManifest;
  if (saved && saved.taskId === taskId) {
    base = saved;
  } else {
    const taskFile = opts.resolveTaskFile?.(taskId);
    const baseSha = taskFile ? opts.resolveBaseSha?.() : undefined;
    if (!taskFile || !baseSha) {
      throw new Error(
        `${taskId} has no saved manifest in done/ and none can be rebuilt (no backlog task file or base commit)`,
      );
    }
    const lower = taskId.toLowerCase();
    base = {
      schemaVersion: 'v1',
      taskId,
      branch: verdict?.pushedBranch || `ai-sdlc/${lower}`,
      worktree: `.worktrees/${lower}`,
      baseSha,
      workerKind: 'any',
      dispatchedAt: (opts.now ?? now)().toISOString(),
      dispatchedBy: opts.resumedBy,
      spec: { taskFile, verifyCommands: DEFAULT_VERIFY_COMMANDS },
    };
  }

  const prNumber = input.prNumber ?? verdict?.prNumber;
  const resume: ResumeFeedback = {
    note,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(failingChecks ? { failingChecks } : {}),
    ...(findings ? { findings } : {}),
    resumedAt: (opts.now ?? now)().toISOString(),
    resumedBy: oneLine(opts.resumedBy, 80) || 'dispatch',
    ...(verdict ? { priorOutcome: verdict.outcome } : {}),
  };
  const next: DispatchManifest = { ...base, resume };
  delete next.workerId;
  delete next.blockedBy;
  delete next.noClaimBefore;
  const queuePath = writeManifest(boardDir, next);
  // The task is no longer finished: dependents wait for the next success.
  for (const f of [verdictFile, markerFile, snapshotFile]) rmSync(f, { force: true });
  return { taskId, queuePath, resume };
}

/** The text the executor prints and the developer prompt carries. */
export function formatResumeFeedback(resume: ResumeFeedback): string {
  const lines = [
    `This task was finished earlier and is being resumed for another round (by ${resume.resumedBy}).`,
    resume.prNumber !== undefined
      ? `Update the existing pull request #${resume.prNumber}; do not open a new one.`
      : 'Update the existing branch; do not create a new one.',
    '',
    resume.note,
  ];
  if (resume.failingChecks && resume.failingChecks.length > 0) {
    lines.push('', 'Failing checks:', ...resume.failingChecks.map((c) => `- ${c}`));
  }
  if (resume.findings && resume.findings.length > 0) {
    lines.push('', 'Reviewer findings:', ...resume.findings.map((f) => `- ${f}`));
  }
  return lines.join('\n');
}

/** The feedback on the claimed (inflight) or queued manifest of a task, if any. */
export function readResumeFeedback(boardDir: string, taskId: string): ResumeFeedback | undefined {
  if (!TASK_ID_RE.test(taskId)) return undefined;
  const inflight = readInflightManifest(boardDir, taskId);
  if (inflight?.resume) return inflight.resume;
  return undefined;
}
