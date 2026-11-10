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

import { mkdirSync } from 'node:fs';
import { buildAutoApprovedVerdict } from '../incremental-review/index.js';
import { join } from 'node:path';
import {
  TRUSTED_MARKER_AUTHOR_ASSOCIATIONS,
  TRUSTED_MARKER_AUTHOR_LOGINS,
  type CommentWithAuthor,
} from '../incremental-review/incremental.js';
import { defaultArtifactsDir, resolveProjectRoot } from '../routing/artifacts-dir.js';
import { resolveReviewerHarnessSetting } from '../routing/role-model.js';
import { resolveModel } from '../routing/resolve-model.js';
import { taskClassFromBaseRef } from '../routing/task-class.js';
import {
  buildReviewPrompts,
  type BuildReviewPromptsOptions,
} from '../steps/07-build-review-prompts.js';
import type { ReviewerType, ReviewerVerdict } from '../types.js';
import { computeRequiredReviewers } from '../attestation/review-coverage.js';
import { writeRunFile } from './init.js';
import { startStagedRound } from './staged-round.js';
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

/**
 * `selectByClassifier` plus the coverage floor (AISDLC-850, AISDLC-1251): every reviewer in
 * `required` (the `computeRequiredReviewers` set the Step 8 gate enforces) is always kept, so the
 * spawn list is a superset of the gate's requirement and the classifier narrows only reviewers
 * outside it. A required name is matched on the prompt's reviewer type.
 */
export function selectForReview<T extends { reviewer: ReviewerType }>(
  prompts: readonly T[],
  names: readonly string[],
  required: readonly string[],
): T[] {
  const selected = selectByClassifier(prompts, names);
  const must = new Set<string>(required);
  return prompts.filter((p) => must.has(p.reviewer) || selected.includes(p));
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
  opts: {
    noStaged?: boolean;
    /** Test seam: inject the round plan. */
    planRound?: BuildReviewPromptsOptions['planRound'];
  } = {},
): Promise<ReviewPrepareResult> {
  const artifactsDir =
    ctx.env.ARTIFACTS_DIR || defaultArtifactsDir(resolveProjectRoot(state.worktreePath));
  mkdirSync(artifactsDir, { recursive: true });

  // Harness default: env var wins, else the table's `harness:` key (AISDLC-1003).
  const harnessSetting = resolveReviewerHarnessSetting(ctx.env.AI_SDLC_REVIEWER_HARNESS, {
    workDir: ctx.workDir,
  });
  const env: NodeJS.ProcessEnv =
    harnessSetting.source === 'yaml' && harnessSetting.harness === 'claude'
      ? { ...ctx.env, AI_SDLC_REVIEWER_HARNESS: 'claude' }
      : ctx.env;

  const built = await buildReviewPrompts({
    taskId: state.taskId,
    task: state.task,
    branch: state.branch,
    worktreePath: state.worktreePath,
    workDir: ctx.workDir,
    runner: ctx.runner,
    sourceKind: 'backlog',
    iteration: round,
    allowSkip: true,
    ...(opts.planRound ? { planRound: opts.planRound } : {}),
  });
  if (built.diffUnavailable) {
    return {
      kind: 'abort',
      reason: 'review diff unavailable (git diff failed or came back empty); reviewers not spawned',
    };
  }
  writeRunFile(ctx, 'pr-diff.txt', built.diff);
  const pathsFile = writeRunFile(ctx, 'pr-files.txt', built.changedFiles.join('\n') + '\n');

  // AISDLC-947: on a resume, the patch id decides what reviews. Only the first round is covered;
  // a later round follows a developer fix and reviews as before.
  const resumeDecision = round === 1 ? state.resumeReview : undefined;
  if (resumeDecision?.branch === 'unchanged') {
    const reviewedSha = resumeDecision.lastHead;
    const verdicts: ReviewerVerdict[] = built.prompts.map((p) => ({
      agentId: resolveReviewerAgent(p.reviewer, env),
      harness: reviewerHarness(p.reviewer, env, false),
      ...buildAutoApprovedVerdict(reviewedSha),
    }));
    const head = await ctx.runner('git', ['rev-parse', 'HEAD'], {
      cwd: state.worktreePath,
      allowFailure: true,
    });
    return {
      kind: 'nothing-to-spawn',
      review: {
        round,
        spawned: [],
        autoApproved: verdicts.map((v) => ({ agent: String(v.agentId), reviewedSha })),
        headSha: head.stdout.trim(),
        nonce: '',
        harnessNote: `${built.harnessNote}; ${resumeDecision.note}`,
        classifier: { reviewers: [], confidence: 1, fellOpen: false },
        incremental: {
          reason: 'resume-unchanged',
          skip: true,
          deltaOnly: false,
          deltaSize: 0,
          lastReviewedSha: reviewedSha,
          contentHash: '',
        },
      },
      classifierLine: `Resume: ${resumeDecision.note}`,
      verdicts,
    };
  }

  const classifier = await runClassifier(ctx, state, pathsFile, artifactsDir);
  // Delta branch: the reviewer set comes from the last-attested-head delta, not the whole PR.
  if (resumeDecision?.branch === 'delta') {
    classifier.reviewers = resumeDecision.reviewers.includes('security-reviewer')
      ? ALL_CLASSIFIER_NAMES
      : ['testing', 'critic'];
  }
  const classifierLine = classifierLineFor(classifier);
  const selected = selectForReview(
    built.prompts,
    classifier.reviewers,
    // AISDLC-1251: the one coverage rule the Step 8 gate reads (computed once from the paths).
    // A delta resume keeps its delta-derived set.
    resumeDecision?.branch === 'delta'
      ? resumeDecision.reviewers
      : computeRequiredReviewers({
          changedPaths: built.changedFiles,
          requireThree: built.reviewerSet?.reason === 'config:require-three',
        }).required,
  );

  // AISDLC-725: the shared round plan (built with the prompts) is the one incremental decision.
  const roundPlan = built.roundPlan;
  const { deltaDiff: _omitDiff, ...planForState } = roundPlan ?? {
    deltaDiff: null,
    round: 0,
    mode: 'full' as const,
    reason: 'first-round' as const,
    baseSha: null,
    headSha: '',
    deltaSize: 0,
    contentHash: '',
    headBlobHash: '',
    prior: null,
    deltaReviewers: [],
  };
  void _omitDiff;
  const headSha = (
    await ctx.runner('git', ['rev-parse', 'HEAD'], { cwd: state.worktreePath, allowFailure: true })
  ).stdout.trim();

  const codex =
    forcesClaudeNative(env) ||
    (await ctx.runner('which', ['codex'], { allowFailure: true })).code === 0;
  const baseHarnessNote = forcesClaudeNative(env)
    ? `${harnessSetting.source === 'yaml' ? 'harness: claude in model-routing.yaml' : 'AI_SDLC_REVIEWER_HARNESS=claude'} (source: ${harnessSetting.source}) — using Claude-native agents for all reviewers`
    : `${built.harnessNote}; reviewer harness=${harnessSetting.harness} (source: ${harnessSetting.source})`;
  const harnessNote =
    round === 1 && state.resumeReview
      ? `${baseHarnessNote}; ${state.resumeReview.note}`
      : baseHarnessNote;

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
      reason: planForState.reason,
      skip: planForState.mode === 'skip',
      deltaOnly: planForState.mode === 'delta',
      deltaSize: planForState.deltaSize,
      lastReviewedSha: planForState.baseSha,
      contentHash: planForState.contentHash,
    },
    ...(roundPlan ? { roundPlan: { ...planForState } } : {}),
  };

  // Unchanged content after an approval the committed ledger corroborates: reuse it, spawn nothing.
  if (planForState.mode === 'skip' && planForState.baseSha) {
    const reviewedSha = planForState.baseSha;
    const verdicts: ReviewerVerdict[] = selected.map((p) => ({
      agentId: resolveReviewerAgent(p.reviewer, env),
      harness: reviewerHarness(p.reviewer, env, codex),
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
  const stagedWanted =
    built.reviewerSetMode === 'staged' && opts.noStaged !== true && planForState.mode !== 'skip';
  if (selected.length === 0 && !stagedWanted) {
    return { kind: 'nothing-to-spawn', review: baseReview, classifierLine, verdicts: [] };
  }

  const prompts = selected;

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

  const taskClass = taskClassFromBaseRef(state.task);
  const spawnedFor = (ps: typeof prompts): SpawnedReviewer[] => {
    const out: SpawnedReviewer[] = [];
    for (const p of ps) {
      const agent = resolveReviewerAgent(p.reviewer, env);
      const routed = resolveModel({
        role: agent,
        taskClass,
        taskId: state.taskId,
        sourceKind: 'backlog',
        iteration: round,
        workDir: ctx.workDir,
        artifactsDir,
      });
      const files = writeReviewPromptFiles(
        ctx,
        `review-r${round}-${agent}`,
        `${p.prompt}\n\n` +
          `Diff-binding token (for attestation, do not omit from your response): ${nonceMarker}\n`,
        reviewPromptPartBytes(ctx.env),
      );
      out.push({
        reviewer: p.reviewer,
        agent,
        harness: reviewerHarness(p.reviewer, env, codex),
        leafModel: ctx.env.AISDLC_REVIEWER_MODEL || routed.model || fallbackLeafModel(agent),
        ...(routed.model && routed.arm !== 'default' ? { model: routed.model } : {}),
        promptFile: files[0],
        ...(files.length > 1 ? { promptParts: files } : {}),
      });
    }
    return out;
  };

  if (stagedWanted) {
    // The standalone security reviewer runs beside the staged set, last (RFC-0052 OQ-1).
    const securityPrompts = built.prompts.filter((p) => p.reviewer === 'security-reviewer');
    const security = spawnedFor(securityPrompts)[0] ?? null;
    // DEC-0149: staged leaves are advisory and never satisfy the reviewer-set requirement, so
    // the classifier's normal set runs beside the staged pipeline and is what the envelope covers.
    const beside = spawnedFor(prompts);
    const stagedReview = await startStagedRound(ctx, state, {
      round,
      artifactsDir,
      baseReview,
      security,
      beside,
      nonce,
    });
    if (stagedReview) return { kind: 'spawn', review: stagedReview, classifierLine };
    // Fell back: the existing set reviews, exactly as if staged had not been requested.
    return prepareReview(ctx, state, round, { noStaged: true });
  }

  const spawned = spawnedFor(prompts);
  return { kind: 'spawn', review: { ...baseReview, spawned, nonce }, classifierLine };
}

/** Bytes per prompt file: the Read tool returns ~25k tokens per call; hex hashes run ~2 bytes/token. */
export const REVIEW_PROMPT_PART_BYTES = 40_000;
/** Lines per prompt file, under the Read tool's default 2,000-line window. */
export const REVIEW_PROMPT_PART_LINES = 1_500;

/** Part size: `AI_SDLC_REVIEW_PROMPT_PART_BYTES` when it is an integer >= 1,000, else the default. */
export function reviewPromptPartBytes(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AI_SDLC_REVIEW_PROMPT_PART_BYTES);
  return Number.isInteger(raw) && raw >= 1_000 ? raw : REVIEW_PROMPT_PART_BYTES;
}

/**
 * Split `text` on line boundaries into chunks of at most `maxBytes` UTF-8 bytes and `maxLines`
 * lines; a single line longer than `maxBytes` is cut by characters. `chunks.join('') === text`.
 */
export function splitReviewPrompt(
  text: string,
  maxBytes: number,
  maxLines = REVIEW_PROMPT_PART_LINES,
): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes && text.split('\n').length <= maxLines) {
    return [text];
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  let currentLines = 0;
  const flush = (): void => {
    if (current !== '') chunks.push(current);
    current = '';
    currentBytes = 0;
    currentLines = 0;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    for (const piece of cutLongLine(line, maxBytes)) {
      const bytes = Buffer.byteLength(piece, 'utf8');
      if (currentBytes + bytes > maxBytes || currentLines + 1 > maxLines) flush();
      current += piece;
      currentBytes += bytes;
      currentLines += 1;
    }
  }
  flush();
  return chunks;
}

function cutLongLine(line: string, maxBytes: number): string[] {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return [line];
  const pieces: string[] = [];
  let piece = '';
  let pieceBytes = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (pieceBytes + bytes > maxBytes) {
      pieces.push(piece);
      piece = '';
      pieceBytes = 0;
    }
    piece += ch;
    pieceBytes += bytes;
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/** Room each part keeps for its header and its next-part pointer. */
const PART_FRAME_BYTES = 1_000;

/**
 * Write one reviewer prompt. When it fits one Read call it goes to `<base>.md`, unchanged.
 * Otherwise it goes to `<base>.part-<i>-of-<n>.md`, each part with a header and each but the
 * last ending with the path of the next part. The nonce marker stays at the end of the prompt,
 * so only the last part holds it and a reviewer must read every part to echo it.
 * Returns the files in reading order.
 */
export function writeReviewPromptFiles(
  ctx: NextStepContext,
  base: string,
  content: string,
  maxBytes: number,
): string[] {
  const chunks = splitReviewPrompt(content, Math.max(maxBytes - PART_FRAME_BYTES, 500));
  if (chunks.length === 1) return [writeRunFile(ctx, `${base}.md`, content)];
  const n = chunks.length;
  const names = chunks.map((_, i) => `${base}.part-${i + 1}-of-${n}.md`);
  return chunks.map((chunk, i) => {
    const header = `<!-- Review prompt part ${i + 1} of ${n}. Read all ${n} parts, in order, before you start the review. -->\n\n`;
    const footer =
      i < n - 1
        ? `\n\n<!-- End of part ${i + 1} of ${n}. Continue with \`${join(ctx.filesDir, names[i + 1])}\`. -->\n`
        : '';
    return writeRunFile(ctx, names[i], header + chunk + footer);
  });
}

/**
 * Short prompt the loop driver hands a reviewer instead of relaying the full prompt text
 * (AISDLC-1031). It names the prompt file (or every part of a split prompt, in reading order)
 * only; the diff and the nonce marker stay in the files.
 */
export function bootstrapPromptFor(promptFile: string, promptParts?: readonly string[]): string {
  if (promptParts && promptParts.length > 1) {
    return (
      `Your review prompt is split into ${promptParts.length} files because it is too large for one Read call. ` +
      'Read every file with the Read tool, in this order, and only then carry out every instruction in them:\n' +
      promptParts.map((file, i) => `${i + 1}. \`${file}\``).join('\n') +
      '\nThe last file holds the review marker you must echo in your response.'
    );
  }
  return (
    `Read \`${promptFile}\` with the Read tool and carry out every instruction in it. ` +
    'The file holds your full review prompt, including the review marker you must echo in your response.'
  );
}
