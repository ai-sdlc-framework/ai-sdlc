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
import {
  DEFAULT_LOGGER,
  type ComputeBranchResult,
  type PipelineLogger,
  type TaskSpec,
} from '../types.js';

export interface ComputeBranchOptions {
  taskId: string;
  task: TaskSpec;
  workDir: string;
  /** Override the default branch pattern when no pipeline config is present. */
  defaultPattern?: string;
  /**
   * Optional logger used to surface the AISDLC-202.2 degraded-slug warning.
   * Defaults to `DEFAULT_LOGGER` (console.warn). Tests inject a stub to
   * assert the warning fires without polluting test output.
   */
  logger?: PipelineLogger;
}

const DEFAULT_PATTERN = 'ai-sdlc/{issueIdLower}-{slug}';

/**
 * AISDLC-202.2 — used when slugify() degrades to an empty string AND the
 * branch pattern requires a {slug} segment. Picked to be: short, ASCII-only,
 * obviously a fallback marker so operators can grep for it, and stable
 * across runs so retries land on the same branch (no auto-spawning of
 * orphan worktrees per task that hits the degraded-title path).
 *
 * Exported for tests + the regression-fixture suite.
 */
export const FALLBACK_SLUG = 'task';

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
  const rawSlug = slugify(opts.task.title);

  // AISDLC-202.2 — degraded-input fallback. AISDLC-180 originally threw here
  // to surface upstream parser bugs (legacy line-based frontmatter parser
  // captured YAML block-scalar markers like `>-` as the literal title). The
  // js-yaml parser in `parseSimpleYaml` fixed the common trigger, but Codex
  // and other-harness runs still occasionally feed titles that normalise to
  // empty (pure-punctuation, non-ASCII titles, etc.). Throwing forced the
  // operator to hand-patch the branch name in `/ai-sdlc execute`-style
  // contexts where there is no operator-in-the-loop. We now substitute a
  // stable fallback slug, log a warning so the upstream parser bug is still
  // visible, and return a usable branch.
  let slug = rawSlug;
  if (slug === '' && pattern.includes('{slug}')) {
    slug = FALLBACK_SLUG;
    const logger = opts.logger ?? DEFAULT_LOGGER;
    logger.warn(
      `[ai-sdlc] computeBranchName: slug normalisation of title ${JSON.stringify(opts.task.title)} ` +
        `(task ${opts.taskId}) produced an empty string; using fallback slug ${JSON.stringify(FALLBACK_SLUG)}. ` +
        `If the title field uses YAML block-scalar (>- or |-), confirm the frontmatter parser ` +
        `decodes it to the unwrapped string before slugify().`,
    );
  }

  const branch = pattern.replace(/\{issueIdLower\}/g, taskIdLower).replace(/\{slug\}/g, slug);
  const worktreePath = join(opts.workDir, '.worktrees', taskIdLower);
  return { branch, worktreePath, slug, taskIdLower };
}
