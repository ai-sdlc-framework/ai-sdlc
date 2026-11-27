---
id: AISDLC-1462
title: >-
  A cancelled superseded gate run blocks merge and routes the PR as a real failure
status: In Progress
assignee: []
created_date: '2026-11-27'
labels:
  - pipeline-cli
  - ci
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - .github/workflows/ai-sdlc-gate.yml
  - backlog/completed/aisdlc-724 - cancelled duplicate workflow runs show as failed checks.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On PR #3126 (AISDLC-1432, head `49f320a3`) one push of three commits started two
`pull_request` runs of `AI-SDLC PR Ready Gate` (45950341394 and 45950342401). The first was
cancelled by the concurrency group; the second passed and GitHub reported the PR `CLEAN`.

Two consumers still read the PR as failing:

1. `cli-merge-if-eligible` refused: `required check(s) not green: ai-sdlc/pr-ready=FAILURE,
   Backlog Drift=CANCELLED`. `stateForRequired`
   (`pipeline-cli/src/governance/merge-if-eligible.ts:1219`) takes the worst state across
   every check-run of that name on the commit, including the cancelled run's rows, so a
   superseded run blocks the merge for good. Branch protection uses the latest result per
   check name; this helper is stricter than the control it mirrors.
2. The reconciler routed the PR `real-failure` and tried `reenter` twice (refused because of
   AISDLC-1453), then routed it to the planner.

The planner unblocked it by re-running the cancelled run. AISDLC-724 fixed the same duplicate
run shape for other workflows; it has come back on `ai-sdlc-gate.yml`.

## Fix

**Five-step review (requirements first).**
- Question: the merge helper must not be weaker than branch protection, and it does not need
  to be stricter than it for a superseded run of the same workflow on the same head.
- Delete: the duplicate run per push, if one of the two triggers is redundant.
- Simplify: resolve each required check name from the newest run per workflow and head
  (a superseded cancelled run does not count); keep it fail-closed for a check name with a
  failing result from a different app or workflow (AISDLC-663.5 hardening stays).
- Accelerate / automate: the reconciler classifies a cancelled run with a newer run of the
  same workflow on the same head as `superseded`, not `real-failure`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The PR states why one push started two `pull_request` runs of `ai-sdlc-gate.yml`, and either removes the duplicate or explains why it stays.
- [ ] #2 `cli-merge-if-eligible` treats a required check as green when its newest run on the head commit passed and the only failing row of that name comes from an older cancelled run of the same workflow; a test reproduces the #3126 shape.
- [ ] #3 A failing row of the same name from a different app or workflow still blocks (AISDLC-663.5 regression test).
- [ ] #4 The reconciler does not route a PR as `real-failure` when the failure is a cancelled run superseded by a newer run on the same head; a test covers it.
- [ ] #5 The PR body carries a "Velocity impact" section.
<!-- AC:END -->
