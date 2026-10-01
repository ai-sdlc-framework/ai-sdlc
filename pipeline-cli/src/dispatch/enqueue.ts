/**
 * Enqueue tasks onto the Dispatch Board with their ordering fields.
 *
 * `enqueueTasks` builds one manifest per task and writes them to `queue/`.
 * It refuses the whole batch when any task id is already on the board in any
 * state (queued, inflight, blocked, done or failed) or listed twice, so a
 * batch is all-or-nothing. The brief format itself lives in `hierarchy/brief-format.ts`.
 */

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
      branch: `ai-sdlc/${lower}`,
      worktree: `.worktrees/${lower}`,
      baseSha: defaults.baseSha,
      workerKind: defaults.workerKind ?? 'any',
      dispatchedAt,
      dispatchedBy: defaults.dispatchedBy,
      spec: { taskFile, verifyCommands: defaults.verifyCommands ?? DEFAULT_VERIFY_COMMANDS },
    };
    if (entry.after && entry.after.length > 0) manifest.after = [...entry.after];
    if (entry.sequenceGroup) manifest.sequenceGroup = entry.sequenceGroup;
    if (entry.priority !== undefined) manifest.priority = entry.priority;
    if (entry.wave !== undefined) manifest.wave = entry.wave;
    manifests.push(manifest);
  }
  return manifests.map((m) => writeManifest(boardDir, m));
}
