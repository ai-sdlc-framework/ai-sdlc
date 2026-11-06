/**
 * Task-file reading and task-class derivation (RFC-0062 OQ-3, DEC-0387).
 *
 * A task's class comes from, in order: the frontmatter `class:` field, its
 * labels, then the code areas it references. Reads frontmatter only.
 *
 * @module labels/task-file
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_CLASSES, type TaskClass } from '../estimation/types.js';

export interface TaskFrontmatter {
  id?: string;
  status?: string;
  priority?: string;
  createdDate?: string;
  labels: string[];
  references: string[];
  class?: TaskClass;
  blocked: boolean;
}

const BUG_LABELS = new Set(['bug', 'fix', 'framework-bug', 'root-cause', 'regression']);
const CHORE_LABELS = new Set(['chore', 'docs', 'ci', 'refactor', 'cleanup', 'deps', 'follow-up']);
const FEATURE_LABELS = new Set(['feature', 'enhancement']);

/** The frontmatter block of a task file, or undefined. */
function block(rawBody: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rawBody);
  return m?.[1];
}

function scalar(fm: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  const v = m?.[1].trim().replace(/^['"]|['"]$/g, '');
  return v ? v : undefined;
}

function list(fm: string, key: string): string[] {
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) return [];
  const inline = /^[^:]+:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (inline) {
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (!m) break;
    out.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

export function parseTaskFrontmatter(rawBody: string | undefined): TaskFrontmatter | undefined {
  if (!rawBody) return undefined;
  const fm = block(rawBody);
  if (fm === undefined) return undefined;
  const cls = scalar(fm, 'class')?.toLowerCase();
  const blocked = /^blocked:/m.test(fm);
  return {
    id: scalar(fm, 'id'),
    status: scalar(fm, 'status'),
    priority: scalar(fm, 'priority')?.toLowerCase(),
    createdDate: scalar(fm, 'created_date'),
    labels: list(fm, 'labels'),
    references: list(fm, 'references'),
    ...(cls && (TASK_CLASSES as readonly string[]).includes(cls)
      ? { class: cls as TaskClass }
      : {}),
    blocked,
  };
}

function isDocPath(p: string): boolean {
  return /\.mdx?$/i.test(p) || /^(docs|spec|backlog)\//.test(p);
}

/**
 * Why a task could not be classified, or the class. `uncategorized` carries a
 * reason string so the backfill can report it.
 */
export function deriveTaskClass(fm: TaskFrontmatter | undefined): {
  taskClass: TaskClass;
  reason?: string;
} {
  if (!fm) return { taskClass: 'uncategorized', reason: 'no frontmatter' };
  if (fm.class && fm.class !== 'uncategorized') return { taskClass: fm.class };
  const labels = fm.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => BUG_LABELS.has(l))) return { taskClass: 'bug' };
  if (labels.some((l) => FEATURE_LABELS.has(l))) return { taskClass: 'feature' };
  if (labels.some((l) => CHORE_LABELS.has(l))) return { taskClass: 'chore' };
  if (fm.references.length > 0) {
    return { taskClass: fm.references.every(isDocPath) ? 'chore' : 'feature' };
  }
  return {
    taskClass: 'uncategorized',
    reason:
      fm.labels.length > 0
        ? 'labels carry no class and no code-area references'
        : 'no labels or references',
  };
}

/** The task file for an id, in `backlog/tasks` or `backlog/completed`. */
export function findTaskFile(repoRoot: string, taskId: string): string | undefined {
  const prefix = `${taskId.toLowerCase()} `;
  for (const sub of ['tasks', 'completed']) {
    const dir = join(repoRoot, 'backlog', sub);
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const f = files.find((n) => n.toLowerCase().startsWith(prefix) && n.endsWith('.md'));
    if (f) return join(dir, f);
  }
  return undefined;
}

export function readTaskFrontmatter(repoRoot: string, taskId: string) {
  const file = findTaskFile(repoRoot, taskId);
  if (!file) return { file: undefined, fm: undefined };
  try {
    return { file, fm: parseTaskFrontmatter(readFileSync(file, 'utf8')) };
  } catch {
    return { file, fm: undefined };
  }
}
