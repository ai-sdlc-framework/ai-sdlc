---
id: AISDLC-154
title: >-
  Fix budget classifier — substring fallback uses whole stdout, not just the
  last line (catches multi-line cli-review verdicts)
status: Done
assignee: []
created_date: '2026-05-02 19:30'
labels:
  - ci
  - cost-optimization
  - bug
dependencies:
  - AISDLC-147
  - AISDLC-149
references:
  - pipeline-cli/src/classifier/budget-classifier.ts
  - pipeline-cli/src/classifier/budget-classifier.test.ts
  - pipeline-cli/src/cli/classify-budget.ts
  - pipeline-cli/src/cli/classify-budget.test.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-149 partially fixed the AISDLC-147 Anthropic budget circuit breaker, but missed a second failure mode that surfaces when `cli-review` writes its verdict as **pretty-printed multi-line JSON** instead of single-line JSON.

### Symptom

Verified on PR #196 CI run id 25267752415: even with AISDLC-149 in main, the budget classifier reports `aggregate=proceed-as-normal exhausted=0/3` when all 3 reviewer agents have failed with credit-exhaustion. CHANGES_REQUESTED still gets posted, operator still has to manually dismiss.

### Root cause

The classify-budget CLI extracts `verdictLine = lastLine(stdout)` (in `pipeline-cli/src/cli/classify-budget.ts`). For multi-line pretty-printed JSON, `lastLine` returns just the closing `}` brace.

Trace through `classifyOneReviewer`:
1. `verdictLine = "}"` → `tryParseVerdict("}")` returns null (not a valid verdict shape)
2. AISDLC-149's `verdictContainsBudgetSignature` is NOT called (only fires when verdict parses)
3. Falls through to substring fallback: `combined = "}" + "\n" + stderr`
4. Substring check fails — the credit-exhaustion text lives in the **whole stdout body** (the multi-line verdict's findings array), NOT in stderr or the last line
5. Returns `'other-failure'` → no budget detection → CHANGES_REQUESTED still posted

### Fix

In `pipeline-cli/src/classifier/budget-classifier.ts`:
- Add optional `stdoutRaw: string` to `ReviewerRawOutput` interface
- In `classifyOneReviewer`'s substring-fallback path, change `combined` from `${verdictLine}\n${stderr}` to `${stdoutRaw ?? verdictLine}\n${stderr}` — use the WHOLE stdout when supplied, falling back to `verdictLine` for back-compat with older callers/tests
- The valid-verdict path is unchanged — AISDLC-149's `verdictContainsBudgetSignature` still fires for the case where `cli-review` writes single-line JSON or the verdict's findings array contains the message

In `pipeline-cli/src/cli/classify-budget.ts`:
- Read each `/tmp/review-<type>.txt` once, supply both `verdictLine = lastLine(...)` (preserves existing `tryParseVerdict` shape) AND `stdoutRaw = <whole file>` (new, for the substring fallback)
- No workflow YAML change needed — the workflow already passes the full file paths; the CLI was simply discarding most of the content

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Multi-line stdout with credit-exhaustion in the body classifies as `'budget-exhausted'`
- [x] #2 Single-line valid verdict with credit-exhaustion in findings classifies as `'budget-exhausted'` (existing AISDLC-149 path preserved)
- [x] #3 Single-line valid verdict with normal CHANGES_REQUESTED finding classifies as `'ok'` (no false positive)
- [x] #4 Empty stdout + credit-exhaustion in stderr classifies as `'budget-exhausted'` (existing AISDLC-147 path preserved)
- [x] #5 New tests in `budget-classifier.test.ts` cover multi-line pretty-printed verdict, multi-line non-budget critical finding (no false positive), and split-across-lines edge case
- [x] #6 New CLI test in `classify-budget.test.ts` verifies the CLI passes whole stdout into the classifier — full multi-line all-3-reviewer scenario produces `skip-with-budget-comment`
- [x] #7 Workflow YAML wiring already passes whole file paths; no YAML change required
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
The `stdoutRaw` field is optional on `ReviewerRawOutput` so existing tests that only supply `verdictLine + stderr` continue to work — they exercise the back-compat path where the substring fallback inspects `verdictLine` (matches AISDLC-147's original behavior). The CI path always supplies `stdoutRaw` because the CLI now reads it explicitly.

The 6 new classifier tests + 1 new CLI test bring total `pipeline-cli` tests from 1001 → 1008 (all passing). No regression on AISDLC-149's 4 valid-verdict-finding tests.
<!-- SECTION:NOTES:END -->
