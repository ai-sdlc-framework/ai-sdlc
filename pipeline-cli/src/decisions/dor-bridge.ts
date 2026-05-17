/**
 * RFC-0035 Phase 4 — DoR-to-Decision bridge.
 *
 * Converts a `RefinementVerdict` from the RFC-0011 DoR clarification flow
 * into `Decision` records in the catalog. Each clarification question in
 * the verdict becomes a separate `decision-opened` event with
 * `source: 'dor-clarification'`.
 *
 * ## Acceptance criteria wired here
 *
 * - AC#1: DoR clarification rounds emit Decision records into the catalog.
 * - AC#2: Each clarification question becomes a Decision with question,
 *   options, recommendation (options are the standard DoR resolution paths;
 *   the `summary` carries the verbatim clarification question).
 * - AC#3: Operator answers feed back into Decision resolution via
 *   `resolveDoRDecision()` which appends `operator-answered` events (the
 *   projection folds those into `lifecycle: 'answered'`).
 * - AC#4: Backwards-compatible — when `AI_SDLC_DECISION_CATALOG` is off,
 *   `emitDorDecisions()` returns `{ enabled: false }` without touching the
 *   event log; the DoR substrate is entirely unchanged.
 *
 * @module decisions/dor-bridge
 */

import { decisionCatalogDisabledMessage, isDecisionCatalogEnabled } from './feature-flag.js';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  nextDecisionId,
  type AnswerDecisionInput,
  type ReadEventsOpts,
} from './event-log.js';
import type { DecisionOption } from './decision-record.js';
import type { RefinementVerdict } from '../dor/types.js';

// ── Standard DoR-clarification option set ────────────────────────────────────

/**
 * Standard resolution options for every DoR-sourced Decision.
 *
 * Per RFC-0035 §4.1, the option set defines the operator's resolution paths.
 * DoR clarification Decisions always offer these three paths:
 *
 * - `provide-answer` — author fills in the missing information and the
 *   issue re-runs through DoR on the next check cycle.
 * - `bypass-gate` — operator accepts the issue as-is and documents the
 *   rationale; logged to the calibration corpus.
 * - `reject-issue` — issue is closed as not-ready (out of scope, invalid,
 *   or not actionable); author notified.
 */
export function dorClarificationOptions(): DecisionOption[] {
  return [
    {
      id: 'provide-answer',
      description:
        'Author provides the requested clarification so the issue can proceed through DoR',
      consequences: [
        'Issue re-evaluated by DoR gate after author updates it',
        'Gate unblocked on next DoR check cycle',
      ],
    },
    {
      id: 'bypass-gate',
      description: 'Operator accepts the issue as-is and bypasses this DoR gate',
      consequences: [
        'Issue proceeds without clarification; bypass logged to calibration corpus',
        'Reviewer agents evaluate against the unmodified issue',
      ],
    },
    {
      id: 'reject-issue',
      description: 'Reject the issue as out of scope, invalid, or not actionable',
      consequences: [
        'Issue closed as not-ready; author notified',
        'Counts as a negative calibration data point for the DoR rubric',
      ],
    },
  ];
}

// ── Emit (write path) ────────────────────────────────────────────────────────

export interface EmitDorDecisionsOpts extends ReadEventsOpts {
  /**
   * Scope reference for the DoR clarification context.
   * Examples: `'issue:AISDLC-285'`, `'github-issue:gh#42'`.
   * Defaults to `'issue:<verdict.issueId>'` when omitted.
   */
  issueScope?: string;
  /** Optional timestamp override (tests). */
  now?: Date;
  /** Optional `process.env` override for feature-flag check (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface EmitDorDecisionsResult {
  /** Whether the Decision Catalog feature flag was on. */
  enabled: boolean;
  /** Number of Decision records emitted (one per clarification question). */
  emitted: number;
  /** DEC-NNNN ids of the emitted decisions, in clarification-question order. */
  decisionIds: string[];
  /**
   * Informational message when the feature flag is off (AC#4 degrade-open).
   * Undefined when `enabled` is true.
   */
  disabledReason?: string;
}

/**
 * Emit Decision records for every clarification question in a DoR verdict.
 *
 * ### Feature-flag behaviour (AC#4 — backwards-compatible)
 * When `AI_SDLC_DECISION_CATALOG` is off: returns
 * `{ enabled: false, emitted: 0, decisionIds: [] }` without touching the
 * event log. The DoR substrate (`evaluateIssueE2E`, `renderClarificationComment`,
 * the comment-loop) is entirely unaffected.
 *
 * ### When the verdict is `admit` or has no questions
 * Returns `{ enabled: true, emitted: 0, decisionIds: [] }`. Nothing is
 * written — the bridge is a no-op on passing issues.
 *
 * ### When the verdict is `needs-clarification` with questions
 * Writes one `decision-opened` event per question (AC#1). Each event gets:
 * - `source: 'dor-clarification'`
 * - `summary`: the verbatim clarification question (AC#2)
 * - `body`: context paragraph linking back to the issue + verdict
 * - `options`: the standard three DoR resolution paths (AC#2)
 * - `reversible: true` (per OQ-3/12: DoR clarification answers are reversible)
 */
export function emitDorDecisions(
  verdict: RefinementVerdict,
  opts: EmitDorDecisionsOpts = {},
): EmitDorDecisionsResult {
  if (!isDecisionCatalogEnabled(opts.env ?? process.env)) {
    return {
      enabled: false,
      emitted: 0,
      decisionIds: [],
      disabledReason: decisionCatalogDisabledMessage(),
    };
  }

  const questions = verdict.questions ?? [];
  if (questions.length === 0) {
    return { enabled: true, emitted: 0, decisionIds: [] };
  }

  const scope = opts.issueScope ?? `issue:${verdict.issueId}`;
  const logOpts: ReadEventsOpts = { workDir: opts.workDir, filePath: opts.filePath };
  const options = dorClarificationOptions();
  const decisionIds: string[] = [];

  for (const question of questions) {
    const decisionId = nextDecisionId(logOpts);
    const event = makeDecisionOpenedEvent({
      decisionId,
      source: 'dor-clarification',
      scope,
      summary: question,
      body:
        `DoR clarification required for \`${verdict.issueId}\` ` +
        `(verdict: ${verdict.overallVerdict}, rubric: ${verdict.rubricVersion}, ` +
        `evaluator: ${verdict.evaluatorVersion}). ` +
        `Resolve this question to unblock the issue from DoR admission.`,
      reversible: true,
      options,
      now: opts.now,
    });
    appendDecisionEvent(event, logOpts);
    decisionIds.push(decisionId);
  }

  return { enabled: true, emitted: decisionIds.length, decisionIds };
}

// ── Resolve (operator-answer write path, AC#3) ───────────────────────────────

export interface ResolveDorDecisionOpts extends ReadEventsOpts {
  /** Actor email / login identifier of who resolved the question. */
  by?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface ResolveDorDecisionResult {
  enabled: boolean;
  decisionId: string;
  chosenOptionId: string;
  /** Path where the `operator-answered` event was appended. */
  path: string;
  disabledReason?: string;
}

/**
 * Record an operator answer for a DoR-sourced Decision (AC#3).
 *
 * Appends an `operator-answered` event to the log. The projection folds
 * this into `status.lifecycle = 'answered'` + `answeredOptionId` so the
 * resolved Decision is queryable via `cli-decisions show <id>`.
 *
 * Degrades open (returns `enabled: false`) when the feature flag is off,
 * consistent with AC#4.
 */
export function resolveDorDecision(
  decisionId: string,
  chosenOptionId: string,
  opts: ResolveDorDecisionOpts = {},
): ResolveDorDecisionResult {
  if (!isDecisionCatalogEnabled(opts.env ?? process.env)) {
    return {
      enabled: false,
      decisionId,
      chosenOptionId,
      path: '',
      disabledReason: decisionCatalogDisabledMessage(),
    };
  }

  const input: AnswerDecisionInput = { decisionId, chosenOptionId };
  if (opts.by !== undefined) input.by = opts.by;
  if (opts.now !== undefined) input.now = opts.now;

  const event = makeOperatorAnsweredEvent(input);
  const logOpts: ReadEventsOpts = { workDir: opts.workDir, filePath: opts.filePath };
  const path = appendDecisionEvent(event, logOpts);

  return { enabled: true, decisionId, chosenOptionId, path };
}
