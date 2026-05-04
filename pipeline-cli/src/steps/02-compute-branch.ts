/**
 * Step 2 — Compute branch name + worktree path.
 *
 * Mirrors `execute-orchestrator.md` Step 2. Reads the branch pattern from
 * `<workDir>/.ai-sdlc/pipeline-backlog.yaml` (key: `branching.pattern`)
 * and substitutes `{issueIdLower}` + `{slug}` to produce the final branch
 * name. The slug is a kebab-cased prefix of the task title capped at 50 chars.
 *
 * Pure: only reads from disk via `node:fs`; no git/network.
 *
 * @module steps/02-compute-branch
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputeBranchResult, TaskSpec } from '../types.js';

export interface ComputeBranchOptions {
  taskId: string;
  task: TaskSpec;
  workDir: string;
  /** Override the default branch pattern when no pipeline config is present. */
  defaultPattern?: string;
}

const DEFAULT_PATTERN = 'ai-sdlc/{issueIdLower}-{slug}';

/** Slugify a task title into kebab-case ASCII-only, capped at 50 chars. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Read `branching.pattern` from `.ai-sdlc/pipeline-backlog.yaml`. Returns
 * the default pattern if the file is missing or the key isn't present.
 */
export function readBranchPattern(workDir: string, fallback: string = DEFAULT_PATTERN): string {
  const yamlPath = join(workDir, '.ai-sdlc', 'pipeline-backlog.yaml');
  if (!existsSync(yamlPath)) return fallback;
  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch {
    return fallback;
  }
  // Look for `branching:\n  pattern: '...'` shape; tolerate single OR double
  // quotes OR no quotes.
  const m = raw.match(/branching:\s*[\r\n]+\s*pattern:\s*['"]?([^'"\r\n]+)['"]?/);
  return m ? m[1].trim() : fallback;
}

export async function computeBranchName(opts: ComputeBranchOptions): Promise<ComputeBranchResult> {
  const taskIdLower = opts.taskId.toLowerCase();
  const pattern = readBranchPattern(opts.workDir, opts.defaultPattern ?? DEFAULT_PATTERN);
  const slug = slugify(opts.task.title);

  // AISDLC-180 — fail loud when the slug normalisation strips the title to
  // an empty string. The previous behaviour silently produced branches like
  // `ai-sdlc/aisdlc-178.1-` (trailing dash, no slug body), which then broke
  // worktree creation across multiple tasks (every empty-slug task tried to
  // claim the same `ai-sdlc/aisdlc-NNN-` branch shape) and made PR titles
  // unhelpful. The most common trigger was a YAML block-scalar title
  // (`title: >- \n  long wrapped …`) that the legacy line-based frontmatter
  // parser captured as the literal indicator `>-` — that path is now fixed
  // by the js-yaml parser in `parseSimpleYaml`, but we still guard here so
  // any future title shape that produces an empty slug surfaces with a
  // clear error rather than a malformed branch name.
  if (slug === '' && pattern.includes('{slug}')) {
    throw new Error(
      `slug normalisation produced empty string from title ${JSON.stringify(opts.task.title)} ` +
        `(task ${opts.taskId}); branch pattern ${JSON.stringify(pattern)} requires a non-empty {slug}. ` +
        `The title is missing alphanumeric characters after kebab-case normalisation — ` +
        `if the title field uses YAML block-scalar (>- or |-), confirm the frontmatter parser ` +
        `decodes it to the unwrapped string before slugify().`,
    );
  }

  const branch = pattern.replace(/\{issueIdLower\}/g, taskIdLower).replace(/\{slug\}/g, slug);
  const worktreePath = join(opts.workDir, '.worktrees', taskIdLower);
  return { branch, worktreePath, slug, taskIdLower };
}
