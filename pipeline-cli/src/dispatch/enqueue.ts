/**
 * Enqueue tasks onto the Dispatch Board with their ordering fields.
 *
 * `enqueueTasks` builds one manifest per task and writes them to `queue/`.
 * It refuses the whole batch when any task id is already on the board in any
 * state (queued, inflight, blocked, done or failed) or listed twice, so a
 * batch is all-or-nothing. `parseBrief` reads the YAML list a brief carries.
 */

import { load as yamlLoad } from 'js-yaml';

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

function asInt(value: unknown, field: string, id: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`brief entry ${id}: ${field} must be an integer`);
  }
  return value;
}

/**
 * Parse a brief: a YAML list (or `{ tasks: [...] }`) whose items are a task id
 * or a mapping with `task` (or `taskId`), `after`, `group` (or
 * `sequenceGroup`), `priority` and `wave`.
 */
export function parseBrief(yamlText: string): EnqueueEntry[] {
  const doc = yamlLoad(yamlText) as unknown;
  const list =
    doc && typeof doc === 'object' && !Array.isArray(doc)
      ? (doc as { tasks?: unknown }).tasks
      : doc;
  if (!Array.isArray(list)) throw new Error('brief must be a YAML list of tasks');
  return list.map((item: unknown, index: number): EnqueueEntry => {
    if (typeof item === 'string') return { taskId: item };
    if (!item || typeof item !== 'object') {
      throw new Error(`brief entry ${index + 1} must be a task id or a mapping`);
    }
    const rec = item as Record<string, unknown>;
    const taskId = rec['task'] ?? rec['taskId'];
    if (typeof taskId !== 'string') throw new Error(`brief entry ${index + 1} has no task id`);
    const entry: EnqueueEntry = { taskId };
    const after = rec['after'];
    if (after !== undefined) {
      const ids = Array.isArray(after) ? after : [after];
      if (!ids.every((x) => typeof x === 'string')) {
        throw new Error(`brief entry ${taskId}: after must be task ids`);
      }
      entry.after = ids as string[];
    }
    const group = rec['group'] ?? rec['sequenceGroup'];
    if (group !== undefined) {
      if (typeof group !== 'string') throw new Error(`brief entry ${taskId}: group must be text`);
      entry.sequenceGroup = group;
    }
    const priority = asInt(rec['priority'], 'priority', taskId);
    if (priority !== undefined) entry.priority = priority;
    const wave = asInt(rec['wave'], 'wave', taskId);
    if (wave !== undefined) entry.wave = wave;
    return entry;
  });
}
