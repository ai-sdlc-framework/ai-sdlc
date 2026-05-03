---
id: AISDLC-157
title: >-
  Fix budget classifier aggregate — suppress CHANGES_REQUESTED when only NON-OK
  reviewers are budget-exhausted (handles AISDLC-141 classifier-skipped stubs)
status: Done
assignee: []
created_date: '2026-05-02 21:00'
labels:
  - ci
  - cost-optimization
  - bug
dependencies:
  - AISDLC-147
  - AISDLC-141
  - AISDLC-156
references:
  - pipeline-cli/src/classifier/budget-classifier.ts
  - pipeline-cli/src/classifier/budget-classifier.test.ts
  - pipeline-cli/src/cli/classify-budget.test.ts
  - .github/workflows/ai-sdlc-review.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-147's budget circuit breaker rule was: `aggregate = 'skip-with-budget-comment'` only when ALL 3 reviewers are budget-exhausted. Anything else (mixed or single failures) → `'proceed-as-normal'` (post CHANGES_REQUESTED).

That rule was conservative-by-design — "mixed failures could be transient outages on the API side affecting one reviewer's connection; only uniform exhaustion is the unambiguous signal."

But that conservatism doesn't account for AISDLC-141's classifier (which only became LIVE in CI yesterday after AISDLC-156 — see PR #202). When the classifier correctly skips a reviewer (e.g., picks `[security, critic]` and skips `testing`), the workflow writes an AUTO_APPROVED stub verdict for the unselected reviewer. The budget classifier then sees that verdict as `'ok'` and counts it as not-budget-exhausted.

### Concrete failing case (PR #202's own analyze run, after AISDLC-156 made the classifier engage)

- Classifier selects `[security, critic]`; testing gets AUTO_APPROVED stub
- security + critic both fail with credit exhaustion
- Budget classifier: `perReviewer = [{testing: ok}, {critic: budget-exhausted}, {security: budget-exhausted}]`, `budgetExhaustedCount = 2`, `aggregate = 'proceed-as-normal'` (because the AND-of-3 gate doesn't match)
- CHANGES_REQUESTED still gets posted → operator manually dismisses

### Fix

Change the aggregate rule from "all 3 exhausted" to "all NON-OK reviewers are budget-exhausted." In code:

```typescript
// Before (in budget-classifier.ts classifyReviewerOutputs):
aggregate: budgetExhaustedCount === 3 ? 'skip-with-budget-comment' : 'proceed-as-normal'

// After:
const otherFailureCount = perReviewer.filter(r => r.classification === 'other-failure').length;
aggregate: budgetExhaustedCount > 0 && otherFailureCount === 0
  ? 'skip-with-budget-comment'
  : 'proceed-as-normal'
```

**Intuition**: if every reviewer that DIDN'T succeed only failed due to budget, we have nothing real to surface — suppress. If even ONE reviewer reported a real failure (other-failure category), still post CHANGES_REQUESTED so the operator sees real signal.

### Truth table (5 canonical cases)

| Case | budgetExhausted | otherFailure | ok | aggregate | rationale |
|---|---|---|---|---|---|
| 1 | 3 | 0 | 0 | `skip-with-budget-comment` | existing AISDLC-147 behavior preserved |
| 2 | 2 | 0 | 1 | `skip-with-budget-comment` | **new** — fixes AISDLC-141+budget interaction |
| 3 | 2 | 1 | 0 | `proceed-as-normal` | other-failure carries real signal — surface it |
| 4 | 1 | 0 | 2 | `skip-with-budget-comment` | **new** — partial budget exhaustion; the ok verdicts already capture truth |
| 5 | 0 | * | * | `proceed-as-normal` | nothing to suppress |

The 3-input regression guard is preserved: a partial input set (fewer than 3 reviewers) never satisfies the skip branch even if every received reviewer was budget-exhausted, because that's itself a workflow bug we want surfaced.

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `classifyReviewerOutputs` aggregate rule updated per the new "≥1 budget-exhausted AND 0 other-failure" logic
- [x] #2 The 5 cases above explicitly tested in `pipeline-cli/src/classifier/budget-classifier.test.ts` (cases 1-5 named to mirror the truth table)
- [x] #3 `cli-classify-budget.ts` schema unchanged (same fields output) — no docstring/CLI change required beyond the existing tests being updated to reflect the new aggregate
- [x] #4 Workflow YAML comments + warning message + PR comment body updated to reflect that the gate now fires when "every NON-OK reviewer is budget-exhausted" (not strictly all 3)
- [x] #5 AISDLC-147 task file in `backlog/completed/` updated with an addendum noting the AISDLC-157 broadening + cross-reference
- [x] #6 All existing budget-classifier tests still pass (especially the AISDLC-149 + AISDLC-154 verdict-shape coverage); 3 prior tests whose expected aggregate flipped under the new rule were renamed and re-purposed as AISDLC-157 truth-table cases
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The 3-reviewer-input guard (`inputs.length === 3 && ...`) was preserved deliberately. A partial input set is itself a workflow regression, and silently skipping based on a sub-set of reviewers — even if all of those were budget-exhausted — would mask the bug. The existing regression test covering "2 of 3 reviewers + both budget-exhausted → proceed-as-normal" still asserts the guard.

The classify-budget CLI's output schema is genuinely unchanged: it still emits `{aggregate, budgetExhaustedCount, perReviewer}` — only the rule that derives `aggregate` was widened. The CLI's docstring around the field doesn't reference the old "all 3" rule, so no CLI documentation update was needed; the test file's narrative was updated for clarity.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Broadened the AISDLC-147 budget circuit breaker aggregate gate from "all 3 reviewers must be budget-exhausted" to "every NON-OK reviewer is budget-exhausted (≥1 budget AND 0 other-failure)". This unblocks the suppression path when AISDLC-141's conditional classifier (LIVE in CI as of AISDLC-156) AUTO_APPROVES an unselected reviewer — the AUTO_APPROVED stub previously counted as `ok` and prevented the AND-of-3 gate from firing on a genuine credit-exhausted run.

## Changes
- `pipeline-cli/src/classifier/budget-classifier.ts` (modified): updated `classifyReviewerOutputs` aggregate rule to `budgetExhaustedCount > 0 && otherFailureCount === 0`; updated module + function docstrings + AggregateDecision union comment
- `pipeline-cli/src/classifier/budget-classifier.test.ts` (modified): added explicit AISDLC-157 truth-table cases 1-5 + partial-input regression guard test; renamed/re-purposed 2 prior tests whose expected aggregate flipped under the new rule (the AISDLC-141-classifier-skipped scenario + the AISDLC-149 mixed-mode scenario)
- `pipeline-cli/src/cli/classify-budget.test.ts` (modified): renamed existing "mixed (2 budget + 1 ok) → proceed-as-normal" to its AISDLC-157 expectation `skip-with-budget-comment`; added a new test for "1 budget + 1 other-failure + 1 ok → proceed-as-normal" exercising the "real signal forces proceed" branch
- `.github/workflows/ai-sdlc-review.yml` (modified): updated the analyze-step warning message + the report-job permissions comment + the report-job step comment + the PR-comment body wording to reflect the new gate semantics (no logic change — the workflow already plumbs the classifier's aggregate decision verbatim)
- `backlog/completed/aisdlc-147 - Cost-savers-...md` (modified): added AISDLC-157 addendum + AC + design-decisions cross-references so the original task file doesn't misrepresent current behavior

## Design decisions
- **"≥1 budget AND 0 other-failure" rule (not "≥2 budget" or "majority budget")**: matches the precise intuition — we want to suppress only when there's nothing real to surface. The presence of any `other-failure` reviewer is a real signal (parse failure, reviewer crash, schema rejection) that an operator must see; the presence of `ok` reviewers means the verdict captured the truth and the budget reviewer is just noise. No information is hidden under either branch.
- **Preserved the 3-input regression guard**: a partial input set is itself a bug; silently skipping on it would mask the bug. The new rule explicitly composes with the guard so a 2-of-3 partial+all-budget case still proceeds-as-normal.
- **Workflow YAML wording change but no logic change**: the workflow is a pure adapter — it reads `aggregate` from the classifier output and branches on it. The rule lives in pipeline-cli where it has hermetic Vitest coverage.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1045 passed (was 1041 before; +4 new assertions, ~4 narrative renames)
- `pnpm test:review-workflow` — 16 passed (workflow-structure tests on `ai-sdlc-review.yml`)
- `pnpm --filter @ai-sdlc/pipeline-cli lint` — clean
- `pnpm format:check` — clean

## Follow-up
None. The fix is minimal and the truth table is exhaustively covered.
<!-- SECTION:FINAL_SUMMARY:END -->
