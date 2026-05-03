---
id: AISDLC-149
title: >-
  Fix budget classifier — detect Anthropic budget exhaustion when cli-review
  packages the API error into a valid verdict's findings
status: Done
assignee: []
created_date: '2026-05-02 17:50'
labels:
  - ci
  - cost-optimization
  - bug
dependencies:
  - AISDLC-147
references:
  - pipeline-cli/src/classifier/budget-classifier.ts
  - pipeline-cli/src/classifier/budget-classifier.test.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The AISDLC-147 Anthropic budget circuit breaker doesn't fire in production because of a wrong assumption about how `cli-review` reports failures.

The classifier's `classifyOneReviewer` function checks `isValidVerdict(verdictLine)` first — if the verdict JSON parses cleanly, it returns `'ok'`. But `cli-review` (the reviewer agent invocation) catches Anthropic API errors and **packages them into a valid verdict JSON** like:

```json
{
  "approved": false,
  "findings": [
    {
      "severity": "critical",
      "message": "Review agent failed: Anthropic API error 400: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low to access the Anthropic API. ...\"},\"request_id\":\"...\"}"
    }
  ],
  "summary": "testing review could not be completed"
}
```

This passes `isValidVerdict()` (`approved: boolean`, `findings: array`, `summary: string`) → classified as `'ok'` → never matches budget signature → circuit breaker never fires → CHANGES_REQUESTED gets posted → operator manually dismisses on every PR.

Verified by inspection of CI run 25265922400 (PR #182): budget classifier reported `aggregate=proceed-as-normal exhausted=0/3` even though all 3 reviewers had the credit-exhaustion error in their findings.

### Fix

Modify `classifyOneReviewer` to ALSO check the parsed verdict's findings for the budget-exhaustion signature. New `verdictContainsBudgetSignature` helper scans every string-typed value on each finding (typically `message`) using the SAME `BUDGET_EXHAUSTED_SUBSTRINGS` constant (AND-of-two, case-insensitive) so the rule stays in lock-step with the stdout/stderr fallback path.

Final per-reviewer rule:
1. Try to parse verdictLine as JSON verdict
2. If parsed:
   - If any finding's string fields contain BOTH budget substrings (case-insensitive) → `'budget-exhausted'`
   - Otherwise → `'ok'`
3. If not parsed (existing path):
   - Combined stdout+stderr matches both substrings → `'budget-exhausted'`
   - Otherwise → `'other-failure'`

## Acceptance criteria

1. `classifyOneReviewer` returns `'budget-exhausted'` for a valid verdict whose finding `message` contains both budget substrings
2. `classifyOneReviewer` still returns `'ok'` for a valid verdict with non-budget critical findings (existing behavior preserved)
3. Aggregate: 3/3 reviewers with valid-verdict-budget-finding → `'skip-with-budget-comment'`
4. Aggregate: mixed (1 valid-budget + 1 valid-ok + 1 stderr-budget) → `'proceed-as-normal'`
5. Edge: case-insensitive match in finding message
6. Edge: only one substring in finding (`invalid_request_error` alone) → still `'ok'` per the AND-of-two rule
7. New helper `verdictContainsBudgetSignature` references the SAME `BUDGET_EXHAUSTED_SUBSTRINGS` constant (no string duplication)
8. Hermetic Vitest test in `pipeline-cli/src/classifier/budget-classifier.test.ts` (no network, no I/O)

## Out of scope

- Re-running the budget classifier against historical PR failures (one-off cleanup, not a code change)
- Adding a third "embedded API error" detection signature beyond the existing two-substring rule (separate task if Anthropic introduces a new error shape)
- Refactoring `cli-review`'s error-packaging behavior — that's the upstream wrapper, not the classifier's concern
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Fixed the AISDLC-147 budget classifier's blind spot: when `cli-review` catches an Anthropic API error and packages it into a well-formed verdict JSON (with `approved: false` + a critical finding embedding the raw error body), `classifyOneReviewer` short-circuited on the verdict's well-formed shape and never inspected the finding contents — so budget-exhaustion was silently misclassified as `'ok'` and CHANGES_REQUESTED still posted on every PR. Now the classifier inspects every parsed verdict's findings using the SAME two-substring signature already used on the stdout/stderr fallback path.

## Changes
- `pipeline-cli/src/classifier/budget-classifier.ts` (modified): renamed `isValidVerdict` → `tryParseVerdict` (now returns the parsed verdict so callers can introspect findings), added `verdictContainsBudgetSignature` helper, extended `classifyOneReviewer` to call it before declaring `'ok'`. Updated module docstring to explain the AISDLC-149 path.
- `pipeline-cli/src/classifier/budget-classifier.test.ts` (modified): added 7 new tests — real-world packaged-verdict shape, AND-of-two preservation in findings, case-insensitive match, single-substring rejection, plus 2 aggregate scenarios (3/3 packaged → `skip-with-budget-comment`; mixed verdict-finding + stderr → `proceed-as-normal`).

## Design decisions
- **Reuse `BUDGET_EXHAUSTED_SUBSTRINGS` constant**: a single source of truth for the match strings means future updates land in one place and the verdict-finding path can never drift from the stdout/stderr path.
- **Scan ALL string-typed values on each finding** (not just `message`): defensive against future schema additions (e.g. a `details` or `evidence` field) — the AND-of-two rule keeps the false-positive surface unchanged.
- **Preserve `tryParseVerdict` returning `null` on schema mismatch**: the old report parser still rejects malformed verdicts; this keeps that contract while making the parsed shape available for finding inspection.
- **Mixed-mode (1 valid-budget + 1 valid-ok + 1 stderr-budget) still aggregates to `proceed-as-normal`**: matches the AISDLC-147 design intent — only uniform 3/3 budget-exhaustion is the unambiguous "API key is dead" signal.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 981 tests pass (23 in budget-classifier, up from 16)
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- (none) — the fix is self-contained. The next time a CI reviewer fan-out hits credit exhaustion, the classifier will now detect it whether the error arrives as raw stderr or pre-packaged in a valid verdict's findings.
<!-- SECTION:FINAL_SUMMARY:END -->
