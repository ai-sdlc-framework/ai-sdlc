---
id: AISDLC-359
title: 'bug(orchestrator): reviewer subagents still produce unparseable output AFTER AISDLC-351 fence-fix landed — degenerate-reviewer retry from AISDLC-355 Bug 3 needs prioritization'
status: To Do
assignee: []
created_date: '2026-05-17'
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

- [ ] **Bug 1 of AISDLC-355 (auto-detect stale verdict)** moved to a separate task or de-prioritized; it's the LEAST common of the 3 modes.
- [ ] **Bug 2 of AISDLC-355 (verdict shape unification)** — easy fix, ship alongside this.
- [ ] **Bug 3 of AISDLC-355 (degenerate-reviewer retry)** — this is the actual blocker for autonomous unattended dispatch. Implement:
   - In `coerceReviewerVerdict` (`pipeline-cli/src/steps/09-iterate.ts:167`), when the parsed result is `undefined` OR matches the suspicious pattern (`approved=false + findings=[] + summary === ''`), invoke the spawner ONE MORE TIME with the same args before falling through to the synthetic critical.
   - Add per-spawner-call retry counter to prevent infinite loops (max 1 retry per reviewer per iteration).
   - Emit `[ai-sdlc-progress] reviewer-retry: <agentId> attempt=2` so the operator sees the retry happening.
   - Test: inject a spawner that returns degenerate output on first call + substantive verdict on second; assert the second is used + retry is logged.
- [ ] **Timeout signal as a separate condition**: if the SubagentResult comes back with `status=timeout`, treat that as a real failure (not retry) and emit a different finding (`reviewer-timeout` vs `reviewer-degenerate`) so the operator knows the difference.

## Observed instances (for forensic correlation)

| Task | PR | Failed reviewer | Date | Resolution |
|---|---|---|---|---|
| AISDLC-282 | #514 | code-reviewer | 2026-05-17 | Manual Agent re-run + force-push |
| AISDLC-286 | #512 | all 3 reviewers | 2026-05-17 | Manual Agent re-run for all + force-push |
| AISDLC-283 | #522 | test-reviewer | 2026-05-17 | Manual Agent re-run + force-push (this task filed) |

## Source

Operator session 2026-05-17 after the AISDLC-351 parser fix landed. The fence-strip + balanced-brace extraction works correctly on the OUTPUTS that hit the parser — but ~30% of LLM dispatches produce content the parser cannot recover (truncation, pure prose, etc.). The retry layer is the missing piece.
