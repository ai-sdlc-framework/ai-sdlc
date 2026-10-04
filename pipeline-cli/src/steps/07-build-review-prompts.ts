/**
 * Step 7 — Build review prompts (default: 3 reviewers — code, test, security).
 *
 * Mirrors `execute-orchestrator.md` Step 7. Captures the PR diff + changed
 * file list, detects whether `codex` is installed (independence harness),
 * and produces reviewer-specific prompt strings that can be fed to parallel
 * `SubagentSpawner.spawn()` calls (Tier 2) or parallel Agent tool
 * invocations (Tier 1).
 *
 * AISDLC-617 — the reviewer SET is flag-driven via
 * `resolveReviewerSet()` (`steps/reviewer-set.ts`): the DEFAULT remains the
 * three reviewers above; `reviewerSet: code-test-merged` (opt-in, via
 * `AI_SDLC_REVIEWER_SET` or `.ai-sdlc/review-config.yaml`) swaps in exactly
 * two — `correctness-reviewer` (merged code+test remit) + `security-reviewer`
 * (unchanged, separate). With a judgment provider configured, `selectReviewerSet()`
 * may pick the merged set per PR (trusted work only, never past a path veto) and
 * `routeReviewers()` may add reviewers afterwards; neither ever shrinks a set. Do not
 * hardcode a reviewer count anywhere downstream of this step: always read
 * `prompts.length`.
 *
 * The reviewer subagents themselves run via the LLM dispatch boundary
 * (Step 7b) which is NOT part of this step.
 *
 * @module steps/07-build-review-prompts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import type { BuildReviewPromptsResult, ReviewPrompt, ReviewerType, TaskSpec } from '../types.js';
import { resolveTargetBranch } from './02-compute-branch.js';
import { selectReviewerSet } from './reviewer-set.js';
import { diffHasBinaryHunk } from './review-judgment-support.js';
import { routeReviewers } from './review-routing.js';
import { buildJudgmentContext } from '../judgment/context.js';
import type { EvaluateJudgmentContext } from '@ai-sdlc/reference';
import { resolveModel } from '../routing/resolve-model.js';
import { routingArtifactsDir, routingRecordable } from '../routing/artifacts-dir.js';
import { taskClassOf } from '../routing/task-class.js';
import { diffHeaderPaths } from '../classifier/diff-header.js';

export interface BuildReviewPromptsOptions {
  taskId: string;
  task: TaskSpec;
  branch: string;
  worktreePath: string;
  workDir: string;
  runner?: Runner;
  /** Override the codex-availability detection (test injection). */
  codexAvailable?: boolean;
  /** Override the resolved reviewer set (test injection / explicit caller choice). AISDLC-617. */
  reviewers?: ReviewerType[];
  /** Source of the work; only an explicit `backlog` is eligible for model exploration. */
  sourceKind?: 'backlog' | 'gh-issue';
  /** Review iteration (default 1). Missing means 1; NaN counts as a re-run (never relaxes review). */
  iteration?: number;
  /** Artifacts directory for the assignment log (defaults to $ARTIFACTS_DIR). */
  artifactsDir?: string;
  /**
   * Set false to resolve models without writing the assignment log or reporting
   * the routing capability (offline replay must leave no trace).
   */
  recordRouting?: boolean;
  /**
   * Judgment context for `review.reviewer-set` and `review.routing` (test injection).
   * Defaults to the context built from the trusted base-branch config; with no
   * provider configured the judgments are never evaluated and the reviewers are
   * exactly what the resolver returns.
   */
  judgment?: EvaluateJudgmentContext;
}

export async function buildReviewPrompts(
  opts: BuildReviewPromptsOptions,
): Promise<BuildReviewPromptsResult> {
  const runner = opts.runner ?? defaultRunner;

  // AISDLC-606 — diff against the resolved integration branch (defaults to
  // `origin/main` when `spec.branching.targetBranch` is unset, so main-based
  // repos are byte-identical to pre-AISDLC-606 behavior).
  const targetBranch = resolveTargetBranch(opts.workDir);
  const baseRef = `origin/${targetBranch}`;

  // `--text` stops a `-diff` attribute hiding content behind a binary stub, but it also
  // means git never prints `Binary files ... differ`, so binary files are detected
  // separately (numstat below, and NUL / U+FFFD in the text). `--no-ext-diff` and
  // `--no-textconv` keep repo-configured drivers from rewriting what reviewers read.
  // `core.quotePath=false` keeps non-ASCII bytes literal; `-z` separates paths with NUL
  // and never quotes them; `--no-renames` lists both sides of a rename. The path rules
  // that veto a relaxation match on these plain paths.
  const diffResult = await runner(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--text',
      '--no-ext-diff',
      '--no-textconv',
      `${baseRef}...HEAD`,
    ],
    { cwd: opts.worktreePath, allowFailure: true },
  );
  const rawDiff = diffResult.code === 0 ? diffResult.stdout : '';

  // Without `--text`, git reports a binary file as `-\t-\t<path>`.
  const numstatResult = await runner(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--numstat',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      `${baseRef}...HEAD`,
    ],
    { cwd: opts.worktreePath, allowFailure: true },
  );
  const binaryPaths =
    numstatResult.code === 0 ? parseBinaryNumstat(numstatResult.stdout) : new Set<string>();
  const { diff, stubbed } = stubBinaryHunks(rawDiff, binaryPaths);
  const binaryDiff = stubbed || binaryPaths.size > 0 || diffHasBinaryHunk(rawDiff);

  const filesResult = await runner(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      `${baseRef}...HEAD`,
    ],
    { cwd: opts.worktreePath, allowFailure: true },
  );
  const changedFiles =
    filesResult.code === 0 ? filesResult.stdout.split('\0').filter((p) => p !== '') : [];
  // A failed git call, or a diff that came back empty for a non-empty file list, means the
  // judgment would see file names alone. It must not relax review in that case.
  const diffUnavailable =
    diffResult.code !== 0 ||
    filesResult.code !== 0 ||
    numstatResult.code !== 0 ||
    (changedFiles.length > 0 && diff.trim() === '');

  // Codex independence detection
  let codexAvailable = opts.codexAvailable;
  if (codexAvailable === undefined) {
    try {
      const which = await runner('which', ['codex'], { allowFailure: true });
      codexAvailable = which.code === 0 && which.stdout.trim().length > 0;
    } catch {
      codexAvailable = false;
    }
  }
  const harnessNote = codexAvailable
    ? ''
    : '⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)';

  // Optional review policy from .ai-sdlc/review-policy.md (project-specific calibration)
  const policyPath = join(opts.workDir, '.ai-sdlc', 'review-policy.md');
  const policy = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : '';

  const acList = opts.task.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n');

  // Offline replay (`recordRouting: false`) leaves no trace, so it never reaches a provider.
  const judgment =
    opts.recordRouting === false
      ? undefined
      : (opts.judgment ??
        buildJudgmentContext({
          workDir: opts.workDir,
          artifactsDir: routingArtifactsDir(opts.worktreePath, opts.artifactsDir),
          ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
          taskId: opts.taskId,
        }));
  const selected =
    opts.reviewers ??
    (
      await selectReviewerSet({
        workDir: opts.workDir,
        ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
        taskId: opts.taskId,
        changedFiles,
        diff,
        diffUnavailable,
        binaryDiff,
        ...(opts.iteration !== undefined ? { iteration: opts.iteration } : {}),
        ...(judgment ? { judgment } : {}),
      })
    ).reviewers;
  // review.routing runs after set selection and can only add reviewers.
  const reviewers = (
    await routeReviewers({
      reviewers: selected,
      changedFiles,
      diff,
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      taskId: opts.taskId,
      ...(judgment ? { judgment } : {}),
    })
  ).reviewers;

  const taskClass = taskClassOf(opts.task.rawBody);
  const prompts: ReviewPrompt[] = reviewers.map((reviewer) => {
    const routed = resolveModel({
      role: reviewer,
      taskClass,
      taskId: opts.taskId,
      sourceKind: opts.sourceKind,
      iteration: opts.iteration ?? 1,
      workDir: opts.workDir,
      artifactsDir: routingArtifactsDir(opts.worktreePath, opts.artifactsDir),
      record:
        opts.recordRouting !== false && routingRecordable(opts.worktreePath, opts.artifactsDir),
    });
    return {
      reviewer,
      ...(routed.model !== undefined ? { model: routed.model } : {}),
      modelArm: routed.arm,
      prompt: buildPrompt(reviewer, {
        taskId: opts.taskId,
        title: opts.task.title,
        description: opts.task.description,
        acList,
        diff,
        changedFiles,
        branch: opts.branch,
        policy,
        harnessNote,
      }),
    };
  });

  return { prompts, diff, changedFiles, harnessNote, diffUnavailable };
}

/** Paths git reports as binary (`-\t-\t<path>`) in `--numstat -z --no-renames` output. */
export function parseBinaryNumstat(out: string): Set<string> {
  const paths = new Set<string>();
  for (const rec of out.split('\0')) {
    const m = /^-\t-\t(.+)$/s.exec(rec);
    if (m) paths.add(m[1]);
  }
  return paths;
}

const MAX_LISTED_BINARY_CHARS = 200_000;

/**
 * Replace the diff section of every binary file (holding a NUL byte, or listed by
 * numstat and very large) with git's own one-line binary stub, so the prompt carries no NUL bytes and
 * no large binary payload.
 */
export function stubBinaryHunks(
  diff: string,
  binaryPaths: ReadonlySet<string>,
): { diff: string; stubbed: boolean } {
  if (diff === '') return { diff, stubbed: false };
  let stubbed = false;
  const sections = diff.split(/^(?=diff --git )/m).map((section) => {
    const headerLine = section.split('\n', 1)[0];
    const header = headerLine.startsWith('diff --git ')
      ? diffHeaderPaths(headerLine.slice('diff --git '.length))
      : undefined;
    // A NUL byte is what git itself treats as binary. A numstat-binary file with no NUL
    // (a `-diff` attribute) keeps its text, unless it is huge.
    const listed =
      header !== undefined && (binaryPaths.has(header.oldPath) || binaryPaths.has(header.newPath));
    const binary =
      section.includes('\u0000') || (listed && section.length > MAX_LISTED_BINARY_CHARS);
    if (!binary) return section;
    stubbed = true;
    if (!header) return 'Binary files a/(unreadable) and b/(unreadable) differ\n';
    return `${headerLine}\nBinary files a/${header.oldPath} and b/${header.newPath} differ\n`;
  });
  return { diff: sections.join(''), stubbed };
}

interface PromptInputs {
  taskId: string;
  title: string;
  description: string;
  acList: string;
  diff: string;
  changedFiles: string[];
  branch: string;
  policy: string;
  harnessNote: string;
}

function buildPrompt(reviewer: ReviewerType, inputs: PromptInputs): string {
  const policyBlock = inputs.policy
    ? `\n## Project review policy (.ai-sdlc/review-policy.md)\n\n${inputs.policy}\n`
    : '';
  const harnessBlock = inputs.harnessNote ? `\n${inputs.harnessNote}\n` : '';
  const filesBlock = inputs.changedFiles.length
    ? inputs.changedFiles.map((f) => `- ${f}`).join('\n')
    : '(none)';

  return (
    `You are the ${reviewer} for backlog task ${inputs.taskId}.\n\n` +
    `## Task\n${inputs.title}\n\n` +
    `## Description\n${inputs.description}\n\n` +
    `## Acceptance criteria\n${inputs.acList}\n\n` +
    `## Branch / base\nbranch: ${inputs.branch} → main\n\n` +
    `## Changed files\n${filesBlock}\n` +
    policyBlock +
    harnessBlock +
    `\n## Diff\n\n\`\`\`diff\n${inputs.diff}\n\`\`\`\n\n` +
    `Return a verdict JSON: { approved: boolean, findings: [...], summary: string }.\n`
  );
}
