---
id: AISDLC-1197
title: 'Resumed review path never signs a verdict that misses required reviewers'
status: To Do
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
- [ ] #1 A round whose verdicts leave `coverage.satisfied` false ends `iterate-needed` and names the missing roles; ship is not reached.
- [ ] #2 The verdict record carries the PR number when the PR exists.
- [ ] #3 A test covers a resumed round with only correctness-reviewer against a required set of correctness plus security.
