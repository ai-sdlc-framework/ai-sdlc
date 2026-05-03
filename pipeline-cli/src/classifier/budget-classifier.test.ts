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
});
