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
  const slug = slugify(opts.task.title);
  const pattern = readBranchPattern(opts.workDir, opts.defaultPattern ?? DEFAULT_PATTERN);
  const branch = pattern.replace(/\{issueIdLower\}/g, taskIdLower).replace(/\{slug\}/g, slug);
  const worktreePath = join(opts.workDir, '.worktrees', taskIdLower);
  return { branch, worktreePath, slug, taskIdLower };
}
