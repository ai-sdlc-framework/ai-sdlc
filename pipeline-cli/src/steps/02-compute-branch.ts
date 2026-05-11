/**
 * Step 2 — Compute branch name + worktree path.
 *
 * Mirrors `execute-orchestrator.md` Step 2. Reads the branch pattern from
 * `<workDir>/.ai-sdlc/pipeline.yaml` under `spec.backlog.branching.pattern`
 * (AISDLC-245.5 canonical location). Falls back to
 * `<workDir>/.ai-sdlc/pipeline-backlog.yaml` with a deprecation warning when
 * the pipeline.yaml backlog section is absent (one-release grace period).
 *
 * Substitutes `{issueIdLower}` + `{slug}` to produce the final branch
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
 * Read `branching.pattern` from the canonical location:
 *   1. `.ai-sdlc/pipeline.yaml` → `spec.backlog.branching.pattern` (AISDLC-245.5)
 *   2. `.ai-sdlc/pipeline-backlog.yaml` → `branching.pattern` (deprecated shim,
 *      logs a warning on first use; will be removed in the next major release)
 *
 * Returns the `fallback` pattern when neither file has the key.
 */
export function readBranchPattern(
  workDir: string,
  fallback: string = DEFAULT_PATTERN,
  logger?: PipelineLogger,
): string {
  // --- 1. Canonical path: pipeline.yaml spec.backlog.branching.pattern ---
  const pipelineYamlPath = join(workDir, '.ai-sdlc', 'pipeline.yaml');
  if (existsSync(pipelineYamlPath)) {
    let raw: string;
    try {
      raw = readFileSync(pipelineYamlPath, 'utf8');
    } catch {
      raw = '';
    }
    // Look for `backlog:` block with a nested `branching:` → `pattern:` key.
    // Uses a two-pass regex: first capture the `backlog:` section, then extract
    // `branching.pattern` from within it (tolerates arbitrary nesting depth).
    const backlogSection = raw.match(/^backlog:\s*[\r\n]((?:[ \t]+[^\r\n]*[\r\n])*)/m);
    if (backlogSection) {
      const m = backlogSection[0].match(/branching:\s*[\r\n]+\s*pattern:\s*['"]?([^'"\r\n]+)['"]?/);
      if (m) return m[1].trim();
    }
    // Also handle `spec:\n  backlog:\n    branching:\n      pattern:` shape
    // (full Pipeline kind document).
    const specBacklogM = raw.match(
      /spec:\s*[\r\n](?:[\s\S]*?)backlog:\s*[\r\n](?:[\s\S]*?)branching:\s*[\r\n]\s*pattern:\s*['"]?([^'"\r\n]+)['"]?/,
    );
    if (specBacklogM) return specBacklogM[1].trim();
  }

  // --- 2. Deprecated shim: pipeline-backlog.yaml branching.pattern ---
  const legacyPath = join(workDir, '.ai-sdlc', 'pipeline-backlog.yaml');
  if (existsSync(legacyPath)) {
    let raw: string;
    try {
      raw = readFileSync(legacyPath, 'utf8');
    } catch {
      return fallback;
    }
    const m = raw.match(/branching:\s*[\r\n]+\s*pattern:\s*['"]?([^'"\r\n]+)['"]?/);
    if (m) {
      const log = logger ?? DEFAULT_LOGGER;
      log.warn(
        '[ai-sdlc] DEPRECATION: reading branching.pattern from .ai-sdlc/pipeline-backlog.yaml. ' +
          'Migrate this setting to .ai-sdlc/pipeline.yaml under spec.backlog.branching.pattern. ' +
          'pipeline-backlog.yaml will be removed in the next major release (AISDLC-245.5).',
      );
      return m[1].trim();
    }
  }

  return fallback;
}

export async function computeBranchName(opts: ComputeBranchOptions): Promise<ComputeBranchResult> {
  const taskIdLower = opts.taskId.toLowerCase();
  const pattern = readBranchPattern(
    opts.workDir,
    opts.defaultPattern ?? DEFAULT_PATTERN,
    opts.logger,
  );
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
