/**
 * Tests for the AISDLC-147 patch 2 budget-exhaustion classifier
 * (`pipeline-cli/src/classifier/budget-classifier.ts`).
 *
 * What we cover (and why):
 *   - Per-reviewer rule (`classifyOneReviewer`) — happy verdict,
 *     budget-exhausted with both substrings present, budget-exhausted
 *     when only one substring is present (must NOT classify), other-failure
 *     for non-budget invalid JSON.
 *   - Aggregate rule (`classifyReviewerOutputs`) — AISDLC-157 broadened
 *     the gate from "all 3 budget-exhausted" to "≥1 budget-exhausted AND
 *     0 other-failure". Coverage spans the 5 canonical aggregate cases
 *     (3/3 budget, 2/3 budget + 1 ok, 2/3 budget + 1 other-failure,
 *     1/3 budget + 2 ok, all-ok), plus the partial-input regression guard.
 *   - Case-insensitivity — Anthropic occasionally returns the substring
 *     with different casing ("Credit balance is too low"); we match
 *     case-insensitively per the canonical Anthropic error body shape.
 *
 * Hermetic — no network, no I/O. The whole point of putting the classifier
 * in pipeline-cli is to land coverage here so the YAML stays a thin
 * adapter that just plumbs the decision into a github-script branch.
 */

import { describe, expect, it } from 'vitest';
import {
  BUDGET_EXHAUSTED_SUBSTRINGS,
  classifyOneReviewer,
  classifyReviewerOutputs,
  type ReviewerRawOutput,
} from './budget-classifier.js';

const validVerdict = (approved = true) =>
  JSON.stringify({
    approved,
    findings: [],
    summary: approved ? 'LGTM' : 'Found issues',
  });

const budgetExhaustedStderr = `
Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}
    at handleApiError (anthropic-sdk/error.js:42)
    at executeReview (orchestrator/dist/runtime/review.js:118)
`.trim();

describe('classifyOneReviewer', () => {
  it('returns ok when verdict line is a valid JSON verdict', () => {
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine: validVerdict(true),
      stderr: '',
    });
    expect(result).toBe('ok');
  });

  it('returns ok when verdict is approved=false (still well-formed)', () => {
    const result = classifyOneReviewer({
      type: 'critic',
      verdictLine: validVerdict(false),
      stderr: '',
    });
    expect(result).toBe('ok');
  });

  it('returns budget-exhausted when both substrings present in stderr', () => {
    const result = classifyOneReviewer({
      type: 'security',
      verdictLine: '',
      stderr: budgetExhaustedStderr,
    });
    expect(result).toBe('budget-exhausted');
  });

  it('case-insensitive match — "Credit balance is too low" with capitalized C still classifies', () => {
    const result = classifyOneReviewer({
      type: 'security',
      verdictLine: '',
      stderr: 'Error: invalid_request_error — Credit balance is too low.',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('returns other-failure when ONLY "invalid_request_error" present (no balance text)', () => {
    // Defends against false positives on schema-rejection bugs that aren't
    // budget-related — those should still surface CHANGES_REQUESTED.
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine: '',
      stderr: 'Error: 400 invalid_request_error: messages.0: too long',
    });
    expect(result).toBe('other-failure');
  });

  it('returns other-failure when ONLY "credit balance is too low" present (no error type)', () => {
    // Defensive: the error-type substring is the strong signal that this
    // came from an Anthropic API response body, not a stray log line.
    const result = classifyOneReviewer({
      type: 'critic',
      verdictLine: '',
      stderr: 'PR description mentions: my credit balance is too low to mint NFTs',
    });
    expect(result).toBe('other-failure');
  });

  it('returns other-failure for malformed JSON without budget signature', () => {
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine: '{ truncated json',
      stderr: 'TypeError: Cannot read properties of undefined',
    });
    expect(result).toBe('other-failure');
  });

  it('returns other-failure for empty verdict + empty stderr (reviewer crashed silently)', () => {
    const result = classifyOneReviewer({
      type: 'security',
      verdictLine: '',
      stderr: '',
    });
    expect(result).toBe('other-failure');
  });

  it('inspects verdictLine too — budget error written to stdout instead of stderr', () => {
    // The Anthropic SDK normally writes errors to stderr, but if the
    // reviewer wrapper logs the full error JSON to stdout we still
    // catch it. Belt-and-braces.
    const result = classifyOneReviewer({
      type: 'critic',
      verdictLine: budgetExhaustedStderr,
      stderr: '',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('rejects verdict-shaped JSON that is missing required fields', () => {
    // approved without findings should be other-failure (the existing
    // report parser would also reject it as "Invalid verdict schema").
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine: JSON.stringify({ approved: true }),
      stderr: '',
    });
    expect(result).toBe('other-failure');
  });

  // ---- AISDLC-149: cli-review packages API errors into valid verdicts ----

  it('AISDLC-149: returns budget-exhausted for valid verdict whose finding embeds the API error body', () => {
    // Real-world shape from CI run 25265922400 (PR #182): cli-review
    // caught the Anthropic API error and wrapped it into a well-formed
    // verdict with a critical finding. Original AISDLC-147 classifier
    // missed this and reported `ok`, posting CHANGES_REQUESTED.
    const verdictLine = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          message:
            'Review agent failed: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_abc123"}',
        },
      ],
      summary: 'testing review could not be completed',
    });
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine,
      stderr: '',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('AISDLC-149: returns ok when valid verdict has a non-budget critical finding (existing behavior preserved)', () => {
    // Defends the AND-of-two rule on the verdict-finding path too:
    // a critical finding about, say, a security issue must NOT be
    // misclassified as budget-exhausted just because the reviewer flagged
    // something serious.
    const verdictLine = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'SQL injection vulnerability in src/db.ts:42 — unsanitized user input',
        },
        {
          severity: 'major',
          message: 'Missing rate-limit on /api/login',
        },
      ],
      summary: 'security issues found',
    });
    const result = classifyOneReviewer({
      type: 'security',
      verdictLine,
      stderr: '',
    });
    expect(result).toBe('ok');
  });

  it('AISDLC-149: case-insensitive match inside a valid-verdict finding', () => {
    // The Anthropic body occasionally arrives with different casing; the
    // verdict-finding inspection path must match case-insensitively just
    // like the stdout/stderr path.
    const verdictLine = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'Anthropic returned INVALID_REQUEST_ERROR — Credit Balance Is Too Low.',
        },
      ],
      summary: 'agent failed',
    });
    const result = classifyOneReviewer({
      type: 'critic',
      verdictLine,
      stderr: '',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('AISDLC-149: returns ok when only ONE substring appears in a finding (AND-of-two enforced)', () => {
    // Mirrors the existing other-failure single-substring tests on the
    // valid-verdict path: a finding that mentions only `invalid_request_error`
    // (e.g. a real schema-validation failure surfaced by the reviewer) must
    // NOT be mistaken for budget exhaustion.
    const verdictLine = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'Anthropic API error 400 invalid_request_error: messages.0: too long',
        },
      ],
      summary: 'agent failed',
    });
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine,
      stderr: '',
    });
    expect(result).toBe('ok');
  });

  // ---- AISDLC-154: substring fallback uses WHOLE stdout, not last line ----

  it('AISDLC-154: multi-line pretty-printed verdict whose body has both budget substrings → budget-exhausted', () => {
    // The exact failure mode from PR #196 CI run 25267752415: cli-review
    // wrote pretty-printed multi-line JSON to /tmp/review-<type>.txt. The
    // CLI's `lastLine` extracts only `}`, which fails `tryParseVerdict`
    // (just a closing brace isn't a valid verdict). The original AISDLC-149
    // valid-verdict-finding inspection path is therefore SKIPPED, and the
    // substring fallback runs against `verdictLine + stderr` where
    // verdictLine is `}` and stderr is empty — missing the budget signature
    // that's sitting in the multi-line stdout body.
    //
    // With AISDLC-154, the CLI now passes the WHOLE stdout via stdoutRaw,
    // and the substring fallback inspects the entire body, catching the
    // signature.
    const stdoutRaw = `{
  "approved": false,
  "findings": [
    {
      "severity": "critical",
      "message": "Review agent failed: Anthropic API error 400: {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Your credit balance is too low to access the Anthropic API.\\"}}"
    }
  ],
  "summary": "review could not be completed"
}`;
    const result = classifyOneReviewer({
      type: 'testing',
      // lastLine of the multi-line JSON above is `}` — fails tryParseVerdict.
      verdictLine: '}',
      stdoutRaw,
      stderr: '',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('AISDLC-154: multi-line stdout with NON-budget critical finding → other-failure (no false positive)', () => {
    // Same multi-line shape (last line is `}`, verdict fails to parse), but
    // the body contains a regular critical finding — must NOT trip the
    // budget classifier.
    const stdoutRaw = `{
  "approved": false,
  "findings": [
    {
      "severity": "critical",
      "message": "SQL injection vulnerability in src/db.ts:42 — unsanitized user input"
    }
  ],
  "summary": "security issues found"
}`;
    const result = classifyOneReviewer({
      type: 'security',
      verdictLine: '}',
      stdoutRaw,
      stderr: '',
    });
    // verdictLine doesn't parse → falls into substring path → no budget
    // signature → other-failure (the existing CHANGES_REQUESTED safety net
    // surfaces the parse problem rather than silently swallowing it).
    expect(result).toBe('other-failure');
  });

  it('AISDLC-154: budget substrings split across DIFFERENT stdout lines → budget-exhausted (whole-stdout match)', () => {
    // Pathological case where the two substrings would each appear on
    // their own line. The original AISDLC-147 single-line check would have
    // missed this; the AISDLC-154 whole-stdout match catches it naturally
    // because the combined string spans every line.
    const stdoutRaw = [
      '[review/critic] starting…',
      'Anthropic API responded with invalid_request_error',
      'request_id: req_abc123',
      'message body: Your credit balance is too low to access the Anthropic API.',
      '}',
    ].join('\n');
    const result = classifyOneReviewer({
      type: 'critic',
      verdictLine: '}',
      stdoutRaw,
      stderr: '',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('AISDLC-154: stdoutRaw absent (back-compat) — falls back to verdictLine for substring match', () => {
    // Older callers / tests that don't supply `stdoutRaw` must still work:
    // the AISDLC-147 path inspected `verdictLine + stderr`, and with
    // stdoutRaw undefined we preserve that exact behavior.
    const result = classifyOneReviewer({
      type: 'testing',
      verdictLine: 'invalid_request_error: credit balance is too low',
      // intentionally no stdoutRaw — back-compat path
      stderr: '',
    });
    expect(result).toBe('budget-exhausted');
  });

  it('AISDLC-154: empty stdoutRaw + budget signature in stderr → budget-exhausted (existing AISDLC-147 path preserved)', () => {
    // The original failure mode where the Anthropic SDK aborts before
    // cli-review writes anything to stdout still has to work. stderr alone
    // must be enough.
    const result = classifyOneReviewer({
      type: 'security',
      verdictLine: '',
      stdoutRaw: '',
      stderr: budgetExhaustedStderr,
    });
    expect(result).toBe('budget-exhausted');
  });
});

describe('classifyReviewerOutputs (aggregate decision)', () => {
  const r = (
    type: ReviewerRawOutput['type'],
    verdictLine: string,
    stderr = '',
  ): ReviewerRawOutput => ({ type, verdictLine, stderr });

  it('all 3 budget-exhausted → skip-with-budget-comment (AC-2)', () => {
    const result = classifyReviewerOutputs([
      r('testing', '', budgetExhaustedStderr),
      r('critic', '', budgetExhaustedStderr),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('skip-with-budget-comment');
    expect(result.budgetExhaustedCount).toBe(3);
    expect(result.perReviewer.map((p) => p.classification)).toEqual([
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  it('all 3 ok → proceed-as-normal (happy path unchanged)', () => {
    const result = classifyReviewerOutputs([
      r('testing', validVerdict(true)),
      r('critic', validVerdict(true)),
      r('security', validVerdict(true)),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(0);
  });

  it('AISDLC-157 case 2: 2/3 budget-exhausted + 1/3 ok (AISDLC-141 classifier-skipped) → skip-with-budget-comment', () => {
    // Exact failing case from PR #202's analyze run (the bug AISDLC-157 fixes):
    // AISDLC-141 classifier selected [security, critic] and AUTO_APPROVED
    // testing. Both selected reviewers then failed with credit exhaustion.
    // Under the original AISDLC-147 "all 3 must be exhausted" rule this
    // fell through to proceed-as-normal and posted CHANGES_REQUESTED noise.
    // Under the AISDLC-157 rule the ok-stub is treated as success and the
    // remaining non-OK reviewers are uniformly budget-exhausted → skip.
    const result = classifyReviewerOutputs([
      r('testing', validVerdict(true)),
      r('critic', '', budgetExhaustedStderr),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('skip-with-budget-comment');
    expect(result.budgetExhaustedCount).toBe(2);
    expect(result.perReviewer.map((p) => p.classification)).toEqual([
      'ok',
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  it('AISDLC-157 case 3: 2/3 budget-exhausted + 1/3 other-failure → proceed-as-normal', () => {
    // The other-failure reviewer is a real signal we must surface (could
    // be a parse failure, a reviewer crash, or something else worth a
    // CHANGES_REQUESTED). Even with budget-exhausted reviewers in the
    // mix, the presence of ANY other-failure suppresses the skip branch.
    const result = classifyReviewerOutputs([
      r('testing', '{ broken'),
      r('critic', '', budgetExhaustedStderr),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(2);
    expect(result.perReviewer.map((p) => p.classification)).toEqual([
      'other-failure',
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  it('AISDLC-157 case 4: 1/3 budget-exhausted + 2/3 ok → skip-with-budget-comment', () => {
    // Partial budget exhaustion with the rest succeeding. The ok reviewers'
    // verdicts already capture the real assessment; the lone budget-exhausted
    // reviewer is just noise (we couldn't get a reading on that dimension).
    // Better to use the comment-skip branch than to overlay CHANGES_REQUESTED.
    const result = classifyReviewerOutputs([
      r('testing', validVerdict(true)),
      r('critic', validVerdict(false)),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('skip-with-budget-comment');
    expect(result.budgetExhaustedCount).toBe(1);
    expect(result.perReviewer.map((p) => p.classification)).toEqual([
      'ok',
      'ok',
      'budget-exhausted',
    ]);
  });

  it('AISDLC-157: mixed (1 budget + 2 other-failure) → proceed-as-normal', () => {
    const result = classifyReviewerOutputs([
      r('testing', '{ broken'),
      r('critic', '{ also broken'),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(1);
  });

  it('all 3 other-failure → proceed-as-normal (existing CHANGES_REQUESTED path)', () => {
    const result = classifyReviewerOutputs([
      r('testing', '{ broken'),
      r('critic', '{ also broken'),
      r('security', '{ third broken'),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(0);
  });

  it('partial input set (workflow regression — only 2 of 3 reviewers present) → proceed-as-normal even if both budget-exhausted', () => {
    // Documented safety: if the workflow's bash glue ever drops a
    // reviewer's output file, we'd see only 2 inputs both
    // budget-exhausted. Without this guard we'd silently skip with
    // success. We prefer surfacing the bug via CHANGES_REQUESTED.
    const result = classifyReviewerOutputs([
      r('testing', '', budgetExhaustedStderr),
      r('critic', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(2);
  });

  it('exposes both required substrings via BUDGET_EXHAUSTED_SUBSTRINGS', () => {
    // The workflow YAML references this constant indirectly (via the
    // imported classifier) — guard it so a future rename can't silently
    // weaken the match.
    expect(BUDGET_EXHAUSTED_SUBSTRINGS).toContain('credit balance is too low');
    expect(BUDGET_EXHAUSTED_SUBSTRINGS).toContain('invalid_request_error');
    expect(BUDGET_EXHAUSTED_SUBSTRINGS.length).toBe(2);
  });

  // ---- AISDLC-149: aggregate behavior with valid-verdict-budget-finding inputs ----

  it('AISDLC-149: all 3 reviewers report valid-verdict-budget-finding → skip-with-budget-comment', () => {
    // The exact scenario from CI run 25265922400 (PR #182): all 3
    // reviewers caught the API error and packaged it. Aggregate must
    // recognize the pattern and suppress CHANGES_REQUESTED.
    const budgetVerdict = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          message:
            'Review agent failed: Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
        },
      ],
      summary: 'review could not be completed',
    });
    const result = classifyReviewerOutputs([
      r('testing', budgetVerdict),
      r('critic', budgetVerdict),
      r('security', budgetVerdict),
    ]);
    expect(result.aggregate).toBe('skip-with-budget-comment');
    expect(result.budgetExhaustedCount).toBe(3);
  });

  it('AISDLC-149 + AISDLC-157: mixed (1 valid-budget + 1 valid-ok + 1 stderr-budget) → skip-with-budget-comment', () => {
    // Mixed-mode budget hits across the verdict-finding path AND the
    // stdout/stderr fallback path. Under the AISDLC-157 rule this is a
    // "≥1 budget + 0 other-failure" pattern — the ok reviewer captured
    // a real verdict and the two budget-exhausted reviewers are noise
    // we want to suppress.
    const budgetVerdict = JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'critical',
          message: 'Anthropic API error 400 invalid_request_error: Your credit balance is too low.',
        },
      ],
      summary: 'agent failed',
    });
    const result = classifyReviewerOutputs([
      r('testing', budgetVerdict),
      r('critic', validVerdict(true)),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('skip-with-budget-comment');
    expect(result.budgetExhaustedCount).toBe(2);
    expect(result.perReviewer.map((p) => p.classification)).toEqual([
      'budget-exhausted',
      'ok',
      'budget-exhausted',
    ]);
  });

  // ---- AISDLC-157: explicit coverage of the 5-case truth table ----
  // Some of the 5 cases overlap with existing tests above; we re-state them
  // here as a single dedicated block so future readers don't have to chase
  // them across the file. Naming convention mirrors the AISDLC-157 task file.

  it('AISDLC-157 case 1: 3/3 budget-exhausted → skip-with-budget-comment (existing behavior preserved)', () => {
    const result = classifyReviewerOutputs([
      r('testing', '', budgetExhaustedStderr),
      r('critic', '', budgetExhaustedStderr),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('skip-with-budget-comment');
    expect(result.budgetExhaustedCount).toBe(3);
  });

  it('AISDLC-157 case 5: 0 budget-exhausted (all ok) → proceed-as-normal (existing behavior preserved)', () => {
    const result = classifyReviewerOutputs([
      r('testing', validVerdict(true)),
      r('critic', validVerdict(true)),
      r('security', validVerdict(true)),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(0);
  });

  it('AISDLC-157 partial-input regression guard: only 2 of 3 reviewers present + both budget-exhausted → proceed-as-normal', () => {
    // The 3-input guard MUST still fire under the AISDLC-157 rule. A
    // partial input set is itself a workflow regression we want to
    // surface via CHANGES_REQUESTED rather than silently skip — even if
    // every reviewer we DID receive was budget-exhausted (which under
    // the new rule would otherwise satisfy ≥1-budget AND 0-other-failure).
    const result = classifyReviewerOutputs([
      r('testing', '', budgetExhaustedStderr),
      r('critic', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(2);
  });
});
