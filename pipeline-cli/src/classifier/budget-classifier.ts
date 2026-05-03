/**
 * Anthropic API budget-exhaustion classifier (AISDLC-147 patch 2;
 * AISDLC-149 added valid-verdict-finding inspection; AISDLC-154 widened
 * the substring fallback to use the WHOLE stdout instead of just the
 * last line).
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
 * AISDLC-149: in production we observed that `cli-review` actually CATCHES
 * the Anthropic API error and PACKAGES it into a well-formed verdict JSON
 * (with `approved: false` and a critical finding whose `message` embeds the
 * raw error body). The original AISDLC-147 classifier short-circuited on
 * any well-formed verdict and never looked at the finding contents — so
 * the budget signal was missed and CHANGES_REQUESTED still posted. The
 * classifier now also inspects each parsed verdict's findings for the
 * same two-substring signature.
 *
 * This module classifies each reviewer's outputs into one of three buckets
 * and returns an aggregate decision:
 *   - `ok`               — verdict parsed AND no finding carries the budget
 *                          signature; used as-is by the existing path
 *   - `budget-exhausted` — both required substrings present (case-insensitive)
 *                          either inside a parsed verdict's findings OR in
 *                          the combined stdout+stderr fallback
 *   - `other-failure`    — verdict didn't parse but isn't budget-related
 *
 * Aggregate decision rules (AISDLC-157 — broadened from the AISDLC-147
 * "all 3 must be budget-exhausted" rule):
 *   - At least one `budget-exhausted` AND zero `other-failure` →
 *     `skip-with-budget-comment` (post `Post Review Results: success`,
 *     idempotent comment, no review). i.e. every reviewer that DIDN'T succeed
 *     only failed due to budget. The `ok` reviewers' verdicts already
 *     capture the truth; the budget-exhausted ones are pure noise.
 *   - Anything else → `proceed-as-normal` (existing report path runs
 *     unchanged, including CHANGES_REQUESTED). This covers: zero
 *     budget-exhaustion, OR ANY `other-failure` present (a real failure
 *     exists — surface it).
 *
 * Why this rule (vs the original AISDLC-147 "all 3 exhausted" gate):
 *   AISDLC-141's classifier (LIVE in CI as of AISDLC-156) selectively skips
 *   reviewers and writes AUTO_APPROVED stub verdicts for the unselected
 *   ones. The budget classifier sees those stubs as `ok`. So a real
 *   credit-exhausted run with [security, critic] selected (testing
 *   AUTO_APPROVED) yields `[ok, budget-exhausted, budget-exhausted]` —
 *   which under the old AND-of-3 rule fell through to `proceed-as-normal`
 *   and posted CHANGES_REQUESTED noise the operator had to dismiss
 *   manually. The new "all NON-OK reviewers are budget-exhausted" rule
 *   handles this case correctly while still surfacing genuine failures.
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
   * emitting anything). Used for `tryParseVerdict` (the AISDLC-149 path).
   */
  verdictLine: string;
  /**
   * The reviewer's WHOLE stdout (entire contents of /tmp/review-<type>.txt),
   * not just the last line. Used by the substring fallback path when the
   * verdict failed to parse — AISDLC-154: `cli-review` writes pretty-printed
   * multi-line JSON when it captures an Anthropic API error, so the last
   * line is just `}` and the credit-exhaustion text lives in the body.
   * The substring fallback must inspect the whole stdout, not just the
   * verdict line, or it misses the budget signature entirely.
   *
   * Optional for back-compat with older callers, but the CI path always
   * supplies it.
   */
  stdoutRaw?: string;
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
  // AISDLC-157: previously "all 3 budget-exhausted"; broadened to "all NON-OK
  // reviewers are budget-exhausted" so the AISDLC-141 classifier-skipped
  // reviewer (AUTO_APPROVED stub → counted as `ok`) doesn't keep this branch
  // from firing on otherwise-uniform credit exhaustion.
  | 'skip-with-budget-comment' // ≥1 budget + 0 other-failure → no CHANGES_REQUESTED
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
 * `summary: string`). Returns the parsed verdict when well-formed (so callers
 * can introspect `findings` for embedded API-error packaging), or `null`
 * otherwise. A parsed verdict with `approved: false` is still "well-formed"
 * — it's the schema we care about, not the verdict's polarity.
 */
interface ParsedVerdict {
  approved: boolean;
  findings: Array<Record<string, unknown>>;
  summary: string;
}

function tryParseVerdict(verdictLine: string): ParsedVerdict | null {
  if (!verdictLine || verdictLine.trim().length === 0) return null;
  try {
    const v = JSON.parse(verdictLine) as Record<string, unknown>;
    if (
      typeof v.approved === 'boolean' &&
      Array.isArray(v.findings) &&
      typeof v.summary === 'string'
    ) {
      return v as unknown as ParsedVerdict;
    }
    return null;
  } catch {
    return null;
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
 * Test whether a parsed verdict's findings contain the budget-exhaustion
 * signature embedded in any finding's `message` field.
 *
 * The AISDLC-149 fix path: `cli-review` catches Anthropic API errors and
 * packages them into a well-formed verdict with `approved: false` and a
 * critical finding whose `message` includes the raw error body, e.g.:
 *
 *   {
 *     "approved": false,
 *     "findings": [{
 *       "severity": "critical",
 *       "message": "Review agent failed: Anthropic API error 400: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low...\"}}"
 *     }],
 *     "summary": "review could not be completed"
 *   }
 *
 * Without this check we'd accept the verdict as `ok` and miss the budget
 * signal entirely — which is the AISDLC-147 bug AISDLC-149 fixes. We use
 * the SAME `BUDGET_EXHAUSTED_SUBSTRINGS` constant as the stdout/stderr
 * path so the match rule stays in lock-step.
 *
 * Inspects all string-typed fields on each finding (typically `message`,
 * but defensive against future schema additions) — the substring test is
 * cheap and the false-positive surface is unchanged from the AND-of-two
 * rule.
 */
function verdictContainsBudgetSignature(verdict: ParsedVerdict): boolean {
  for (const finding of verdict.findings) {
    if (!finding || typeof finding !== 'object') continue;
    for (const value of Object.values(finding)) {
      if (typeof value === 'string' && isBudgetExhaustedFailure(value)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify a single reviewer's outcome into one of three buckets:
 *   - `ok`                 — verdict line parses as a valid verdict AND
 *                            no finding carries the budget signature
 *   - `budget-exhausted`   — EITHER (a) verdict parses but a finding's
 *                            message embeds both budget substrings (the
 *                            cli-review packaging path — AISDLC-149), OR
 *                            (b) verdict invalid AND combined whole-stdout
 *                            +stderr contains both budget substrings (the
 *                            AISDLC-147 path, widened by AISDLC-154 to use
 *                            the whole stdout instead of just the last line)
 *   - `other-failure`      — verdict invalid for some other reason (the
 *                            existing parser will surface it as a parsing
 *                            error in CHANGES_REQUESTED)
 *
 * Pure — no I/O. Exported for direct testing of the per-reviewer rule.
 */
export function classifyOneReviewer(input: ReviewerRawOutput): ReviewerClassification {
  const parsed = tryParseVerdict(input.verdictLine);
  if (parsed !== null) {
    // AISDLC-149: even a well-formed verdict can carry the budget
    // signature inside a finding's message when cli-review caught an
    // Anthropic API error and packaged it. Check before declaring ok.
    if (verdictContainsBudgetSignature(parsed)) {
      return 'budget-exhausted';
    }
    return 'ok';
  }
  // Verdict didn't parse — fall back to the AISDLC-147 stdout+stderr path.
  // AISDLC-154: when `cli-review` writes a pretty-printed multi-line JSON
  // verdict that fails this strict shape check (e.g. extra fields, or the
  // verdict line read by the CLI is just the closing `}` of multi-line
  // JSON), the credit-exhaustion text still lives somewhere in the WHOLE
  // stdout body, not just the last line. Prefer `stdoutRaw` (the entire
  // file contents) when supplied; fall back to `verdictLine` for older
  // callers that don't pass it. Stderr is always considered too — the
  // Anthropic SDK normally writes the API error body there on connection
  // failure paths that don't go through the cli-review wrapper.
  const stdoutForSubstring = input.stdoutRaw ?? input.verdictLine;
  const combined = `${stdoutForSubstring}\n${input.stderr}`;
  if (isBudgetExhaustedFailure(combined)) {
    return 'budget-exhausted';
  }
  return 'other-failure';
}

/**
 * Classify all 3 reviewer outputs and emit the aggregate decision the
 * report job branches on.
 *
 * Behaviour summary (AISDLC-157 — broadened from the AISDLC-147 "all 3
 * exhausted" gate so the AISDLC-141 conditional classifier doesn't break
 * the suppression branch when it AUTO_APPROVES an unselected reviewer):
 *   - ≥1 budget-exhausted AND 0 other-failure → `skip-with-budget-comment`
 *     (every reviewer that DIDN'T succeed only failed due to budget; the
 *     ok verdicts already capture the truth, the budget ones are noise)
 *   - 0 budget-exhausted (all ok or any other-failure-only mix) →
 *     `proceed-as-normal` (existing path unchanged)
 *   - ≥1 budget-exhausted AND ≥1 other-failure → `proceed-as-normal`
 *     (a real failure exists — surface it via CHANGES_REQUESTED)
 *
 * The relaxation is safe because `other-failure` already means "the
 * reviewer reported a real signal we can't suppress" and `ok` means "the
 * reviewer reported a verdict we want to surface as-is". The only mode
 * we suppress is "every non-success was budget exhaustion" — i.e.
 * nothing real is being silenced.
 *
 * The 3-reviewer-input guard is preserved: receiving fewer than 3 inputs
 * is a workflow regression and falls through to `proceed-as-normal` so
 * the existing CHANGES_REQUESTED safety net surfaces the bug rather than
 * silently passing.
 */
export function classifyReviewerOutputs(inputs: ReviewerRawOutput[]): BudgetClassification {
  // Defensive: the contract is "exactly 3 inputs" but we tolerate
  // shorter arrays (just classify what we got + emit `proceed-as-normal`
  // when the input set is partial, since a missing reviewer is itself a
  // bug we want to surface rather than silently suppress).
  const perReviewer: ClassifiedReviewer[] = inputs.map((input) => ({
    type: input.type,
    classification: classifyOneReviewer(input),
  }));
  const budgetExhaustedCount = perReviewer.filter(
    (r) => r.classification === 'budget-exhausted',
  ).length;
  const otherFailureCount = perReviewer.filter((r) => r.classification === 'other-failure').length;
  // AISDLC-157: skip when every NON-OK reviewer was budget-exhausted (i.e.
  // ≥1 budget + 0 other-failure). The 3-input guard still applies — a
  // partial input set is itself a regression and never warrants the skip
  // branch, even if the reviewers we DID receive were all budget-exhausted.
  const aggregate: AggregateDecision =
    inputs.length === 3 && budgetExhaustedCount > 0 && otherFailureCount === 0
      ? 'skip-with-budget-comment'
      : 'proceed-as-normal';
  return { perReviewer, aggregate, budgetExhaustedCount };
}
