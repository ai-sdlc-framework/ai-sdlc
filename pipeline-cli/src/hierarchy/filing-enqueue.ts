/**
 * Auto-enqueue of a landed filing (AISDLC-1242). A merged `ai-sdlc/file-<id>` PR whose one-task
 * brief exists, whose task file on main is dispatchable and unblocked, and whose task is off the
 * board is enqueued from that brief on the tick, so it does not wait for a planner wake.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isOnBoard } from '../dispatch/board.js';
import type { EnqueueEntry } from '../dispatch/enqueue.js';
import { readDispatchFacts } from './auto-brief.js';
import { parseBrief } from './brief-format.js';
import { briefToEnqueueEntries } from './dispatch-loop.js';
import { FILE_BRANCH_PREFIX } from './filing-branches.js';
import type { CommandRunner } from './types.js';

/** What the enqueue needs from the repository; injected so tests need no git. */
export interface FilingEnqueueDeps {
  /** Raw task file as it is on `origin/main`; undefined when absent. */
  readTaskOnMain: (taskId: string) => string | undefined;
  /** Enqueue the entries on the board (all-or-nothing). */
  enqueue: (entries: EnqueueEntry[]) => void;
}

/** Task id named by a `ai-sdlc/file-<id>` branch, or undefined for any other branch. */
export function filedTaskIdFrom(headBranch: string | undefined): string | undefined {
  if (!headBranch?.startsWith(FILE_BRANCH_PREFIX)) return undefined;
  const id = headBranch.slice(FILE_BRANCH_PREFIX.length).toUpperCase();
  return /^[A-Z][A-Z0-9]*-\d+(?:\.\d+)*$/.test(id) ? id : undefined;
}

/**
 * Enqueue the task a landed filing PR created. Returns the one planner line when it enqueued,
 * undefined when it left the task alone (no brief, not eligible, already on the board, or an
 * enqueue refusal).
 */
export function autoEnqueueFiled(
  boardDir: string,
  pr: number,
  headBranch: string | undefined,
  deps: FilingEnqueueDeps,
): string | undefined {
  const taskId = filedTaskIdFrom(headBranch);
  if (!taskId) return undefined;
  const briefName = `tasks-${taskId.toLowerCase()}.md`;
  const briefPath = path.join(boardDir, 'briefs', briefName);
  if (!existsSync(briefPath)) return undefined;
  try {
    const raw = deps.readTaskOnMain(taskId);
    if (raw === undefined || !readDispatchFacts(raw)?.eligible) return undefined;
    if (isOnBoard(boardDir, taskId)) return undefined;
    const entries = briefToEnqueueEntries(parseBrief(readFileSync(briefPath, 'utf8'))).filter(
      (e) => e.taskId === taskId,
    );
    if (entries.length !== 1) return undefined;
    deps.enqueue(entries);
  } catch {
    return undefined;
  }
  return `auto-enqueued ${taskId} from ${briefName} (filing #${pr} landed)`;
}

/** The task file for `taskId` as it is on `origin/main` (what a landed filing put there). */
export function readTaskOnMain(
  run: CommandRunner,
  cwd: string,
  taskId: string,
): string | undefined {
  const ls = run('git', ['ls-tree', '--name-only', 'origin/main', 'backlog/tasks/'], { cwd });
  if (ls.status !== 0) return undefined;
  const prefix = `backlog/tasks/${taskId} - `.toLowerCase();
  const file = ls.stdout.split('\n').find((l) => l.toLowerCase().startsWith(prefix));
  if (!file) return undefined;
  const show = run('git', ['show', `origin/main:${file}`], { cwd });
  return show.status === 0 ? show.stdout : undefined;
}
