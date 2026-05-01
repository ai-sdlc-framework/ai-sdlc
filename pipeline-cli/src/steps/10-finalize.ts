/**
 * Step 10 — Finalize task: build acceptanceCriteriaCheck + finalSummary,
 * patch task frontmatter to Done, move file from tasks/ → completed/,
 * sign attestation (if helper available), and create the chore commit.
 *
 * Mirrors `execute-orchestrator.md` Step 10. Skipped entirely if the
 * iteration cap was hit (`needsHumanAttention`) — the human flips Done
 * after they're satisfied via `/ai-sdlc complete <task-id>` or by hand.
 *
 * **Honest scope of this Phase 1 step:**
 *   - `acceptanceCriteriaCheck` + `finalSummary` rendering — fully implemented.
 *   - Task frontmatter status flip + filesystem move tasks/→completed/ — fully implemented.
 *   - Chore commit creation — fully implemented (uses injected runner).
 *   - **Attestation signing** is delegated to `ai-sdlc-plugin/scripts/sign-attestation.mjs`
 *     when present (this is the same script `execute-orchestrator.md` invokes).
 *     If the script is absent (running outside a plugin install), we skip
 *     signing and surface that fact in the result. Phase 6 (AISDLC-100.6)
 *     will add a `pipelineVersion` field to the envelope; that change goes
 *     into the helper script, not into this step.
 *
 * @module steps/10-finalize
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { findTaskFile, parseTaskFile } from './01-validate.js';
import { patchFrontmatterStatus } from './04-flip-status.js';
import type { FinalizeTaskOptions, FinalizeTaskResult } from '../types.js';

export interface FinalizeStepOptions extends FinalizeTaskOptions {
  runner?: Runner;
  /** Path to sign-attestation.mjs (defaults to detection by env var). */
  signAttestationScript?: string;
  /** When true, skip the chore commit (useful in tests without a real git repo). */
  skipCommit?: boolean;
}

/**
 * Build the `finalSummary` markdown block per CLAUDE.md template + the
 * `acceptanceCriteriaCheck` index list (defaults to all ACs unless the
 * developer reported an explicit subset).
 *
 * Pure — exported for unit tests.
 */
export function buildFinalSummary(opts: FinalizeTaskOptions): {
  finalSummary: string;
  acceptanceCriteriaCheck: number[];
} {
  const allAcs = opts.task.acceptanceCriteria.map((_, i) => i + 1);
  const acceptanceCriteriaCheck =
    opts.developerReturn.acceptanceCriteriaMet.length > 0
      ? opts.developerReturn.acceptanceCriteriaMet
      : allAcs;

  const filesBlock =
    opts.developerReturn.filesChanged.length > 0
      ? opts.developerReturn.filesChanged.map((f) => `- ${f}`).join('\n')
      : '- (none)';

  const harnessLine = opts.verdict.harnessNote ? ` (${opts.verdict.harnessNote})` : '';

  const finalSummary =
    `## Summary\n${opts.developerReturn.summary}\n\n` +
    `## Changes\n${filesBlock}\n\n` +
    `## Design decisions\n${opts.developerReturn.notes ?? '(none)'}\n\n` +
    `## Verification\n` +
    `- \`pnpm build\` — ${opts.developerReturn.verifications.build}\n` +
    `- \`pnpm test\` — ${opts.developerReturn.verifications.test}\n` +
    `- \`pnpm lint\` — ${opts.developerReturn.verifications.lint}\n` +
    `- \`pnpm format:check\` — ${opts.developerReturn.verifications.format}\n` +
    `- 3 parallel reviews approved${harnessLine}\n\n` +
    `## Follow-up\n${opts.developerReturn.notes ?? '(none)'}\n`;

  return { finalSummary, acceptanceCriteriaCheck };
}

/**
 * Move a task file from `backlog/tasks/` to `backlog/completed/`,
 * matching the plugin's `task_complete` MCP tool semantics. Creates
 * the destination dir if it doesn't exist. Returns the new path.
 */
export function moveTaskToCompleted(taskFilePath: string): string {
  const fileName = basename(taskFilePath);
  const tasksDir = dirname(taskFilePath);
  // tasksDir is `<workDir>/backlog/tasks` — completed lives at sibling.
  const completedDir = join(dirname(tasksDir), 'completed');
  mkdirSync(completedDir, { recursive: true });
  const destPath = join(completedDir, fileName);
  renameSync(taskFilePath, destPath);
  return destPath;
}

export async function finalizeTask(opts: FinalizeStepOptions): Promise<FinalizeTaskResult> {
  if (opts.verdict.decision !== 'APPROVED') {
    return {
      finalSummary: '',
      acceptanceCriteriaCheck: [],
      attestationPath: null,
      choreCommitSha: null,
      skipped: true,
    };
  }

  const runner = opts.runner ?? defaultRunner;

  const { finalSummary, acceptanceCriteriaCheck } = buildFinalSummary(opts);

  // 1. Flip status to Done in the on-disk task file (key-preserving patch).
  // Prefer the worktree-local copy (that's what gets committed in the chore
  // commit). Fall back to the project workDir for environments where the
  // worktree isn't a real git checkout (e.g. integration tests, dry-run mode).
  const taskFile =
    findTaskFile(opts.taskId, opts.worktreePath) ?? findTaskFile(opts.taskId, opts.workDir);
  if (!taskFile) {
    throw new Error(
      `finalize: cannot locate task file for ${opts.taskId} under ${opts.worktreePath} or ${opts.workDir}`,
    );
  }
  const raw = readFileSync(taskFile, 'utf8');
  const patched = patchFrontmatterStatus(raw, 'Done');
  writeFileSync(taskFile, patched, 'utf8');

  // 2. Move tasks/ → completed/ (mirrors task_complete tool)
  const completedPath = moveTaskToCompleted(taskFile);
  // Re-parse to make sure the on-disk shape stayed valid (defensive).
  parseTaskFile(completedPath);

  // 3. Attestation signing — best-effort. The helper script lives in the
  //    plugin and isn't always available when running pipeline-cli standalone.
  let attestationPath: string | null = null;
  const helperScript =
    opts.signAttestationScript ??
    (process.env.CLAUDE_PLUGIN_ROOT
      ? join(process.env.CLAUDE_PLUGIN_ROOT, 'scripts', 'sign-attestation.mjs')
      : null);
  if (helperScript && existsSync(helperScript)) {
    const signResult = await runner('node', [helperScript], {
      cwd: opts.worktreePath,
      allowFailure: true,
    });
    if (signResult.code === 0) {
      const m = signResult.stdout.match(/\.ai-sdlc\/attestations\/[a-f0-9]+\.dsse\.json/);
      attestationPath = m ? m[0] : null;
    }
  }

  // 4. Chore commit (move + attestation if signed). Skip in tests without a repo.
  let choreCommitSha: string | null = null;
  if (!opts.skipCommit) {
    const addArgs = ['add', 'backlog/tasks', 'backlog/completed'];
    if (attestationPath) addArgs.push('.ai-sdlc/attestations');
    await runner('git', addArgs, { cwd: opts.worktreePath, allowFailure: true });
    const message =
      `chore: mark ${opts.taskId} complete\n\n` +
      `Auto-generated by /ai-sdlc execute. Reviews approved; task lifecycle landed in this PR.\n` +
      (attestationPath
        ? `Signed review attestation included at ${attestationPath} (AISDLC-74) so CI's ` +
          `verify-attestation workflow can skip the duplicate review run.\n\n`
        : `\n`) +
      `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n`;
    const commitResult = await runner('git', ['commit', '-m', message], {
      cwd: opts.worktreePath,
      allowFailure: true,
    });
    if (commitResult.code === 0) {
      const sha = await runner('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: opts.worktreePath,
        allowFailure: true,
      });
      if (sha.code === 0) choreCommitSha = sha.stdout.trim();
    }
  }

  return {
    finalSummary,
    acceptanceCriteriaCheck,
    attestationPath,
    choreCommitSha,
    skipped: false,
  };
}
