---
id: AISDLC-359
title: 'bug(orchestrator): reviewer subagents still produce unparseable output AFTER AISDLC-351 fence-fix landed — degenerate-reviewer retry from AISDLC-355 Bug 3 needs prioritization'
status: Done
assignee:
  - '@dominique'
created_date: '2026-05-17'
completed_date: '2026-05-22'
labels:
  - orchestrator
  - regression
  - pipeline-friction
  - critical
dependencies:
  - AISDLC-355
priority: critical
references:
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - pipeline-cli/src/steps/09-iterate.ts
  - ai-sdlc-plugin/agents/test-reviewer.md
---

## Bug

Confirmed regression 2026-05-17 after PR #515 (AISDLC-351 fence-stripping parser fix) landed and the parent's `pipeline-cli/dist/` was rebuilt with the new parser.

`cli-orchestrator tick --spawner claude --max-concurrent 2` dispatched AISDLC-283 (RFC-0016 Phase 5). The orchestrator ran 3 reviewers via the fixed parser. Two returned real verdicts (`code-reviewer: APPROVED, 3 minor findings`; `security-reviewer: APPROVED, 0 findings`). **Test-reviewer returned the synthetic-critical placeholder** (`"test-reviewer returned no parseable verdict (status=success)"`).

This is the SAME failure mode AISDLC-351 was supposed to eliminate, on a worktree where the fixed parser dist is verified present (`grep -c "tryParseJsonWithFenceStripping" pipeline-cli/dist/runtime/shell-claude-p-spawner.js` returns `2`, confirming the new helper is in the compiled output).

## Two possible explanations

1. **Reviewer LLM returned content that defeats all 3 strategies** in `tryParseJsonWithFenceStripping`:
   - Strategy 1 (direct `JSON.parse`): fails on non-JSON output
   - Strategy 2 (fence-strip): fails when the LLM didn't use markdown fences
   - Strategy 3 (balanced-brace extraction): fails if the LLM emitted no `{...}` substring at all
   
   Scenarios that defeat all 3: pure prose (no JSON anywhere), truncated mid-response (context-limit hit), reviewer crashed mid-output.

2. **The `shell-claude-p-spawner` timed out or got SIGTERM-killed** at 30-min default; partial stdout was captured + parsed by `parseClaudeOutput`, which returned `undefined`, leading `coerceReviewerVerdict` to fall through to the synthetic critical.

Both scenarios are real LLM/process failure modes — not parser bugs. The parser doing the right thing here (returning `undefined`); the pipeline's `coerceReviewerVerdict` is treating that correctly as "no verdict". The fix needs to be at the RETRY layer: AISDLC-355 Bug 3 ("degenerate-reviewer retry") was filed for exactly this case, but hasn't been implemented yet.

Operator-side workaround used today (and 2 days ago for AISDLC-282 + 286): manually re-run the broken reviewer via `Agent` tool, write a flat verdict file with the real verdict, force-push.

## Why this needs prioritization above AISDLC-355's other 2 bugs

AISDLC-355 bundles three resume-from-draft bugs. Bug 3 (degenerate-reviewer retry) is the ONLY one that requires operator intervention on EVERY autonomous dispatch where any reviewer hits this LLM-output failure mode. Bug 1 (stale verdict reuse) and Bug 2 (verdict shape mismatch) only fire on resume-from-draft retries.

Observed rate today: 3 of ~10 dispatches hit a degenerate reviewer (AISDLC-282 code-reviewer, AISDLC-286 all 3 reviewers, AISDLC-283 test-reviewer). That's ~30% failure rate. Unsustainable for unattended dispatch.

## Acceptance criteria

- [x] **Bug 1 of AISDLC-355 (auto-detect stale verdict)** moved to a separate task or de-prioritized; it's the LEAST common of the 3 modes. Shipped in AISDLC-355 PR #527 alongside Bug 3 (operator decided to bundle rather than split).
- [x] **Bug 2 of AISDLC-355 (verdict shape unification)** — easy fix, ship alongside this. Shipped in AISDLC-355 PR #527.
- [x] **Bug 3 of AISDLC-355 (degenerate-reviewer retry)** — this is the actual blocker for autonomous unattended dispatch. Implemented in AISDLC-355 PR #527; AISDLC-359 adds a regression-pin test for the exact `status=success` + unparseable-prose path that surfaced this task.
   - `coerceReviewerVerdict` retry: implemented via `spawnReviewerWithRetry()` in `pipeline-cli/src/steps/09-iterate.ts` (line 250).
   - Per-call max-1 retry: enforced by the linear two-attempt structure (no recursion, no counter needed).
   - `[ai-sdlc-progress] reviewer-retry: <agentId> attempt=2` emit: at line 283 (logger path) and 285 (console fallback).
   - Test: `pipeline-cli/src/steps/09-iterate.test.ts` "retries once on degenerate first result and uses second result" (`status=error` arm) + the new AISDLC-359 regression pin "AISDLC-359 regression: retries when status=success but output is unparseable prose" (the exact incident shape).
- [x] **Timeout signal as a separate condition**: implemented at `09-iterate.ts:259-274` (first-attempt timeout) and `09-iterate.ts:295-310` (retry-attempt timeout); both paths emit `summary: 'reviewer-timeout'` rather than the `reviewer-degenerate` synthetic critical. Covered by test "does NOT retry on timeout status — emits reviewer-timeout finding instead".

## Observed instances (for forensic correlation)

| Task | PR | Failed reviewer | Date | Resolution |
|---|---|---|---|---|
| AISDLC-282 | #514 | code-reviewer | 2026-05-17 | Manual Agent re-run + force-push |
| AISDLC-286 | #512 | all 3 reviewers | 2026-05-17 | Manual Agent re-run for all + force-push |
| AISDLC-283 | #522 | test-reviewer | 2026-05-17 | Manual Agent re-run + force-push (this task filed) |

## Source

Operator session 2026-05-17 after the AISDLC-351 parser fix landed. The fence-strip + balanced-brace extraction works correctly on the OUTPUTS that hit the parser — but ~30% of LLM dispatches produce content the parser cannot recover (truncation, pure prose, etc.). The retry layer is the missing piece.

## finalSummary

### Summary

AISDLC-359's core scope — the degenerate-reviewer retry layer + timeout distinction in `pipeline-cli/src/steps/09-iterate.ts` — was already shipped on `main` via AISDLC-355 PR #527 (merged 2026-05-17 23:48 PT, hours after this task was filed earlier the same day). All four ACs are satisfied by code already on `main`. This task closes by adding ONE regression-pin test that captures the exact failure signature from the original incident (`status=success` + unparseable prose, as opposed to the existing test's `status=error` arm) so a future refactor cannot silently drop that codepath.

### Changes

- `pipeline-cli/src/steps/09-iterate.test.ts` (modified): added test "AISDLC-359 regression: retries when status=success but output is unparseable prose" that injects a spawner returning `{status: 'success', output: <narrative prose with no JSON>}` on first call + a substantive verdict on retry; asserts the retry path is taken (call count = 2), the substantive verdict is used, and the `reviewer-retry: test-reviewer attempt=2` progress line is emitted on the operator logger. Pins the exact AISDLC-359 incident shape distinct from the existing `status=error` arm.

### Design decisions

- **Closed as duplicate-with-regression-pin rather than no-op-close**: AISDLC-355 PR #527 shipped Bug 3 (degenerate-retry) the same day AISDLC-359 was filed. The retry implementation, the timeout distinction, and the operator-visible progress emit are all on `main`. Rather than close AISDLC-359 with a "see AISDLC-355" pointer and zero diff, this PR ships a regression test that captures the exact failure-shape from the AISDLC-283/282/286 incidents (`status=success` with unparseable LLM output) so the codepath is pinned against future regression. The existing AISDLC-355 test covers `status=error`; the AISDLC-359 incident was `status=success` — distinct paths through `coerceReviewerVerdict` → `isDegenerateVerdict`.
- **No production code change**: the retry layer in `09-iterate.ts` is correct as shipped by AISDLC-355. Touching production code in this PR would be churn.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 4285 passed | 1 skipped (225 files), including the new AISDLC-359 regression pin
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

(none)
