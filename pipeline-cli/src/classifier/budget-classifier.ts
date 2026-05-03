/**
 * Anthropic API budget-exhaustion classifier (AISDLC-147 patch 2).
 *
 * The CI reviewer fan-out in `.github/workflows/ai-sdlc-review.yml`'s `analyze`
 * job spawns up to 3 reviewer agents (testing, critic, security) against
 * Anthropic's API. When the API key's credit balance hits $0, every reviewer
 * fails with HTTP 400 `invalid_request_error` carrying a body that includes
 * the substring "credit balance is too low". Without this classifier the
 * report job would parse three "Verdict not valid JSON" errors and post a
 * CHANGES_REQUESTED review on every PR — noise that masks real failures and
 * teaches operators to ignore the bot.
 *
 * This module classifies each reviewer's combined stdout+stderr into one of
 * three buckets and returns an aggregate decision:
 *   - `ok`               — verdict parsed, used as-is by the existing path
 *   - `budget-exhausted` — both required substrings present (case-insensitive)
 *   - `other-failure`    — verdict didn't parse but isn't budget-related
 *
 * Aggregate decision rules:
 *   - All three reviewers `budget-exhausted` → `skip-with-budget-comment`
 *     (post `Post Review Results: success`, idempotent comment, no review)
 *   - Anything else → `proceed-as-normal` (existing report path runs unchanged,
 *     including CHANGES_REQUESTED for partial failures since mixed could be
 *     transient and still warrants human attention)
 *
 * Why the AND-of-two-substrings match (vs. just one):
 *   "invalid_request_error" alone fires on schema-rejection bugs that are NOT
 *   budget-related (would suppress real CHANGES_REQUESTED). "credit balance
 *   is too low" alone could in principle appear in a reviewer's natural-language
 *   commentary on a PR (vanishingly unlikely but cheap to defend against).
 *   Both substrings together is the unambiguous Anthropic error-body signature.
 *
 * Hermetic — pure functions, no I/O. Tested at
 * `pipeline-cli/src/classifier/budget-classifier.test.ts`.
 *
 * @module budget-classifier
 */

/**
 * Per-reviewer raw inputs. The CI workflow merges stdout+stderr into a single
 * string per reviewer (concatenated with a separator) before passing it in,
 * so we don't need to inspect them separately — the substring match runs
 * against the union.
 */
export interface ReviewerRawOutput {
  /** Reviewer type — `testing`, `critic`, or `security`. */
  type: 'testing' | 'critic' | 'security';
  /**
   * The reviewer's verdict-line stdout (typically the last line of
   * /tmp/review-<type>.txt — what the existing parser already consumes).
   * Empty string when the reviewer produced no stdout (e.g. crashed before
   * emitting anything).
   */
  verdictLine: string;
  /**
   * The reviewer's stderr (entire contents of /tmp/review-<type>-stderr.txt).
   * The Anthropic SDK writes the API error body here on failure, including
   * the "credit balance is too low" substring we match against.
   */
  stderr: string;
}

/** Classification of a single reviewer's outcome. */
export type ReviewerClassification = 'ok' | 'budget-exhausted' | 'other-failure';

/** Per-reviewer classification result. */
export interface ClassifiedReviewer {
  type: ReviewerRawOutput['type'];
  classification: ReviewerClassification;
}

/** Top-level decision the report job acts on. */
export type AggregateDecision =
  | 'skip-with-budget-comment' // all 3 budget-exhausted → no CHANGES_REQUESTED
  | 'proceed-as-normal'; // existing path unchanged

/** Aggregate result returned by `classifyReviewerOutputs`. */
export interface BudgetClassification {
  /** Per-reviewer breakdown — preserved for the workflow's audit log. */
  perReviewer: ClassifiedReviewer[];
  /** Top-level decision that drives the report-job branch. */
  aggregate: AggregateDecision;
  /**
   * Count of budget-exhausted reviewers. Surfaced for the comment body's
   * "skipped N/3 reviewer agents" message + for the gate-test assertion.
   */
  budgetExhaustedCount: number;
}

/**
 * The two substrings whose simultaneous presence (case-insensitive) defines
 * an Anthropic budget-exhaustion failure. Exported so the workflow YAML's
 * audit log + the test fixtures can reference the canonical strings.
 */
export const BUDGET_EXHAUSTED_SUBSTRINGS = Object.freeze([
  'credit balance is too low',
  'invalid_request_error',
] as const);

/**
 * Try to parse the reviewer's verdict line as a valid JSON verdict (matching
 * the existing report-job schema: `approved: boolean`, `findings: array`,
 * `summary: string`). Returns `true` when the verdict is well-formed,
 * regardless of approved/changes-requested — both are "ok" outcomes from
 * the budget-classifier's perspective.
 */
function isValidVerdict(verdictLine: string): boolean {
  if (!verdictLine || verdictLine.trim().length === 0) return false;
  try {
    const v = JSON.parse(verdictLine) as Record<string, unknown>;
    return (
      typeof v.approved === 'boolean' && Array.isArray(v.findings) && typeof v.summary === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Test whether a string contains BOTH budget-exhaustion substrings
 * (case-insensitive). Both must be present — see module docstring for
 * the false-positive rationale.
 */
function isBudgetExhaustedFailure(combined: string): boolean {
  if (!combined) return false;
  const lower = combined.toLowerCase();
  return BUDGET_EXHAUSTED_SUBSTRINGS.every((needle) => lower.includes(needle));
}

/**
 * Classify a single reviewer's outcome into one of three buckets:
 *   - `ok`                 — verdict line parses as a valid verdict
 *   - `budget-exhausted`   — verdict invalid AND combined output contains
 *                            both budget-exhaustion substrings
 *   - `other-failure`      — verdict invalid for some other reason (the
 *                            existing parser will surface it as a parsing
 *                            error in CHANGES_REQUESTED)
 *
 * Pure — no I/O. Exported for direct testing of the per-reviewer rule.
 */
export function classifyOneReviewer(input: ReviewerRawOutput): ReviewerClassification {
  if (isValidVerdict(input.verdictLine)) {
    return 'ok';
  }
  // Inspect both stdout (verdict line, in case the SDK printed the API
  // error body to stdout instead of stderr) AND stderr.
  const combined = `${input.verdictLine}\n${input.stderr}`;
  if (isBudgetExhaustedFailure(combined)) {
    return 'budget-exhausted';
  }
  return 'other-failure';
}

/**
 * Classify all 3 reviewer outputs and emit the aggregate decision the
 * report job branches on.
 *
 * Behaviour summary (mirrors the AC list on the AISDLC-147 task file):
 *   - All 3 budget-exhausted → `skip-with-budget-comment`
 *   - Anything else (all-ok, mixed budget+ok, mixed budget+other-failure,
 *     all-other-failure) → `proceed-as-normal`
 *
 * The "all 3 must be budget-exhausted" gate is intentional. Mixed failures
 * could be a transient outage on the API side affecting one reviewer's
 * connection, in which case the operator still wants the surviving
 * reviewer's verdict to surface as CHANGES_REQUESTED. Only a uniform
 * budget-exhaustion across all 3 is the unambiguous "API key is dead"
 * signal that warrants suppressing the noisy CHANGES_REQUESTED.
 */
export function classifyReviewerOutputs(inputs: ReviewerRawOutput[]): BudgetClassification {
  // Defensive: the contract is "exactly 3 inputs" but we tolerate
  // shorter arrays (just classify what we got + emit `proceed-as-normal`
  // unless ALL reviewers are budget-exhausted, which requires at least
  // 3 to be conservative).
  const perReviewer: ClassifiedReviewer[] = inputs.map((input) => ({
    type: input.type,
    classification: classifyOneReviewer(input),
  }));
  const budgetExhaustedCount = perReviewer.filter(
    (r) => r.classification === 'budget-exhausted',
  ).length;
  // The gate is "all reviewers AND we received a full 3-reviewer set".
  // Receiving fewer than 3 inputs is a workflow regression — fall through
  // to `proceed-as-normal` so the existing CHANGES_REQUESTED safety net
  // surfaces the bug rather than silently passing.
  const aggregate: AggregateDecision =
    inputs.length === 3 && budgetExhaustedCount === 3
      ? 'skip-with-budget-comment'
      : 'proceed-as-normal';
  return { perReviewer, aggregate, budgetExhaustedCount };
}
