/**
 * Step 9 — Iteration loop (max N developer iterations on review failure).
 *
 * Mirrors `execute-orchestrator.md` Step 9. Wraps Steps 5/5b/6/7/7b/8 and
 * loops until reviewers approve OR the iteration cap is hit. The LLM
 * dispatch (Steps 5b, 7b) goes through the `SubagentSpawner` interface,
 * which lets Tier 2 inject `ShellClaudePSpawner` (subscription) /
 * `ClaudeCodeSDKSpawner` (API key) / `MockSpawner` (tests).
 *
 * If the cap is hit and there are still critical/major findings, returns
 * with `needsHumanAttention: true` — Step 10 will then skip finalisation
 * and Step 11 will open the PR with the `[needs-human-attention]` flag.
 *
 * @module steps/09-iterate
 */

import { buildDeveloperPrompt } from './05-build-dev-prompt.js';
import { parseDeveloperReturnWithRetry } from './06-parse-dev-return.js';
import { buildReviewPrompts } from './07-build-review-prompts.js';
import { aggregateVerdicts, formatFeedback } from './08-aggregate-verdicts.js';
import type {
  IterateReviewLoopOptions,
  IterateReviewLoopResult,
  ReviewerType,
  ReviewerVerdict,
  SubagentResult,
} from '../types.js';

const REVIEWER_TYPES: ReviewerType[] = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

const DEFAULT_MAX_ITERATIONS = 2;

/**
 * Run the review-iteration loop. The first iteration's developer return
 * + aggregated verdict are passed in by the caller (they've already been
 * computed by Steps 5b → 6 → 7b → 8 to seed the loop).
 *
 * For iteration N>1 the loop:
 *   - Builds a feedback-augmented developer prompt (Step 5)
 *   - Spawns the developer subagent via the spawner (Step 5b — LLM)
 *   - Parses the new developer return (Step 6)
 *   - Builds 3 fresh review prompts (Step 7)
 *   - Spawns 3 reviewer subagents in parallel (Step 7b — LLM)
 *   - Aggregates the new verdict (Step 8)
 *
 * Pure-ish: the only side-effect is the LLM spawn calls, which go through
 * the injected spawner. Without a spawner the loop returns immediately.
 */
export async function iterateReviewLoop(
  opts: IterateReviewLoopOptions,
): Promise<IterateReviewLoopResult> {
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  let iteration = 1;
  let currentDev = opts.initialDeveloperReturn;
  let currentVerdict = opts.initialVerdict;

  if (opts.onIteration) {
    await opts.onIteration(iteration, currentVerdict);
  }

  while (iteration < maxIter && currentVerdict.decision === 'CHANGES_REQUESTED') {
    if (!opts.spawner) {
      // No spawner — caller is in Tier 1 prose mode; just return the current
      // state and let the slash command body drive the next iteration.
      break;
    }
    iteration++;

    const feedback = formatFeedback(currentVerdict.verdicts);
    const { prompt: devPrompt } = await buildDeveloperPrompt({
      taskId: opts.taskId,
      task: opts.task,
      branch: opts.branch,
      worktreePath: opts.worktreePath,
      reviewerFeedback: feedback,
      iteration,
    });

    const devResult = await opts.spawner.spawn({
      type: 'developer',
      prompt: devPrompt,
      cwd: opts.worktreePath,
    });
    // AISDLC-176 — retry once on JSON envelope contract violation. The
    // iteration loop honors the same retry contract as the initial Step
    // 5b/6 dispatch in execute-pipeline; without it a prose-only return
    // on iteration N>1 silently bails out of the loop with the previous
    // verdict (the bug the witnessed AISDLC-70 case exposed at the
    // initial dispatch is just as silent in the iterate path).
    // AISDLC-184 — forward onRetrySuccess to the optional caller-supplied
    // `onDeveloperContractRetry` so iteration-path recoveries land on the
    // same observability bus as the initial-dispatch ones (without it the
    // event undercounts drift on iteration N>1).
    const onRetrySuccess = opts.onDeveloperContractRetry;
    const parsedDev = await parseDeveloperReturnWithRetry({
      initialResult: devResult,
      cwd: opts.worktreePath,
      spawner: opts.spawner,
      ...(onRetrySuccess
        ? {
            onRetrySuccess: ({ initialOutputPreview, retryOutputPreview, durationMs }): void => {
              onRetrySuccess({
                taskId: opts.taskId,
                initialOutputPreview,
                retryOutputPreview,
                durationMs,
              });
            },
          }
        : {}),
    });
    if (!parsedDev.ok || !parsedDev.developer) {
      // Treat as developer failure; bail out of the loop with current verdict.
      break;
    }
    currentDev = parsedDev.developer;

    const { prompts } = await buildReviewPrompts({
      taskId: opts.taskId,
      task: opts.task,
      branch: opts.branch,
      worktreePath: opts.worktreePath,
      workDir: opts.worktreePath,
    });

    const reviewSpawn = await opts.spawner.spawnParallel(
      prompts.map((p) => ({ type: p.reviewer, prompt: p.prompt, cwd: opts.worktreePath })),
    );

    const newVerdicts: ReviewerVerdict[] = reviewSpawn.map((r: SubagentResult, i) =>
      coerceReviewerVerdict(REVIEWER_TYPES[i], r),
    );
    currentVerdict = await aggregateVerdicts({
      verdicts: newVerdicts,
      harnessNote: opts.initialVerdict.harnessNote,
    });

    if (opts.onIteration) {
      await opts.onIteration(iteration, currentVerdict);
    }
  }

  const needsHumanAttention =
    currentVerdict.decision === 'CHANGES_REQUESTED' && iteration >= maxIter;

  return {
    finalDeveloperReturn: currentDev,
    finalVerdict: currentVerdict,
    iterations: iteration,
    needsHumanAttention,
  };
}

/**
 * Convert a SubagentResult from the spawner into a structured ReviewerVerdict.
 * Handles both the `parsed: { approved, findings, summary }` shape and
 * the JSON-string-in-output fallback.
 *
 * Exported for unit tests.
 */
export function coerceReviewerVerdict(agentId: ReviewerType, r: SubagentResult): ReviewerVerdict {
  let parsed: unknown = r.parsed;
  if (parsed === undefined && typeof r.output === 'string') {
    try {
      parsed = JSON.parse(r.output);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      agentId,
      harness: 'claude-code',
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: `${agentId} returned no parseable verdict (status=${r.status}${
            r.error ? ', error=' + r.error : ''
          })`,
        },
      ],
    };
  }
  const obj = parsed as {
    approved?: unknown;
    findings?: unknown;
    summary?: unknown;
    harness?: unknown;
  };
  return {
    agentId,
    harness: typeof obj.harness === 'string' ? obj.harness : 'claude-code',
    approved: !!obj.approved,
    findings: Array.isArray(obj.findings) ? (obj.findings as ReviewerVerdict['findings']) : [],
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
  };
}
