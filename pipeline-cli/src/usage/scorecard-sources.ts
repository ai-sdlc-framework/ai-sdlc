/**
 * File readers and the evidence writer for the scorecard (RFC-0050 B1).
 *
 * Everything here reads ids, classes, sizes, verdict counts and model names.
 * No prompt, response or file content is read or written.
 *
 * @module usage/scorecard-sources
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_CLASSES, type TaskClass } from '../estimation/types.js';
import { readRecentEvents } from '../orchestrator/events.js';
import {
  assignmentKey,
  type AssignmentEntry,
  type Scorecard,
  type ScorecardRow,
  type TaskInfo,
} from './scorecard.js';

/**
 * Default location of the assignment log, relative to the artifacts directory.
 *
 * Assumed shape (one JSON object per line): `{ taskId, role, taskClass?, arm?,
 * model, reason? }`. An entry is an exploration when `arm` or `reason` is
 * `explore`. The first entry for a task and role wins, because a task keeps
 * the arm it started with. If the writer settles on a different path or
 * shape, change only this reader.
 */
export const ASSIGNMENT_LOG_RELATIVE = join('_routing', 'assignments.jsonl');

function parseLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // A damaged line must not lose the rest of the log.
      }
    }
  } catch {
    return [];
  }
  return out;
}

/** Read the assignment log. A missing or unreadable file yields an empty map. */
export function readAssignmentLog(path: string): Map<string, AssignmentEntry> {
  const out = new Map<string, AssignmentEntry>();
  for (const raw of parseLines(path)) {
    const e = raw as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') continue;
    if (typeof e.taskId !== 'string' || typeof e.role !== 'string' || typeof e.model !== 'string') {
      continue;
    }
    const key = assignmentKey(e.taskId, e.role);
    if (out.has(key)) continue;
    out.set(key, { model: e.model, explore: e.arm === 'explore' || e.reason === 'explore' });
  }
  return out;
}

function isTaskClass(v: unknown): v is TaskClass {
  return typeof v === 'string' && (TASK_CLASSES as readonly string[]).includes(v);
}

/** Frontmatter `class:` for a task, read from the frontmatter block only. */
function frontmatterClass(repoRoot: string, taskId: string): TaskClass | undefined {
  const dir = join(repoRoot, 'backlog', 'tasks');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const prefix = `${taskId.toLowerCase()} `;
  const file = files.find((f) => f.toLowerCase().startsWith(prefix) && f.endsWith('.md'));
  if (!file) return undefined;
  try {
    const text = readFileSync(join(dir, file), 'utf8');
    if (!text.startsWith('---')) return undefined;
    const end = text.indexOf('\n---', 3);
    const block = end === -1 ? '' : text.slice(0, end);
    const m = /^class:\s*['"]?([A-Za-z]+)['"]?\s*$/m.exec(block);
    const v = m?.[1].toLowerCase();
    return isTaskClass(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Task class and size per task: frontmatter class first, then the latest
 * recorded estimate, else `uncategorized`.
 */
export function loadTaskInfo(
  taskIds: Iterable<string>,
  opts: { repoRoot: string; artifactsDir: string },
): Map<string, TaskInfo> {
  const estimates = new Map<string, { cls?: TaskClass; size?: string }>();
  for (const raw of parseLines(join(opts.artifactsDir, '_estimates', 'log.jsonl'))) {
    const e = raw as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || typeof e.taskId !== 'string') continue;
    estimates.set(e.taskId, {
      ...(isTaskClass(e.class) ? { cls: e.class } : {}),
      ...(typeof e.finalBucket === 'string' ? { size: e.finalBucket } : {}),
    });
  }
  const out = new Map<string, TaskInfo>();
  for (const id of taskIds) {
    const est = estimates.get(id);
    const taskClass = frontmatterClass(opts.repoRoot, id) ?? est?.cls ?? 'uncategorized';
    out.set(id, { taskClass, ...(est?.size ? { size: est.size } : {}) });
  }
  return out;
}

/** Developer contract retries per task from orchestrator events. */
export function loadContractRetries(artifactsDir: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of readRecentEvents({ artifactsDir, limit: 1_000_000 })) {
    if (e.type !== 'DeveloperContractRetry' || !e.taskId) continue;
    out.set(e.taskId, (out.get(e.taskId) ?? 0) + 1);
  }
  return out;
}

function fileSafe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
}

export interface EvidenceMeta {
  repo: string;
  generatedAt: string;
}

/** Evidence file name for a cell. */
export function evidenceFileName(row: Pick<ScorecardRow, 'role' | 'model' | 'taskClass'>): string {
  return `${fileSafe(row.role)}.${fileSafe(row.taskClass)}.${fileSafe(row.model)}.json`;
}

/**
 * Write one JSON file per cell. The caller passes a scorecard built from
 * framework-scope data of `meta.repo` only, so the files hold nothing else.
 * Returns the written paths.
 */
export function writeEvidenceFiles(dir: string, card: Scorecard, meta: EvidenceMeta): string[] {
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const row of card.rows) {
    const { taskDetails, ...summary } = row;
    const path = join(dir, evidenceFileName(row));
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 'v1',
          scope: 'framework',
          repo: meta.repo,
          generatedAt: meta.generatedAt,
          minTasks: card.minTasks,
          cell: { role: row.role, model: row.model, taskClass: row.taskClass },
          row: summary,
          tasks: taskDetails,
        },
        null,
        2,
      )}\n`,
    );
    paths.push(path);
  }
  return paths;
}
