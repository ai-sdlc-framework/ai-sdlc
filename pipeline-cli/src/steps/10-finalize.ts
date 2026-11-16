/**
 * Step 10 — Finalize task: build acceptanceCriteriaCheck + finalSummary,
 * patch task frontmatter to Done, move file from tasks/ → completed/,
 * and create the chore commit.
 *
 * Mirrors `execute-orchestrator.md` Step 10. Skipped entirely if the
 * iteration cap was hit (`needsHumanAttention`) — the human flips Done
 * after they're satisfied via `/ai-sdlc complete <task-id>` or by hand.
 *
 * **Honest scope of this Phase 1 step:**
 *   - `acceptanceCriteriaCheck` + `finalSummary` rendering — fully implemented.
 *   - Task frontmatter status flip + filesystem move tasks/→completed/ — fully implemented.
 *   - Chore commit creation — fully implemented (uses injected runner).
 *
 * @module steps/10-finalize
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { findTaskFile, isTaskFileCompleted, parseTaskFile } from './01-validate.js';
import { ATTESTATION_ARTIFACT_PATHS } from '../attestation-artifacts.js';
import { patchFrontmatterStatus } from './04-flip-status.js';
import { checkFollowups, formatFollowupViolations } from '../backlog/followup-rule.js';
import { completeTaskAtomically } from '../cli/complete-task.js';
import { loadVerification } from './verification-config.js';
import { VERIFICATION_KEYS, type VerificationKey } from './verify-defaults.js';
import type { DeveloperReturn, FinalizeTaskOptions, FinalizeTaskResult } from '../types.js';

export interface FinalizeStepOptions extends FinalizeTaskOptions {
  runner?: Runner;
  /** When true, skip the chore commit (useful in tests without a real git repo). */
  skipCommit?: boolean;
  /**
   * When true, use `completeTaskAtomically` (AISDLC-203) for the task move
   * instead of the raw `renameSync`-based `moveTaskToCompleted`.
   *
   * The atomic helper performs duplicate detection, atomic write+rename, and
   * post-move verification so the task ID ends up in exactly ONE backlog
   * location. This is the correct path for the Codex execution path (and any
   * other harness where multiple processes may operate on the same backlog
   * concurrently). The Claude Code `/ai-sdlc execute` path defaults to false
   * (backward-compatible) because it runs in a worktree isolation that already
   * ensures a single writer; switching it on is safe but not required there.
   *
   * AISDLC-202.3 — AC #3: Codex execution path Step 10 must use this flag.
   */
  useAtomicCompletion?: boolean;
  /**
   * AISDLC-393 — when `'gh-issue'`, skip the backlog frontmatter patch +
   * tasks/→completed/ move (no backlog file exists). Attestation signing +
   * chore commit (for the attestation envelope) still fire so the signing
   * path produces a valid envelope at HEAD before push. Final summary is
   * still built so the orchestrator's PR-body composition has it.
   */
  sourceKind?: 'backlog' | 'gh-issue';
  /**
   * AISDLC-738 — resumed task: when the task file is already in the worktree's
   * `backlog/completed/`, skip the Done flip and move (they landed with the
   * first PR); attestation signing and the chore commit still run.
   */
  resume?: boolean;
}

/** One bullet per verification key; an unconfigured key prints `skipped (not configured)`. */
export function verificationLines(
  projectRoot: string,
  developerReturn: DeveloperReturn,
  summaryOf: (k: VerificationKey) => string,
): string {
  const cmds = loadVerification(projectRoot);
  return VERIFICATION_KEYS.map((k) =>
    cmds[k]
      ? `- \`${cmds[k]}\` — ${developerReturn.verifications[k]}${summaryOf(k)}`
      : `- \`${k}\` — skipped (not configured)`,
  ).join('\n');
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

  const summaries = opts.developerReturn.verificationSummaries;
  const summaryOf = (k: VerificationKey): string => (summaries?.[k] ? ` (${summaries[k]})` : '');

  const harnessLine = opts.verdict.harnessNote ? ` (${opts.verdict.harnessNote})` : '';

  const finalSummary =
    `## Summary\n${opts.developerReturn.summary}\n\n` +
    `## Changes\n${filesBlock}\n\n` +
    `## Design decisions\n${notesText(opts.developerReturn.notes)}\n\n` +
    `## Verification\n` +
    `${verificationLines(opts.workDir, opts.developerReturn, summaryOf)}\n` +
    `- 3 parallel reviews approved${harnessLine}\n\n` +
    `## Follow-up\n${followupsText(opts.developerReturn.followups)}\n`;

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

  // AISDLC-997 - fail closed at finalize, not at the pre-push follow-up gate.
  const prefix = /^([A-Za-z][A-Za-z0-9]*)-/.exec(opts.taskId)?.[1];
  const followupCheck = checkFollowups(finalSummary, prefix ? { taskPrefix: prefix } : {});
  if (!followupCheck.ok) {
    throw new Error(
      `finalize: invalid Follow-up section for ${opts.taskId}\n` +
        formatFollowupViolations(followupCheck.violations, prefix ? { taskPrefix: prefix } : {}),
    );
  }

  // AISDLC-393 — GH-issue path skips steps 1-2 entirely (backlog file move
  // + frontmatter patch). The issue is the source of truth and closes via
  // `Closes #N` in the PR body. We still build the final summary above and
  // proceed to attestation signing + chore commit below so the signed
  // envelope lands at HEAD before push.
  const alreadyCompleted =
    opts.resume === true && isTaskFileCompleted(opts.taskId, opts.worktreePath);
  if (opts.sourceKind !== 'gh-issue' && !alreadyCompleted) {
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

    // 2. Move tasks/ → completed/ using the appropriate strategy.
    //
    // `useAtomicCompletion` (AISDLC-202.3 AC #3): use `completeTaskAtomically`
    // (the AISDLC-203 shared helper) which performs an atomic write+rename with
    // duplicate detection and single-location verification. This is the required
    // path for the Codex execution path where multiple processes may operate on
    // the same backlog. `completeTaskAtomically` also patches the status to Done
    // internally, so we skip the manual patch below.
    //
    // Default (backward-compat): plain `renameSync`-based `moveTaskToCompleted`
    // followed by a manual status patch — this is the pre-202.3 Claude Code path.
    let completedPath: string;
    if (opts.useAtomicCompletion) {
      const result = completeTaskAtomically(opts.taskId, opts.worktreePath);
      completedPath = result.alreadyDone ? result.location : result.to;
    } else {
      const raw = readFileSync(taskFile, 'utf8');
      const patched = patchFrontmatterStatus(raw, 'Done');
      writeFileSync(taskFile, patched, 'utf8');
      completedPath = moveTaskToCompleted(taskFile);
    }
    // Re-parse to make sure the on-disk shape stayed valid (defensive).
    parseTaskFile(completedPath);
  }

  // 3. Chore commit (task move + review records). Skip in tests without a repo.
  //
  // AISDLC-393 — GH-issue path: no backlog dirs to add; with no review records
  // there is nothing to commit and the commit is skipped (choreCommitSha=null).
  let choreCommitSha: string | null = null;
  if (!opts.skipCommit) {
    const addArgs: string[] = ['add'];
    if (opts.sourceKind !== 'gh-issue') {
      addArgs.push('backlog/tasks', 'backlog/completed');
    }
    // AISDLC-1016: review records written during the review loop ride in this chore
    // commit, so the tree is clean before the Step 11 rebase.
    for (const p of ATTESTATION_ARTIFACT_PATHS) {
      if (existsSync(join(opts.worktreePath, p))) addArgs.push(p);
    }

    // For gh-issue with no attestation: skip the commit (nothing to stage).
    if (addArgs.length > 1) {
      await runner('git', addArgs, { cwd: opts.worktreePath, allowFailure: true });
      const message =
        opts.sourceKind === 'gh-issue'
          ? `chore: commit review records for ${opts.taskId}\n\n` +
            `Auto-generated by /ai-sdlc execute (GH-issue path). Reviews approved.\n\n` +
            `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n`
          : `chore: mark ${opts.taskId} complete\n\n` +
            `Auto-generated by /ai-sdlc execute. Reviews approved; task lifecycle landed in this PR.\n\n` +
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
  }

  return {
    finalSummary,
    acceptanceCriteriaCheck,
    attestationPath: null,
    choreCommitSha,
    skipped: false,
  };
}

function followupsText(followups: DeveloperReturn['followups']): string {
  if (!followups || followups.length === 0) return '(none)';
  return followups.map((f) => `- ${f}`).join('\n');
}

function notesText(notes: DeveloperReturn['notes']): string {
  if (notes === undefined) return '(none)';
  return typeof notes === 'string' ? notes : JSON.stringify(notes);
}

/** Workflow registry metadata (RFC-0056). */
export const FINALIZE_STEP: import('./step-meta.js').StepMeta = {
  id: 'finalize-task',
  inputs: 'local:verdict',
  outputs: 'backlog-task.v1',
};
