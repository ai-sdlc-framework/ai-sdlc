/**
 * Tests for the AISDLC-147 patch 2 budget-exhaustion classifier
 * (`pipeline-cli/src/classifier/budget-classifier.ts`).
 *
 * What we cover (and why):
 *   - Per-reviewer rule (`classifyOneReviewer`) — happy verdict,
 *     budget-exhausted with both substrings present, budget-exhausted
 *     when only one substring is present (must NOT classify), other-failure
 *     for non-budget invalid JSON.
 *   - Aggregate rule (`classifyReviewerOutputs`) — all-3-budget triggers
 *     `skip-with-budget-comment`, mixed (1 ok + 2 budget) preserves
 *     `proceed-as-normal`, all-3-ok stays `proceed-as-normal`, partial
 *     input set (workflow regression) falls through to `proceed-as-normal`.
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

  it('mixed (2 budget + 1 ok) → proceed-as-normal (AC-3 — could be transient)', () => {
    const result = classifyReviewerOutputs([
      r('testing', validVerdict(true)),
      r('critic', '', budgetExhaustedStderr),
      r('security', '', budgetExhaustedStderr),
    ]);
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(2);
  });

  it('mixed (1 budget + 2 other-failure) → proceed-as-normal', () => {
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

  it('AISDLC-149: mixed (1 valid-budget + 1 valid-ok + 1 stderr-budget) → proceed-as-normal', () => {
    // Mixed-mode budget hits across the verdict-finding path AND the
    // stdout/stderr fallback path still aggregate to proceed-as-normal
    // (mixed could be transient — only uniform 3/3 budget-exhaustion
    // warrants suppression).
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
    expect(result.aggregate).toBe('proceed-as-normal');
    expect(result.budgetExhaustedCount).toBe(2);
    expect(result.perReviewer.map((p) => p.classification)).toEqual([
      'budget-exhausted',
      'ok',
      'budget-exhausted',
    ]);
  });
});
