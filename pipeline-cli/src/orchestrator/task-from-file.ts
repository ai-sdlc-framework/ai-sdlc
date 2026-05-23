/**
 * AISDLC-373 — task-file resolution helper for the single-PR
 * operator-driven flow.
 *
 * The autonomous orchestrator picks tasks off the dependency-graph
 * frontier, which only sees files on `main`. For operator-driven work the
 * task file may live inside a worktree at
 * `.worktrees/<id>/backlog/tasks/<id> - <slug>.md` — invisible to the
 * frontier scan. `cli-orchestrator tick --task-from-file <path>` bypasses
 * the frontier and dispatches against the file directly; this module
 * implements the path → `{id, title}` lookup that feeds the synthetic
 * single-element frontier the CLI installs in that mode.
 *
 * The resolver is intentionally narrow:
 *   - Path may be absolute OR relative to `workDir` / cwd.
 *   - File must exist.
 *   - Filename must match `aisdlc-<n>(.<m>)? - <slug>.md` (Backlog.md
 *     convention; case-insensitive).
 *   - Frontmatter `id` overrides the filename-derived id when present so
 *     a renamed file still resolves to its canonical AISDLC-NN id.
 *   - Frontmatter `title` is preferred; falls back to a tidy form of the
 *     filename slug when the field is missing.
 *
 * The file is allowed to be under `backlog/tasks/` OR `backlog/completed/` —
 * the single-PR flow may stage the task directly in `completed/` so the
 * pre-push `check-task-moved.sh` hook is a no-op.
 *
 * @module orchestrator/task-from-file
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';

import { parseSimpleYaml } from '../steps/01-validate.js';

/** Filename pattern: `aisdlc-NN[.M] - <slug>.md`. Case-insensitive. */
const TASK_FILENAME_RE = /^(aisdlc-\d+(?:\.\d+)?)\s+-\s+([^\n]+)\.md$/i;

export interface ResolvedTaskFromFile {
  /** Canonical task id in upper-case form (e.g. `AISDLC-373`). */
  id: string;
  /** Human-readable title (from frontmatter when present, else slug). */
  title: string;
  /** Absolute path to the task file on disk. */
  filePath: string;
}

export class TaskFromFileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskFromFileResolutionError';
  }
}

/**
 * Resolve `--task-from-file <path>` into `{id, title, filePath}`.
 *
 * Throws `TaskFromFileResolutionError` on every failure mode (missing
 * file, non-file, non-task filename, missing required fields) so the CLI
 * can render a single consistent error to stderr.
 */
export function resolveTaskFromFile(
  inputPath: string,
  workDir: string = process.cwd(),
): ResolvedTaskFromFile {
  if (!inputPath || inputPath.trim().length === 0) {
    throw new TaskFromFileResolutionError('--task-from-file requires a non-empty path');
  }

  const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(workDir, inputPath);

  if (!existsSync(absolutePath)) {
    throw new TaskFromFileResolutionError(`task file does not exist: ${absolutePath}`);
  }

  const stat = statSync(absolutePath);
  if (!stat.isFile()) {
    throw new TaskFromFileResolutionError(`task path is not a regular file: ${absolutePath}`);
  }

  const fileName = basename(absolutePath);
  const match = fileName.match(TASK_FILENAME_RE);
  if (!match) {
    throw new TaskFromFileResolutionError(
      `task filename does not match 'aisdlc-NN[.M] - <slug>.md': ${fileName}`,
    );
  }

  const filenameId = match[1].toUpperCase();
  const filenameSlug = match[2].trim();

  // Read frontmatter — prefer the canonical `id` / `title` fields over
  // filename inference. A file may have been renamed without re-syncing
  // the filename, but the frontmatter remains authoritative.
  //
  // Read and parse are split into two try/catch blocks so the error message
  // accurately attributes the failure to either "read" (filesystem) OR "load"
  // (YAML parse). Pre-AISDLC-373 round-2 review: a YAML-parse failure was
  // reported as `failed to read task file ... YAML parse error: ...`, which
  // was misleading because the read succeeded; only the parse failed.
  let frontmatterId: string | undefined;
  let frontmatterTitle: string | undefined;
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new TaskFromFileResolutionError(
      `failed to read task file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = parseSimpleYaml(fmMatch[1]);
      if (typeof fm.id === 'string' && fm.id.trim().length > 0) {
        frontmatterId = fm.id.trim().toUpperCase();
      }
      if (typeof fm.title === 'string' && fm.title.trim().length > 0) {
        frontmatterTitle = fm.title.trim();
      }
    }
  } catch (err) {
    throw new TaskFromFileResolutionError(
      `failed to load task file ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const id = frontmatterId ?? filenameId;
  const title = frontmatterTitle ?? humanizeSlug(filenameSlug);

  return { id, title, filePath: absolutePath };
}

/**
 * Turn `feat-collapse-two-pr-pattern-task-file` into
 * `feat collapse two pr pattern task file` for a barebones title fallback.
 * Used only when the frontmatter `title` field is missing.
 */
function humanizeSlug(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}
