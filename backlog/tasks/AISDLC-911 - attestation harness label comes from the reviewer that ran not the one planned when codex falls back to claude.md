---
id: AISDLC-911
title: 'fix: attestation leaf and verdict carry the harness of the reviewer that actually ran, not the planned -codex agent, when codex quota forces a Claude-native fallback'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [bug, pipeline-cli, attestation, review]
dependencies: []
references: [pipeline-cli/src/next-step/review-finalize.ts, pipeline-cli/src/next-step/review-prepare.ts, pipeline-cli/src/next-step/types.ts, pipeline-cli/src/cli/attestation.ts, pipeline-cli/src/next-step/review-finalize.test.ts, pipeline-cli/src/next-step/review-prepare.test.ts, ai-sdlc-plugin/agents/code-reviewer-codex.md, ai-sdlc-plugin/agents/test-reviewer-codex.md]
priority: high
dispatchable: true
---

## Description

On 2026-10-15 an executor reported PR #1582: the Codex CLI quota ran out, so the code and test reviews ran on the Claude-native `code-reviewer` and `test-reviewer`, yet the attestation verdicts, the reviews ledger and the v6 transcript leaves are labelled `harness: codex`. The envelope therefore states a provenance that is false. Cause: the harness label is fixed at prepare time by `reviewerHarness()` (`pipeline-cli/src/next-step/review-prepare.ts` ~90-97, applied ~361 and ~469) from `AI_SDLC_REVIEWER_HARNESS` plus `which codex`; an installed codex with no quota still yields `codex`, and `leafModel` falls back to `codex-default` (~100-101). Nothing detects quota exhaustion. At finalize, `review-finalize.ts` (~183, ~203) matches a report by `r.agent === sp.agent || r.agent === sp.reviewer`, so a report from native `code-reviewer` lands in the planned `code-reviewer-codex` slot; the verdict (~207, ~221), the transcript file name (~263), the marker lookup and `emit-leaf --harness` (~288-289) all use the planned agent and `sp.harness`, and the reported agent is dropped. `cli-attestation emit-leaf` copies the argument as given (`attestation.ts` ~678, ~989, ~1033). The `-codex` agent bodies hardcode `harness:"codex"` in their transcript (`code-reviewer-codex.md:106`, `test-reviewer-codex.md:106`).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the harness is a property of the review plan. It is a property of the review run; the plan only predicts it. The attestation's claim (a real review ran against this code, RFC-0042) must name what ran. 2. Deleted: the prepare-time label as the source of truth for the leaf; it stays as the plan's expectation only. 3. Simplified: in `finalizeReview`, when `report.agent !== sp.agent`, derive the harness from the agent that reported (`-codex` suffix gives `codex`, anything else gives `claude-code`), use that agent for the transcript file, the marker lookup and the leaf, and take `leafModel` from the report's model instead of `codex-default`; the `.meta.json` harness agent type is checked against it. 4. Accelerated: a fallback no longer needs a human to notice a wrong label after the fact; the envelope is right the first time and the PR is not re-signed. 5. Automated: a test in `review-finalize.test.ts` where native `code-reviewer` reports for a planned `code-reviewer-codex` slot asserts the verdict `harness`, the ledger row and the `emit-leaf --harness` argument are all `claude-code` and the model is the reporting agent's; a second test asserts the planned/actual mismatch is recorded in the verdict notes so the fallback is visible in the envelope.

## Acceptance Criteria

- [ ] With a Claude-native report in a planned `-codex` slot, the verdict, the reviews ledger and the transcript leaf carry `harness: claude-code` and the reporting agent's model; the planned harness is recorded as `plannedHarness` (or equivalent) so the fallback is visible.
- [ ] With a genuine codex report nothing changes (existing `review-finalize.test.ts` and `review-prepare.test.ts` pass unchanged).
- [ ] The `-codex` agent bodies no longer hardcode `harness:"codex"` where the pipeline can derive it, or the hardcoded value is validated against the reporting agent at finalize.
- [ ] `scripts/verify-attestation.mjs` keeps accepting envelopes produced before this change (no schema bump).
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Detecting codex quota exhaustion up front (so the pipeline picks the native agent at prepare time instead of the executor improvising) is a separate improvement; this task only makes the label truthful whichever way the fallback happened. PR #1582 itself is not held on this: its reviews ran.
