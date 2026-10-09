/**
 * review-prepare — Step 7 up to the Agent boundary, all deterministic.
 *
 *   7a-pre/7a-post  reviewer set (trusted base-branch config, AISDLC-617)
 *   7a              classifier gate (AISDLC-141, fail-open)
 *   7a-bis          incremental-review gate (AISDLC-142, trusted-author markers)
 *   7b              agent routing (codex variants by default, AISDLC-483),
 *                   model routing, diff-binding nonce (AISDLC-573)
 *
 * The result is a list of prompt files for the model to hand to `Agent`, or
 * "nothing to spawn" when the classifier / incremental gate removed every
 * reviewer. Nothing here talks to an LLM.
 *
 * @module next-step/review-prepare
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAutoApprovedVerdict } from '../incremental-review/index.js';
import {
  TRUSTED_MARKER_AUTHOR_ASSOCIATIONS,
  TRUSTED_MARKER_AUTHOR_LOGINS,
  findTrustedMarkerInComments,
  type CommentWithAuthor,
} from '../incremental-review/incremental.js';
import { resolveModel } from '../routing/resolve-model.js';
import { taskClassOf } from '../routing/task-class.js';
import { buildReviewPrompts } from '../steps/07-build-review-prompts.js';
import type { ReviewerType, ReviewerVerdict } from '../types.js';
import { writeRunFile } from './init.js';
import type { NextStepContext, NextStepState, ReviewRoundState, SpawnedReviewer } from './types.js';

/** Names the deterministic classifier emits (RFC-0010 §12). */
export type ClassifierName = 'testing' | 'critic' | 'security';

const ALL_CLASSIFIER_NAMES: ClassifierName[] = ['testing', 'critic', 'security'];

export interface ClassifierDecision {
  reviewers: string[];
  confidence: number;
  fellOpen: boolean;
  fellOpenReason?: string;
}

/** Fail-open default: every reviewer, confidence 0. */
export const CLASSIFIER_FAIL_OPEN: ClassifierDecision = {
  reviewers: ALL_CLASSIFIER_NAMES,
  confidence: 0,
  fellOpen: true,
  fellOpenReason: 'invocation-failed',
};

export type ReviewPrepareResult =
  | { kind: 'abort'; reason: string }
  | { kind: 'spawn'; review: ReviewRoundState; classifierLine: string }
  | {
      kind: 'nothing-to-spawn';
      review: ReviewRoundState;
      classifierLine: string;
      /** Synthetic auto-approved verdicts (incremental `unchanged`); empty for an empty selection. */
      verdicts: ReviewerVerdict[];
    };

/** True when the operator forced every reviewer onto Claude-native agents. */
export function forcesClaudeNative(env: NodeJS.ProcessEnv): boolean {
  return (env.AI_SDLC_REVIEWER_HARNESS ?? '').toLowerCase() === 'claude';
}

/**
 * Canonical agent for a reviewer role (AISDLC-483): code and test review go to
 * the Codex variants unless `AI_SDLC_REVIEWER_HARNESS=claude`; security and the
 * merged correctness reviewer are always Claude-native.
 */
export function resolveReviewerAgent(reviewer: ReviewerType, env: NodeJS.ProcessEnv): string {
  const claude = forcesClaudeNative(env);
  switch (reviewer) {
    case 'code-reviewer':
      return claude ? 'code-reviewer' : 'code-reviewer-codex';
    case 'test-reviewer':
      return claude ? 'test-reviewer' : 'test-reviewer-codex';
    default:
      return reviewer;
  }
}

/** Harness label recorded on the transcript leaf for an agent. */
export function reviewerHarness(
  reviewer: ReviewerType,
  env: NodeJS.ProcessEnv,
  codexAvailable: boolean,
): 'claude-code' | 'codex' {
  if (reviewer !== 'code-reviewer' && reviewer !== 'test-reviewer') return 'claude-code';
  return forcesClaudeNative(env) || !codexAvailable ? 'claude-code' : 'codex';
}

/** Placeholder leaf model for an agent with no routed model (AISDLC-690). */
export function fallbackLeafModel(agent: string): string {
  if (agent === 'code-reviewer-codex' || agent === 'test-reviewer-codex') return 'codex-default';
  if (agent === 'correctness-reviewer') return 'sonnet';
  return 'unrouted';
}

/**
 * Keep the prompts whose reviewer the classifier selected. The merged
 * `correctness-reviewer` stands for both `testing` and `critic`. A reviewer the
 * classifier has no name for is kept (the gate may shrink fan-out, never widen
 * what it does not understand).
 */
export function selectByClassifier<T extends { reviewer: ReviewerType }>(
  prompts: readonly T[],
  names: readonly string[],
): T[] {
  const want = new Set(names);
  return prompts.filter((p) => {
    switch (p.reviewer) {
      case 'test-reviewer':
        return want.has('testing');
      case 'code-reviewer':
        return want.has('critic');
      case 'security-reviewer':
        return want.has('security');
      case 'correctness-reviewer':
        return want.has('testing') || want.has('critic');
      default:
        return true;
    }
  });
}

async function runClassifier(
  ctx: NextStepContext,
  state: NextStepState,
  pathsFile: string,
  artifactsDir: string,
): Promise<ClassifierDecision> {
  const r = await ctx.runner(
    'node',
    [
      join(ctx.cliBinDir, 'cli-classify-pr.mjs'),
      'classify',
      '--paths-file',
      pathsFile,
      '--issue-id',
      state.taskId,
      '--artifacts-dir',
      artifactsDir,
    ],
    { cwd: ctx.workDir, allowFailure: true },
  );
  if (r.code !== 0) return CLASSIFIER_FAIL_OPEN;
  try {
    const parsed = JSON.parse(r.stdout) as Partial<ClassifierDecision>;
    if (!Array.isArray(parsed.reviewers)) return CLASSIFIER_FAIL_OPEN;
    return {
      reviewers: parsed.reviewers.map(String),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      fellOpen: parsed.fellOpen === true,
      ...(parsed.fellOpenReason ? { fellOpenReason: parsed.fellOpenReason } : {}),
    };
  } catch {
    return CLASSIFIER_FAIL_OPEN;
  }
}

interface IncrementalJson {
  skip: boolean;
  deltaOnly: boolean;
  reason: string;
  lastReviewedSha: string | null;
  currentContentHash: string;
  deltaSize: number;
}

const INCREMENTAL_FALLBACK: IncrementalJson = {
  skip: false,
  deltaOnly: false,
  reason: 'no-marker',
  lastReviewedSha: null,
  currentContentHash: '',
  deltaSize: 0,
};

/** Fetch PR comments and keep only trusted-author ones (AISDLC-142 round 2). */
export async function fetchTrustedComments(
  ctx: NextStepContext,
  branch: string,
): Promise<CommentWithAuthor[]> {
  const r = await ctx.runner('gh', ['pr', 'view', branch, '--json', 'comments'], {
    cwd: ctx.workDir,
    allowFailure: true,
  });
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout) as {
      comments?: Array<{
        body?: string;
        authorAssociation?: string;
        author?: { login?: string };
      }>;
    };
    return (parsed.comments ?? [])
      .map((c) => ({
        authorLogin: c.author?.login ?? '',
        authorAssociation: c.authorAssociation ?? '',
        body: c.body ?? '',
      }))
      .filter(
        (c) =>
          TRUSTED_MARKER_AUTHOR_LOGINS.has(c.authorLogin) ||
          TRUSTED_MARKER_AUTHOR_ASSOCIATIONS.has(c.authorAssociation),
      );
  } catch {
    return [];
  }
}

async function runIncrementalGate(
  ctx: NextStepContext,
  state: NextStepState,
  pathsFile: string,
): Promise<IncrementalJson> {
  const comments = await fetchTrustedComments(ctx, state.branch);
  const commentsFile = writeRunFile(ctx, 'pr-comments.json', JSON.stringify(comments));
  const prior = comments.length > 0 ? findTrustedMarkerInComments(comments) : null;
  const numstatFile = writeRunFile(ctx, 'pr-delta-numstat.txt', '');
  if (prior?.reviewedSha) {
    const n = await ctx.runner('git', ['diff', `${prior.reviewedSha}...HEAD`, '--numstat'], {
      cwd: state.worktreePath,
      allowFailure: true,
    });
    if (n.code === 0) writeFileSync(numstatFile, n.stdout, 'utf8');
  }
  const r = await ctx.runner(
    'node',
    [
      join(ctx.cliBinDir, 'cli-incremental-decide.mjs'),
      'decide',
      '--comments-json-file',
      commentsFile,
      '--base-ref',
      'origin/main',
      '--head-ref',
      'HEAD',
      '--repo-root',
      state.worktreePath,
      '--numstat-file',
      numstatFile,
      '--full-diff-paths-file',
      pathsFile,
    ],
    { cwd: ctx.workDir, allowFailure: true },
  );
  if (r.code !== 0) return INCREMENTAL_FALLBACK;
  try {
    return { ...INCREMENTAL_FALLBACK, ...(JSON.parse(r.stdout) as Partial<IncrementalJson>) };
  } catch {
    return INCREMENTAL_FALLBACK;
  }
}

function classifierLineFor(c: ClassifierDecision): string {
  return c.fellOpen
    ? `Classifier decision: [${c.reviewers.join(' ')}] (fellOpen: ${c.fellOpenReason ?? 'low-confidence'})`
    : `Classifier decision: [${c.reviewers.join(' ')}] (confidence: ${c.confidence.toFixed(2)})`;
}

/**
 * Run review-prepare for review round `round`.
 */
export async function prepareReview(
  ctx: NextStepContext,
  state: NextStepState,
  round: number,
): Promise<ReviewPrepareResult> {
  const artifactsDir = ctx.env.ARTIFACTS_DIR || join(state.worktreePath, '.ai-sdlc', 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const built = await buildReviewPrompts({
    taskId: state.taskId,
    task: state.task,
    branch: state.branch,
    worktreePath: state.worktreePath,
    workDir: ctx.workDir,
    runner: ctx.runner,
    sourceKind: 'backlog',
    iteration: round,
  });
  if (built.diffUnavailable) {
    return {
      kind: 'abort',
      reason: 'review diff unavailable (git diff failed or came back empty); reviewers not spawned',
    };
  }
  writeRunFile(ctx, 'pr-diff.txt', built.diff);
  const pathsFile = writeRunFile(ctx, 'pr-files.txt', built.changedFiles.join('\n') + '\n');

  const classifier = await runClassifier(ctx, state, pathsFile, artifactsDir);
  const classifierLine = classifierLineFor(classifier);
  const selected = selectByClassifier(built.prompts, classifier.reviewers);

  const incremental = await runIncrementalGate(ctx, state, pathsFile);
  const headSha = (
    await ctx.runner('git', ['rev-parse', 'HEAD'], { cwd: state.worktreePath, allowFailure: true })
  ).stdout.trim();

  const codex =
    forcesClaudeNative(ctx.env) ||
    (await ctx.runner('which', ['codex'], { allowFailure: true })).code === 0;
  const harnessNote = forcesClaudeNative(ctx.env)
    ? 'AI_SDLC_REVIEWER_HARNESS=claude — using Claude-native agents for all reviewers'
    : built.harnessNote;

  const baseReview: ReviewRoundState = {
    round,
    spawned: [],
    autoApproved: [],
    headSha,
    nonce: '',
    harnessNote,
    classifier: {
      reviewers: classifier.reviewers,
      confidence: classifier.confidence,
      fellOpen: classifier.fellOpen,
    },
    incremental: {
      reason: incremental.reason,
      skip: incremental.skip,
      deltaOnly: incremental.deltaOnly,
      deltaSize: incremental.deltaSize,
      lastReviewedSha: incremental.lastReviewedSha,
      contentHash: incremental.currentContentHash,
    },
  };

  // Incremental `unchanged`: reuse the prior approval, spawn nothing.
  if (incremental.skip && incremental.lastReviewedSha) {
    const reviewedSha = incremental.lastReviewedSha;
    const verdicts: ReviewerVerdict[] = selected.map((p) => ({
      agentId: resolveReviewerAgent(p.reviewer, ctx.env),
      harness: reviewerHarness(p.reviewer, ctx.env, codex),
      ...buildAutoApprovedVerdict(reviewedSha),
    }));
    return {
      kind: 'nothing-to-spawn',
      review: {
        ...baseReview,
        autoApproved: verdicts.map((v) => ({ agent: String(v.agentId), reviewedSha })),
      },
      classifierLine,
      verdicts,
    };
  }
  if (selected.length === 0) {
    return { kind: 'nothing-to-spawn', review: baseReview, classifierLine, verdicts: [] };
  }

  // Delta-only: reviewers read the delta; the verdict still covers the whole PR.
  let promptPreamble = '';
  let promptDiff: string | undefined;
  if (incremental.deltaOnly && incremental.lastReviewedSha) {
    const d = await ctx.runner('git', ['diff', `${incremental.lastReviewedSha}...HEAD`], {
      cwd: state.worktreePath,
      allowFailure: true,
    });
    if (d.code === 0) {
      promptDiff = d.stdout;
      writeRunFile(ctx, 'pr-delta-diff.txt', d.stdout);
      promptPreamble =
        `**Incremental review (AISDLC-142):** the FULL PR diff was reviewed earlier at SHA ` +
        `\`${incremental.lastReviewedSha}\`. This incremental review only covers the delta from ` +
        `\`${incremental.lastReviewedSha}\` to HEAD (${incremental.deltaSize} lines). Your verdict ` +
        `still applies to the WHOLE PR; only the diff you read is scoped down.\n\n`;
    }
  }
  const prompts =
    promptDiff === undefined
      ? selected
      : selectByClassifier(
          (
            await buildReviewPrompts({
              taskId: state.taskId,
              task: state.task,
              branch: state.branch,
              worktreePath: state.worktreePath,
              workDir: ctx.workDir,
              runner: ctx.runner,
              sourceKind: 'backlog',
              iteration: round,
              promptDiff,
              recordRouting: false,
              reviewers: selected.map((p) => p.reviewer),
            })
          ).prompts,
          classifier.reviewers,
        );

  // One nonce per round, shared by every reviewer (they all review the same head).
  const nonceRun = await ctx.runner(
    'node',
    [join(ctx.cliBinDir, 'cli-attestation.mjs'), 'generate-nonce', '--head-sha', headSha],
    { cwd: ctx.workDir, allowFailure: true },
  );
  if (nonceRun.code !== 0) {
    return { kind: 'abort', reason: `generate-nonce failed: ${nonceRun.stderr.trim()}` };
  }
  const nonce = nonceRun.stdout.trim();
  const markerRun = await ctx.runner(
    'node',
    [join(ctx.cliBinDir, 'cli-attestation.mjs'), 'nonce-marker', '--nonce', nonce],
    { cwd: ctx.workDir, allowFailure: true },
  );
  if (markerRun.code !== 0) {
    return { kind: 'abort', reason: `nonce-marker failed: ${markerRun.stderr.trim()}` };
  }
  const nonceMarker = markerRun.stdout.trim();

  const taskClass = taskClassOf(state.task.rawBody);
  const spawned: SpawnedReviewer[] = [];
  for (const p of prompts) {
    const agent = resolveReviewerAgent(p.reviewer, ctx.env);
    const routed = resolveModel({
      role: agent,
      taskClass,
      taskId: state.taskId,
      sourceKind: 'backlog',
      iteration: round,
      workDir: ctx.workDir,
      artifactsDir,
    });
    const promptFile = writeRunFile(
      ctx,
      `review-r${round}-${agent}.md`,
      `${promptPreamble}${p.prompt}\n\n` +
        `Diff-binding token (for attestation, do not omit from your response): ${nonceMarker}\n`,
    );
    spawned.push({
      reviewer: p.reviewer,
      agent,
      harness: reviewerHarness(p.reviewer, ctx.env, codex),
      leafModel: ctx.env.AISDLC_REVIEWER_MODEL || routed.model || fallbackLeafModel(agent),
      ...(routed.model && routed.arm !== 'default' ? { model: routed.model } : {}),
      promptFile,
    });
  }
  return { kind: 'spawn', review: { ...baseReview, spawned, nonce }, classifierLine };
}
