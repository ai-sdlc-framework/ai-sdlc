/**
 * Backlog file walker — RFC-0023 §6.2 / AISDLC-178.2.
 *
 * Walks `backlog/tasks/` (open) + `backlog/completed/` (closed) every 30s
 * and parses each `.md` file's YAML frontmatter via `js-yaml` (added as
 * a pipeline-cli dep in AISDLC-180). Returns the list of tasks with the
 * fields the TUI panes (Phases 3-6) consume.
 *
 * Per RFC §12 graceful-degradation:
 *  - Missing `backlog/` dir → `data: []` + `error: 'source-unavailable'`.
 *  - Permission errors → `data: []` + `error: 'source-permission-denied'`.
 *  - A file with a malformed `---` frontmatter block → SKIPPED silently;
 *    surrounding files still pass through.
 *  - A file whose YAML throws on parse → SKIPPED silently.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useEffect, useRef, useState } from 'react';
import { load as loadYaml } from 'js-yaml';

import { classifyFsError } from './types.js';
import type { SourceErrorKind, SourceState } from './types.js';

/** Default poll cadence (30s per RFC §6.2). */
export const BACKLOG_WALKER_POLL_INTERVAL_MS = 30_000;

/**
 * The frontmatter shape the TUI cares about. Other fields ride through
 * via `extras` so consumer panes can extract them without forcing the
 * walker to enumerate every conceivable field.
 */
export interface BacklogTask {
  /** Canonical task ID (case preserved from frontmatter). */
  id: string;
  /** Task title — empty string if missing. */
  title: string;
  /** Frontmatter status string (e.g. "To Do", "In Progress", "Done"). */
  status: string;
  /** Frontmatter priority string (e.g. "high", "medium"). */
  priority: string;
  /** Labels array; empty when missing. */
  labels: string[];
  /** Dependency IDs; empty when missing. */
  dependencies: string[];
  /** "open" if file lives under `tasks/`, "completed" if under `completed/`. */
  fileLocation: 'open' | 'completed';
  /** Absolute path of the file on disk. */
  filePath: string;
  /** ISO-8601 mtime of the file (best-effort; '' on stat failure). */
  lastModified: string;
  /** Other frontmatter fields, untyped. */
  extras: Record<string, unknown>;
}

export interface ReadBacklogTasksOpts {
  /** Project root containing `backlog/`. Defaults `process.cwd()`. */
  workDir?: string;
}

export interface ReadBacklogTasksResult {
  tasks: BacklogTask[];
  error: SourceErrorKind | null;
}

const KNOWN_FRONTMATTER_KEYS = new Set([
  'id',
  'title',
  'status',
  'priority',
  'labels',
  'dependencies',
]);

/**
 * Parse a `.md` file's leading `---` YAML block. Returns null when the
 * file lacks frontmatter or YAML parsing throws — caller treats null
 * as "skip silently" per RFC §12.
 */
export function parseTaskFrontmatter(raw: string): Record<string, unknown> | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  let parsed: unknown;
  try {
    parsed = loadYaml(fmMatch[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function buildTask(
  fm: Record<string, unknown>,
  filePath: string,
  fileLocation: 'open' | 'completed',
): BacklogTask | null {
  const id = coerceString(fm.id).trim();
  if (!id) return null; // No id — useless to a pane keyed on task IDs.

  let lastModified = '';
  try {
    lastModified = statSync(filePath).mtime.toISOString();
  } catch {
    // best-effort
  }

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(k)) extras[k] = v;
  }

  return {
    id,
    title: coerceString(fm.title),
    status: coerceString(fm.status),
    priority: coerceString(fm.priority),
    labels: coerceStringArray(fm.labels),
    dependencies: coerceStringArray(fm.dependencies),
    fileLocation,
    filePath,
    lastModified,
    extras,
  };
}

function walkDir(dir: string, location: 'open' | 'completed'): BacklogTask[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Caller (`readBacklogTasks`) handles the top-level missing-backlog/
    // case; this branch fires when a sub-dir disappeared mid-walk. Empty
    // is the right answer.
    return [];
  }
  const tasks: BacklogTask[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const fm = parseTaskFrontmatter(raw);
    if (!fm) continue;
    const task = buildTask(fm, filePath, location);
    if (task) tasks.push(task);
  }
  return tasks;
}

/**
 * Pure walker — reads both backlog dirs + parses every `.md`. Exported
 * for tests so they don't need a React render tree.
 *
 * Returns the merged task list (open + completed) sorted by `id` using
 * a numeric-aware locale sort so AISDLC-9 sorts before AISDLC-100.
 */
export function readBacklogTasks(opts: ReadBacklogTasksOpts = {}): ReadBacklogTasksResult {
  const workDir = opts.workDir ?? process.cwd();
  const backlogDir = join(workDir, 'backlog');
  const tasksDir = join(backlogDir, 'tasks');
  const completedDir = join(backlogDir, 'completed');

  // Top-level signal: if `backlog/` itself doesn't exist, the source is
  // unavailable. A missing sub-dir (e.g. only `tasks/` exists) is normal
  // for projects pre-first-completion.
  try {
    statSync(backlogDir);
  } catch (err) {
    return { tasks: [], error: classifyFsError(err) };
  }

  const open = walkDir(tasksDir, 'open');
  const completed = walkDir(completedDir, 'completed');
  const merged = [...open, ...completed].sort((a, b) =>
    a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  return { tasks: merged, error: null };
}

export interface UseBacklogTasksOpts extends ReadBacklogTasksOpts {
  /** Polling cadence in ms. Defaults `BACKLOG_WALKER_POLL_INTERVAL_MS` (30s). */
  intervalMs?: number;
  /** Inject walker (tests). Defaults `readBacklogTasks`. */
  walker?: (opts: ReadBacklogTasksOpts) => ReadBacklogTasksResult;
  /** Inject clock for `lastFetched`. Defaults `() => new Date()`. */
  clock?: () => Date;
}

/**
 * React hook — walks `backlog/tasks/` + `backlog/completed/` every 30s.
 *
 * Returns `{data, error, lastFetched}`:
 *  - `data` is the merged sorted task list.
 *  - `error` is null on success; sentinel when the top-level `backlog/`
 *    dir is missing or unreadable.
 *  - `lastFetched` updates on every refresh (success OR error).
 */
export function useBacklogTasks(opts: UseBacklogTasksOpts = {}): SourceState<BacklogTask[]> {
  const intervalMs = opts.intervalMs ?? BACKLOG_WALKER_POLL_INTERVAL_MS;
  const walker = opts.walker ?? readBacklogTasks;
  const clock = opts.clock ?? ((): Date => new Date());

  const walkerRef = useRef(walker);
  walkerRef.current = walker;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const optsRef = useRef<ReadBacklogTasksOpts>(opts);
  optsRef.current = opts;

  const [state, setState] = useState<SourceState<BacklogTask[]>>({
    data: [],
    error: null,
    lastFetched: null,
  });

  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      const result = walkerRef.current(optsRef.current);
      if (cancelled) return;
      setState({
        data: result.tasks,
        error: result.error,
        lastFetched: clockRef.current(),
      });
    };
    tick();
    const handle = setInterval(tick, intervalMs);
    return (): void => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [intervalMs]);

  return state;
}
