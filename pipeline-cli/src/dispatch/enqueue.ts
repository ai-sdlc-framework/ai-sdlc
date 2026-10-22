/**
 * Enqueue tasks onto the Dispatch Board with their ordering fields.
 *
 * `enqueueTasks` builds one manifest per task and writes them to `queue/`.
 * It refuses the whole batch when any task id is already on the board in any
 * state (queued, inflight, blocked, done or failed) or listed twice, so a
 * batch is all-or-nothing. The brief format itself lives in `hierarchy/brief-format.ts`.
 */

import path from 'node:path';
import { parseTaskFrontmatter } from '../deps/dependency-graph.js';
import { parseTaskFile } from '../steps/01-validate.js';
import { buildBranchName, DEFAULT_PATTERN, readBranchPattern } from '../steps/02-compute-branch.js';
import { isOnBoard, TASK_ID_RE, writeManifest } from './board.js';
import type { DispatchManifest, ManifestWorkerKind } from './types.js';

/** One task to enqueue and its ordering fields. */
export interface EnqueueEntry {
  taskId: string;
  after?: string[];
  sequenceGroup?: string;
  priority?: number;
  wave?: number;
}

/** Values shared by every manifest in a batch. */
export interface EnqueueDefaults {
  baseSha: string;
  dispatchedBy: string;
  workerKind?: ManifestWorkerKind;
  verifyCommands?: string[];
  /** Resolves the repo-relative backlog task file for an id; undefined when none exists. */
  resolveTaskFile: (taskId: string) => string | undefined;
  now?: () => Date;
  /** Repo root; with it the branch uses the configured pattern and the task's frontmatter title. */
  workDir?: string;
}

/** The branch Step 2 will compute for this task (AISDLC-851): one builder, so they agree. */
function branchFor(id: string, taskFile: string, workDir: string | undefined): string {
  let title = '';
  let pattern = DEFAULT_PATTERN;
  if (workDir) {
    try {
      title = parseTaskFile(path.join(workDir, taskFile)).title;
    } catch {
      // fall through to the file name
    }
    pattern = readBranchPattern(workDir, DEFAULT_PATTERN);
  }
  if (!title) {
    title = path.posix.basename(taskFile, '.md').replace(/^[^ ]+ - /, '');
  }
  return buildBranchName(pattern, id, title).branch;
}

/**
 * The `dependencies:` of a task file that are valid task ids (AISDLC-1027). The queue carries
 * them as `after` so the board never offers a claim the executor preflight will refuse.
 */
export function dependenciesOfTaskFile(workDir: string | undefined, taskFile: string): string[] {
  if (!workDir) return [];
  try {
    const node = parseTaskFrontmatter(path.join(workDir, taskFile), 'open');
    return (node?.dependencies ?? []).map((d) => d.toUpperCase()).filter((d) => TASK_ID_RE.test(d));
  } catch {
    return [];
  }
}

/** Default verification commands copied onto each manifest. */
export const DEFAULT_VERIFY_COMMANDS = [
  'pnpm build',
  'pnpm test',
  'pnpm lint',
  'pnpm format:check',
];

/**
 * Write one manifest per entry into `queue/`. Returns the written paths.
 *
 * @throws when an id is malformed, duplicated in the batch, already on the
 *   board, or has no backlog task file. Nothing is written in that case.
 */
export function enqueueTasks(
  boardDir: string,
  entries: readonly EnqueueEntry[],
  defaults: EnqueueDefaults,
): string[] {
  const seen = new Set<string>();
  const manifests: DispatchManifest[] = [];
  const dispatchedAt = (defaults.now ?? (() => new Date()))().toISOString();
  for (const entry of entries) {
    const id = entry.taskId;
    if (!TASK_ID_RE.test(id)) throw new Error(`'${id}' is not a valid task id`);
    if (seen.has(id)) throw new Error(`task ${id} is listed more than once`);
    seen.add(id);
    if (isOnBoard(boardDir, id)) throw new Error(`task ${id} is already on the board`);
    const taskFile = defaults.resolveTaskFile(id);
    if (!taskFile) throw new Error(`no backlog task file found for ${id}`);
    for (const dep of entry.after ?? []) {
      if (!TASK_ID_RE.test(dep))
        throw new Error(`'${dep}' (after, for ${id}) is not a valid task id`);
    }
    const lower = id.toLowerCase();
    const manifest: DispatchManifest = {
      schemaVersion: 'v1',
      taskId: id,
      branch: branchFor(id, taskFile, defaults.workDir),
      worktree: `.worktrees/${lower}`,
      baseSha: defaults.baseSha,
      workerKind: defaults.workerKind ?? 'any',
      dispatchedAt,
      dispatchedBy: defaults.dispatchedBy,
      spec: { taskFile, verifyCommands: defaults.verifyCommands ?? DEFAULT_VERIFY_COMMANDS },
    };
    const after =
      entry.after && entry.after.length > 0
        ? entry.after
        : dependenciesOfTaskFile(defaults.workDir, taskFile);
    if (after.length > 0) manifest.after = [...after];
    if (entry.sequenceGroup) manifest.sequenceGroup = entry.sequenceGroup;
    if (entry.priority !== undefined) manifest.priority = entry.priority;
    if (entry.wave !== undefined) manifest.wave = entry.wave;
    manifests.push(manifest);
  }
  return manifests.map((m) => writeManifest(boardDir, m));
}
