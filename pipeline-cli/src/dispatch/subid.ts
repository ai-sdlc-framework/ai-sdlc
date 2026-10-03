/**
 * Sub-id allocation for follow-up tasks.
 *
 * An executor never files a top-level task id. Follow-ups it discovers are
 * filed as `<task-id>.<n>`; this picks the first `n` that nothing already uses.
 * "Used" means present in any of three places, because a sub-id can exist in
 * one before the others know about it: the backlog (a task file or a task id
 * inside `backlog/`), the dispatch board (a manifest or verdict in any state),
 * and the file lists of open pull requests (a task file added by a PR that has
 * not merged yet).
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { listBoard, TASK_ID_RE } from './board.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every file path under `dir`, relative to `dir`, using `/` separators. */
function listFilesRecursive(dir: string, rel = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), next));
    else out.push(next);
  }
  return out;
}

/** Inputs for {@link nextSubId}. */
export interface NextSubIdInput {
  taskId: string;
  /** Repository root; `backlog/` is scanned beneath it. */
  workDir: string;
  boardDir: string;
  /** File paths touched by open pull requests. */
  openPrFiles: readonly string[];
}

/**
 * The first sub-id of `taskId` that is not in the backlog, on the board or in an
 * open pull request's file list.
 * @throws when `taskId` is not a valid task id.
 */
export function nextSubId(input: NextSubIdInput): string {
  const { taskId } = input;
  if (!TASK_ID_RE.test(taskId)) throw new Error(`'${taskId}' is not a valid task id`);

  const sources: string[] = [];
  sources.push(...listFilesRecursive(path.join(input.workDir, 'backlog')));
  sources.push(...listBoard(input.boardDir).map((e) => e.taskId));
  sources.push(...input.openPrFiles);

  // A sub-sub-id (`<id>.2.1`) shows that `<id>.2` exists, so only the first
  // numeric segment after the prefix counts. The prefix must start a token so
  // that `XAISDLC-5.1` is not read as a sub-id of `AISDLC-5`.
  const pattern = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(taskId)}\\.(\\d+)(?!\\d)`, 'gi');
  const used = new Set<number>();
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) used.add(Number.parseInt(match[1]!, 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${taskId}.${n}`;
}
