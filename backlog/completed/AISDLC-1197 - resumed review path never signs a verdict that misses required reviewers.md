---
id: AISDLC-1197
title: 'Resumed review path never signs a verdict that misses required reviewers'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - pipeline-cli rfc-0061 defect fix
dependencies: []
references:
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/next-step/ship.ts
priority: high
dispatchable: true
---

## Description

**Source.** Planner session 2026-11-06 08:55Z; filed on operator go (decision rubric, same day).

On #2413 (AISDLC-1189) the resumed review path ran only correctness-reviewer at head cc264514. The pipeline still reported `approved`, step 11 pushed a verdict ref, and that record held `coverage.required: [correctness, security]` with `coverage.satisfied: false` (and `pullRequest: 0`). The CI gate then failed coverage-short. The pipeline told the executor and dispatch "approved" for a verdict the gate was certain to refuse, so a round was spent and the failure surfaced only in CI.

## Fix

**Five-step review (requirements first).** Requirement: the pipeline never reports `approved`, or pushes a verdict ref, for a record CI would reject. Delete: nothing. Simplify: in `review-finalize.ts`, treat `coverage.satisfied === false` as not approved: return iterate-needed naming the missing reviewer roles instead of proceeding to ship; record the real PR number rather than 0 when one exists. Accelerate/automate: a test.

## Acceptance Criteria
- [x] #1 A round whose verdicts leave `coverage.satisfied` false ends `iterate-needed` and names the missing roles; ship is not reached.
- [x] #2 The verdict record carries the PR number when the PR exists.
- [x] #3 A test covers a resumed round with only correctness-reviewer against a required set of correctness plus security.

## Final Summary

## Summary
A review round whose verdicts leave required reviewers uncovered now ends `iterate-needed` and names the missing roles, so ship is not reached. This covers the nothing-to-spawn path too. The verdict record also carries the PR number when a draft PR already exists.

## Changes
- pipeline-cli/src/next-step/review-finalize.ts
- pipeline-cli/src/next-step/review-finalize.test.ts
- pipeline-cli/src/next-step/next-step.ts
- pipeline-cli/src/next-step/next-step.test.ts
- pipeline-cli/src/next-step/ship.ts
- pipeline-cli/src/next-step/verdict-ref-push.ts
- pipeline-cli/src/next-step/verdict-ref-push.integration.test.ts
- pipeline-cli/src/workflow/execute-host.ts

## Design decisions
Rebase onto origin/main was a no-op. The push landed after the pre-push patch-coverage gate ran. The PR already existed (#2444), so `gh pr create` reported it instead of opening a new one; I did not check whether it is still a draft. The untracked .ai-sdlc/reviews/aisdlc-1197.jsonl was left out of the commit.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (244 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

