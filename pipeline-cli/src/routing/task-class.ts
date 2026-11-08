import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { deriveTaskClass, parseTaskFrontmatter } from '../labels/task-file.js';

/**
 * The task class for a task file: frontmatter `class:`, else its labels, else
 * the code areas it references (RFC-0062 OQ-3); 'uncategorized' only when none
 * of those exist.
 */
export function taskClassOf(rawBody: string | undefined): string {
  return deriveTaskClass(parseTaskFrontmatter(rawBody)).taskClass;
}

export interface BaseRefTaskClassOptions {
  /** Defaults to `origin/main`. */
  baseRef?: string;
  /** Test injection: returns the task file text at the base ref, or null when absent. */
  readBaseTask?: (filePath: string, baseRef: string) => string | null;
  /** Receives the reason when the class falls back to 'uncategorized'. */
  log?: (message: string) => void;
}

/** Read a task file as committed on `baseRef`; null on any failure (absent, not a repo). */
export function readTaskFromBaseRef(filePath: string, baseRef: string): string | null {
  try {
    const cwd = dirname(resolve(filePath));
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const rel = relative(realpathSync(top), realpathSync(resolve(filePath)))
      .split(sep)
      .join('/');
    return execFileSync('git', ['show', `${baseRef}:${rel}`], {
      cwd: top,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The task class as committed on the BASE ref, never the worktree copy: the
 * developer agent can edit its own task file, so a worktree `class:` must not
 * pick its routing cell (AISDLC-654.1). A task file absent from the base ref
 * resolves to 'uncategorized' and the reason is logged. Trust model matches
 * `load-table.ts`: the local `origin/main` ref, no network check.
 */
export function taskClassFromBaseRef(
  task: { filePath?: string } | undefined,
  opts: BaseRefTaskClassOptions = {},
): string {
  const baseRef = opts.baseRef ?? 'origin/main';
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  if (!task?.filePath) {
    log(`task class: no task file path; using uncategorized`);
    return 'uncategorized';
  }
  const read = opts.readBaseTask ?? readTaskFromBaseRef;
  let raw: string | null;
  try {
    raw = read(task.filePath, baseRef);
  } catch {
    raw = null;
  }
  if (raw === null) {
    log(`task class: ${task.filePath} absent from ${baseRef}; using uncategorized`);
    return 'uncategorized';
  }
  return taskClassOf(raw);
}
