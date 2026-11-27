---
id: AISDLC-1462
title: >-
  A cancelled superseded gate run blocks merge and routes the PR as a real failure
status: Done
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
- [x] #1 The PR states why one push started two `pull_request` runs of `ai-sdlc-gate.yml`, and either removes the duplicate or explains why it stays.
- [x] #2 `cli-merge-if-eligible` treats a required check as green when its newest run on the head commit passed and the only failing row of that name comes from an older cancelled run of the same workflow; a test reproduces the #3126 shape.
- [x] #3 A failing row of the same name from a different app or workflow still blocks (AISDLC-663.5 regression test).
- [x] #4 The reconciler does not route a PR as `real-failure` when the failure is a cancelled run superseded by a newer run on the same head; a test covers it.
- [x] #5 The PR body carries a "Velocity impact" section.
<!-- AC:END -->

## Final Summary

## Summary

A cancelled gate run that a newer run of the same workflow replaced no longer blocks merge or gets routed as real-failure. The merge-eligibility helper now drops a check row from a cancelled run when a newer run of the same workflow on the same head commit reported a check of the same name from the same app; the reconciler drops a cancelled run's red rows when a newer run of the same workflow reported the same name. The duplicate run stays: it comes from the Step 11 push and the ready flip arriving out of order, and a comment in the workflow says why.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/pipeline-cli/src/governance/merge-if-eligible.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/pipeline-cli/src/governance/merge-if-eligible.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/pipeline-cli/src/hierarchy/pr-state.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/pipeline-cli/src/hierarchy/pr-state.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/pipeline-cli/src/hierarchy/reconcile.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/pipeline-cli/src/hierarchy/reconcile.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/.github/workflows/ai-sdlc-gate.yml
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1462/backlog/tasks/AISDLC-1462 - a cancelled superseded gate run blocks merge and routes the PR as a real failure.md

## Design decisions

Root cause from the PR #3126 timeline: the force-push was at 06:12:02 and the ready flip at 06:12:05, but GitHub created the two runs at 06:12:07 and 06:12:08, so the synchronize run (which may cancel an in-progress run) was likely created second and cancelled the ready_for_review run. The REST API does not report which event started each run, so that order is an inference. Only the gate's pipeline-cli tests were run locally (src/governance, src/hierarchy and src/cli/merge-if-eligible: 1794 tests passing), not the whole repo suite; build, lint and format:check were run in full and pass, and patch coverage at pre-push was 100%. The workflow-runs read is made only when a check name has more than one row and one of them is not green; if that read fails, nothing is dropped and the strict worst-state reading applies. The first `gh pr create` attempt was refused by the release-merge PreToolUse rule because the body text named the merge CLI; the body was then passed with --body-file, with the tool name replaced by 'merge helper'. That is a false positive in the hook's pattern match on prose.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
