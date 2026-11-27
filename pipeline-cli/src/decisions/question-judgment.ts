/**
 * Checks 2 and 3 of the operator-question gate (AISDLC-1443).
 *
 * The plugin's `AskUserQuestion` PreToolUse hook asks, through
 * `cli-judgment question-gate`, two Group A judgments about the question a
 * session is about to put to the operator:
 *
 *  - check 2, `decision.duplicate`: is it already answered by a decision record
 *    on `origin/main`? The deterministic edit-distance shortlist
 *    (`shortlistDuplicates`, reused from Stage A) runs first and the judgment
 *    only confirms a shortlisted pair (RFC-0049 section 1 ordering);
 *  - check 3, `decision.reversibility`: is it a class (a)/(b) decision the
 *    session may take itself?
 *
 * Both judgments are in `shadow` until their promotion record exists, so the
 * evaluator returns `abstain` for them. The answers still come back in the
 * evaluation record, and the outcome the definition would have composed is
 * reported as `shadow`, so the gate can log a would-deny. Nothing here ever
 * answers a question on the operator's behalf.
 *
 * @module decisions/question-judgment
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decisionDuplicateDefinition,
  decisionReversibilityDefinition,
  evaluateJudgment,
  type EvaluateJudgmentContext,
  type JudgmentDefinition,
  type JudgmentEvaluationRecord,
  type JudgmentMode,
} from '@ai-sdlc/reference';

import type { Decision } from './decision-record.js';
import { shortlistDuplicates } from './judged.js';
import { listDecisions } from './projection.js';

/** The question as the gate hands it over: question text(s) and the option labels. */
export interface OperatorQuestion {
  summary: string;
  options: { id: string; description: string }[];
}

/** One judgment's result, as the gate needs it. */
export interface QuestionCheckResult<D> {
  judgmentId: string;
  /** Effective mode the evaluation ran in (`off` when the layer is disabled). */
  mode: JudgmentMode;
  /** What the evaluator returned. In `shadow` this is always `abstain`. */
  outcome: 'act' | 'abstain' | 'escalate';
  reason?: string;
  /** The decision of an `act` outcome. */
  decision?: D;
  /** In `shadow`: what the definition would have composed from the answers it got. */
  shadow?: { outcome: 'act' | 'abstain' | 'escalate'; decision?: D };
  /** `<judgmentId>@<stateHash>`, or null when nothing was sent. */
  basis: string | null;
}

/** The answered decision on main a duplicate verdict points at. */
export interface DuplicateMatch {
  id: string;
  option: string | null;
  optionDescription: string | null;
  summary: string;
}

export interface QuestionJudgment {
  /** Absent when nothing was shortlisted (no judgment request was made). */
  duplicate?: QuestionCheckResult<{ duplicateOf: string | null }> & { match?: DuplicateMatch };
  /** Absent when the caller skipped it (a class-(c) question). */
  reversibility?: QuestionCheckResult<'reversible' | 'one-way' | 'unknown'>;
}

export interface JudgeQuestionOptions {
  /** Only `'backlog'` lets a judgment decide in the permissive direction. */
  sourceKind?: string;
  /** Skip check 3 (the gate never lets check 3 deny a class-(c) question). */
  skipReversibility?: boolean;
}

/**
 * Answered decisions on `ref` (default `origin/main`). The decision store at
 * the ref is extracted with `git archive` into a temporary directory and
 * projected with the normal reader, so nothing local (an unmerged event) can
 * become a candidate. A missing ref or any git failure yields no candidates.
 */
export function readAnsweredDecisionsAtRef(workDir: string, ref = 'origin/main'): Decision[] {
  let tmp: string | undefined;
  try {
    const tar = execFileSync('git', ['archive', '--format=tar', ref, '.ai-sdlc/_decisions'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
    tmp = mkdtempSync(join(tmpdir(), 'question-gate-'));
    execFileSync('tar', ['-x', '-C', tmp], { input: tar, stdio: ['pipe', 'ignore', 'ignore'] });
    return listDecisions({ workDir: tmp }).decisions.filter(
      (d) => d.status.lifecycle === 'answered',
    );
  } catch {
    return [];
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

type Kind = 'act' | 'abstain' | 'escalate';

async function evaluateCapturing<I, D>(
  definition: JudgmentDefinition<I, D>,
  input: I,
  ctx: EvaluateJudgmentContext,
  sourceKind: string | undefined,
): Promise<QuestionCheckResult<D>> {
  let rec: JudgmentEvaluationRecord | undefined;
  const outcome = await evaluateJudgment(definition, input, {
    ...ctx,
    ...(sourceKind ? { sourceKind } : {}),
    sinks: [...(ctx.sinks ?? []), { record: (r) => void (rec = r) }],
  });
  const result: QuestionCheckResult<D> = {
    judgmentId: definition.id,
    mode: rec?.mode ?? 'off',
    outcome: outcome.kind as Kind,
    basis: rec?.stateHash ? `${definition.id}@${rec.stateHash}` : null,
  };
  if (outcome.kind === 'act') result.decision = outcome.decision;
  else if ('reason' in outcome && typeof outcome.reason === 'string')
    result.reason = outcome.reason;
  if (outcome.kind === 'abstain' && outcome.reason === 'shadow' && rec?.answers) {
    const thresholds =
      (rec.providerModelKey
        ? ctx.config.judgments[definition.id]?.thresholds[rec.providerModelKey]
        : undefined) ?? {};
    try {
      const would = definition.compose(rec.answers, input, thresholds, {
        permissiveAllowed: definition.direction === 'bidirectional' && sourceKind === 'backlog',
      });
      result.shadow = {
        outcome: would.kind as Kind,
        ...(would.kind === 'act' ? { decision: would.decision } : {}),
      };
    } catch {
      // a definition that cannot compose leaves no shadow verdict
    }
  }
  return result;
}

/**
 * Ask checks 2 and 3 about one question. Both requests are sent together; any
 * failure inside the layer comes back as an `abstain`, so this never throws.
 */
export async function judgeOperatorQuestion(
  question: OperatorQuestion,
  answered: readonly Decision[],
  ctx: EvaluateJudgmentContext,
  opts: JudgeQuestionOptions = {},
): Promise<QuestionJudgment> {
  const probe = {
    metadata: { id: '(question)' },
    spec: { summary: question.summary },
  } as unknown as Decision;
  const shortlist = shortlistDuplicates(probe, answered);
  const [duplicate, reversibility] = await Promise.all([
    shortlist.length > 0
      ? evaluateCapturing(
          decisionDuplicateDefinition,
          {
            summary: question.summary,
            candidates: shortlist.map((c) => ({ id: c.id, summary: c.summary })),
          },
          ctx,
          opts.sourceKind,
        )
      : undefined,
    opts.skipReversibility
      ? undefined
      : evaluateCapturing(
          decisionReversibilityDefinition,
          { summary: question.summary, options: question.options },
          ctx,
          opts.sourceKind,
        ),
  ]);

  const out: QuestionJudgment = {};
  if (duplicate) {
    const id = duplicate.decision?.duplicateOf ?? duplicate.shadow?.decision?.duplicateOf ?? null;
    const hit = id ? answered.find((d) => d.metadata.id === id) : undefined;
    out.duplicate = hit
      ? {
          ...duplicate,
          match: {
            id: hit.metadata.id,
            option: hit.status.answeredOptionId ?? null,
            optionDescription:
              hit.spec.options.find((o) => o.id === hit.status.answeredOptionId)?.description ??
              null,
            summary: hit.spec.summary,
          },
        }
      : duplicate;
  }
  if (reversibility) out.reversibility = reversibility;
  return out;
}
