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
import { load as yamlLoad } from 'js-yaml';
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
  // Uses real YAML parsing (js-yaml) so the lookup is properly section-scoped:
  // `spec.backlog.branching.pattern` cannot accidentally fall through to a
  // sibling `spec.branching.pattern` if backlog lacks the key.
  const pipelineYamlPath = join(workDir, '.ai-sdlc', 'pipeline.yaml');
  if (existsSync(pipelineYamlPath)) {
    const pattern = parsePipelineBacklogKey<string>(pipelineYamlPath, ['branching', 'pattern']);
    if (typeof pattern === 'string' && pattern.length > 0) return pattern;
  }

  // --- 2. Deprecated shim: pipeline-backlog.yaml branching.pattern ---
  const legacyPath = join(workDir, '.ai-sdlc', 'pipeline-backlog.yaml');
  if (existsSync(legacyPath)) {
    const pattern = parseLegacyKey<string>(legacyPath, ['branching', 'pattern']);
    if (typeof pattern === 'string' && pattern.length > 0) {
      const log = logger ?? DEFAULT_LOGGER;
      log.warn(
        '[ai-sdlc] DEPRECATION: reading branching.pattern from .ai-sdlc/pipeline-backlog.yaml. ' +
          'Migrate this setting to .ai-sdlc/pipeline.yaml under spec.backlog.branching.pattern. ' +
          'pipeline-backlog.yaml will be removed in the next major release (AISDLC-245.5).',
      );
      return pattern;
    }
  }

  return fallback;
}

/**
 * Read `<keyPath>` from `pipeline.yaml`'s backlog section, accepting BOTH
 * shapes the schema permits:
 *   - top-level `backlog:` block
 *   - nested `spec.backlog:` block (canonical Pipeline kind document)
 *
 * Returns the resolved value or `undefined`. Section-scoped — a missing key
 * inside `backlog` does NOT fall through to a sibling `spec.<key>` block
 * (AISDLC-245.5 code-reviewer round-2 finding).
 *
 * Exported for internal reuse by step-11 (`readTitleTemplate`).
 */
export function parsePipelineBacklogKey<T>(
  pipelineYamlPath: string,
  keyPath: readonly string[],
): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(pipelineYamlPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;
  const backlog = (root.backlog ?? (root.spec as Record<string, unknown> | undefined)?.backlog) as
    | Record<string, unknown>
    | undefined;
  if (!backlog || typeof backlog !== 'object') return undefined;
  return walkKeyPath<T>(backlog, keyPath);
}

/**
 * Read `<keyPath>` from `pipeline-backlog.yaml`'s top-level shape. Returns
 * `undefined` when absent. Used by deprecated-fallback paths only.
 *
 * Exported for internal reuse by step-11.
 */
export function parseLegacyKey<T>(legacyPath: string, keyPath: readonly string[]): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(legacyPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  return walkKeyPath<T>(parsed as Record<string, unknown>, keyPath);
}

function walkKeyPath<T>(root: Record<string, unknown>, keyPath: readonly string[]): T | undefined {
  let cur: unknown = root;
  for (const segment of keyPath) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur as T | undefined;
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
