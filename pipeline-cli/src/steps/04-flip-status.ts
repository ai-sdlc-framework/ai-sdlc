/**
 * Step 4 — Flip task status to In Progress + write the per-worktree
 * `.active-task` sentinel (AISDLC-81).
 *
 * The status flip side of this step requires the plugin's `task_edit`
 * MCP tool (which preserves unknown frontmatter keys); when invoked via
 * the CLI we don't have access to MCP tools, so we patch the frontmatter
 * directly with the same key-preserving semantics — matching what the
 * plugin's drop-in tool does in production.
 *
 * Sentinel: a plain text file at `<worktreePath>/.active-task` containing
 * the task ID. The PreToolUse hook walks up from the developer subagent's
 * cwd to find this sentinel and resolve `permittedExternalPaths`.
 *
 * **Which checkout owns the lifecycle edit?** The status flip is written
 * to the per-task **worktree's** copy of the task file (the fresh checkout
 * Step 3 created from `origin/main`), not the operator's parent checkout
 * passed in via `workDir`. This keeps the parent's working tree clean per
 * the orchestrator-repo-layout contract documented in `CLAUDE.md` and the
 * `project_orchestrator_repo_layout` user-memory note. Step 10 finalize
 * already prefers the worktree-local copy when patching to Done; Step 4
 * now matches so both lifecycle edits land in the same commit on the task
 * branch, never on the operator's main checkout.
 *
 * `workDir` is retained as a fallback for the standalone `cli pipeline-cli
 * begin-task` subcommand (where the operator may invoke the step against a
 * non-worktree checkout) and for tests that don't materialise a worktree
 * task file. See AISDLC-199.
 *
 * @module steps/04-flip-status
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTaskFile } from './01-validate.js';
import type { BeginTaskResult, TaskSpec } from '../types.js';

export interface BeginTaskOptions {
  taskId: string;
  worktreePath: string;
  workDir: string;
  /** Set the status to a value other than 'In Progress' (test override). */
  status?: string;
  /**
   * AISDLC-393 — when `'gh-issue'`, skip the backlog frontmatter patch
   * (no file exists on disk to patch). The sentinel write still fires —
   * the PreToolUse hook needs it to resolve `permittedExternalPaths`
   * regardless of source kind.
   */
  sourceKind?: 'backlog' | 'gh-issue';
  /**
   * AISDLC-393 (round 2, AC-2 fix) — inline `TaskSpec` for the gh-issue
   * path. When provided AND `sourceKind === 'gh-issue'` AND the spec
   * declares non-empty `permittedExternalPaths`, Step 4 materialises a
   * **synthetic task file** at
   * `<worktreePath>/backlog/tasks/<id-lower> - <slug>.md`
   * containing the minimal frontmatter the PreToolUse hook needs
   * (`id`, `title`, `permittedExternalPaths`).
   *
   * Why: the hook in `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`
   * resolves `permittedExternalPaths` by reading the on-disk backlog
   * file (`<projectRoot>/backlog/tasks/<id> -*.md`). For backlog tasks
   * that file already exists; for gh-issue dispatches it does NOT, so
   * the hook returns `[]` and DENIES every external-path write — even
   * when the GH issue's `permitted-external-paths` label declared a
   * valid allowlist. The synthetic file closes that gap.
   *
   * The file is transient: Step 13 cleanup removes it on the way out
   * (success, failure, rollback). The file IS visible to git inside the
   * worktree during dispatch — but the developer subagent stages files
   * explicitly via `git add -- <files>` and is never told to add this
   * synthetic, AND we delete it before push reaches the hook chain.
   *
   * When `taskSpec` is undefined OR `permittedExternalPaths` is empty
   * /missing, NO synthetic file is written — the gh-issue path then
   * has no external-write capability, matching the legacy behaviour.
   */
  taskSpec?: TaskSpec;
}

/**
 * AISDLC-393 (round 2, AC-2 fix) — slug a title for use in the synthetic
 * task filename. Mirrors the `slugify` shape used by
 * `__test-helpers/make-task.ts` and `compute-slug.mjs`: lowercase,
 * non-alphanumeric → `-`, trim leading/trailing dashes, max 50 chars.
 * Pure helper, exported for unit tests.
 */
export function slugifyTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * AISDLC-393 (round 2, AC-2 fix) — compute the synthetic task-file path
 * for a gh-issue dispatch. Returns the absolute path the hook's
 * `${id} -` prefix match in `<projectRoot>/backlog/tasks/` will find.
 *
 * Exported for tests + Step 13 cleanup (so cleanup re-derives the same
 * path without needing executePipeline to thread it through).
 */
export function syntheticTaskFilePath(worktreePath: string, taskSpec: TaskSpec): string {
  const slug = slugifyTaskTitle(taskSpec.title);
  const fileName = `${taskSpec.id.toLowerCase()} - ${slug}.md`;
  return join(worktreePath, 'backlog', 'tasks', fileName);
}

/**
 * AISDLC-393 (round 2, AC-2 fix) — render the minimal frontmatter the
 * hook needs to resolve `permittedExternalPaths`. The hook's parser
 * (`parseListField` in `enforce-blocked-actions.js`) reads `id:`,
 * `title:`, and the `permittedExternalPaths:` YAML list. Everything else
 * is ignored, so we keep the synthetic file deliberately minimal.
 *
 * The body is empty — the hook only parses frontmatter.
 */
export function renderSyntheticTaskFile(taskSpec: TaskSpec): string {
  const fmLines: string[] = [
    `id: ${taskSpec.id}`,
    `title: '${taskSpec.title.replace(/'/g, "''")}'`,
  ];
  if (taskSpec.permittedExternalPaths && taskSpec.permittedExternalPaths.length > 0) {
    fmLines.push('permittedExternalPaths:');
    for (const p of taskSpec.permittedExternalPaths) {
      fmLines.push(`  - '${p}'`);
    }
  }
  return (
    `---\n${fmLines.join('\n')}\n---\n\n` +
    `<!-- AISDLC-393 synthetic task file — transient allowlist marker for the\n` +
    `     PreToolUse hook on the gh-issue dispatch path. Deleted by Step 13\n` +
    `     before push. DO NOT commit this file. -->\n`
  );
}

/**
 * Patch the YAML frontmatter `status:` line in-place. Preserves all other
 * lines verbatim — matches the plugin's `task_edit` key-preservation contract.
 *
 * Exported for unit testing.
 */
export function patchFrontmatterStatus(raw: string, newStatus: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) {
    throw new Error('task file missing YAML frontmatter');
  }
  const fmRaw = fm[1];
  const body = fm[2];
  let foundStatus = false;
  const patched = fmRaw
    .split('\n')
    .map((line) => {
      const m = line.match(/^(status:\s*)(.+)$/);
      if (m) {
        foundStatus = true;
        return `${m[1]}${newStatus}`;
      }
      return line;
    })
    .join('\n');
  const finalFm = foundStatus ? patched : `${patched}\nstatus: ${newStatus}`;
  return `---\n${finalFm}\n---\n${body}`;
}

export async function beginTask(opts: BeginTaskOptions): Promise<BeginTaskResult> {
  const status = opts.status ?? 'In Progress';

  // AISDLC-393 — GH-issue path: no backlog file exists, skip the frontmatter
  // patch entirely. The sentinel write below still fires unchanged — the
  // PreToolUse hook resolves `permittedExternalPaths` from the spec's
  // frontmatter regardless of where the spec came from.
  if (opts.sourceKind !== 'gh-issue') {
    // AISDLC-199 — prefer the worktree-local copy (the fresh Step 3 checkout
    // from origin/main). Falls back to the parent `workDir` so the standalone
    // `pipeline-cli begin-task` CLI subcommand and tests that don't pre-stage
    // a worktree task file still work. Mirrors the same fallback chain Step 10
    // finalize already uses, so both lifecycle edits land on the same file.
    const taskFile =
      findTaskFile(opts.taskId, opts.worktreePath) ?? findTaskFile(opts.taskId, opts.workDir);
    if (!taskFile) {
      throw new Error(
        `Step 4 begin-task: no task file found for ${opts.taskId} under ${opts.worktreePath} or ${opts.workDir}`,
      );
    }
    const raw = readFileSync(taskFile, 'utf8');
    const patched = patchFrontmatterStatus(raw, status);
    writeFileSync(taskFile, patched, 'utf8');
  }

  // Per-worktree sentinel (AISDLC-81). Lives INSIDE the worktree so the
  // PreToolUse hook can resolve it by walking up from the agent's cwd.
  const sentinelPath = join(opts.worktreePath, '.active-task');
  writeFileSync(sentinelPath, `${opts.taskId}\n`, 'utf8');

  // AISDLC-393 (round 2, AC-2 fix) — gh-issue path with declared
  // `permittedExternalPaths`: materialise the synthetic task file so the
  // PreToolUse hook resolves the allowlist. Without this the hook reads
  // `<projectRoot>/backlog/tasks/` (no match), returns `[]`, and DENIES
  // every external-path Write/Edit. See `BeginTaskOptions.taskSpec`
  // doc-comment for the full rationale.
  //
  // The file is removed by Step 13 cleanup (`removeSyntheticGhIssueTaskFile`)
  // before push, so it never lands in a commit. The cleanup is idempotent
  // and re-derives the same path via `syntheticTaskFilePath` — Step 13
  // doesn't need this fn to thread the path back through executePipeline.
  let syntheticTaskFile: string | undefined;
  if (
    opts.sourceKind === 'gh-issue' &&
    opts.taskSpec &&
    opts.taskSpec.permittedExternalPaths &&
    opts.taskSpec.permittedExternalPaths.length > 0
  ) {
    syntheticTaskFile = syntheticTaskFilePath(opts.worktreePath, opts.taskSpec);
    mkdirSync(join(opts.worktreePath, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(syntheticTaskFile, renderSyntheticTaskFile(opts.taskSpec), 'utf8');
  }

  return {
    taskId: opts.taskId,
    worktreePath: opts.worktreePath,
    sentinelPath,
    ...(syntheticTaskFile ? { syntheticTaskFile } : {}),
  };
}
