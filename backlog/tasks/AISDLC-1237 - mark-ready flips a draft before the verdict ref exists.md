---
id: AISDLC-1237
title: 'mark-ready-after-codeql flips a task draft to ready before its verdict ref exists, so every task PR fails the gate once'
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - ci
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/mark-ready.ts
  - pipeline-cli/src/execute-pipeline.ts
  - .github/workflows/ai-sdlc-gate.yml
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
priority: high
dispatchable: true
dispatchableReason: 'Backlog-pressure fix: seven task PRs on 2026-11-08 (#2544 #2545 #2549 #2550 #2552 #2556 #2558 #2559) each failed the gate once, were routed to the planner as no-match and needed a rerun order; planner filed 2026-11-08 from the 07:5xZ wake root-cause look.'
---

## Description

**Observed 2026-11-08, every task PR since RFC-0061 Phase 2 (AISDLC-1172).** Step 11 opens the task PR as a draft at dev-done (AISDLC-218). About three minutes later, as soon as the CodeQL `Analyze` checks pass, the dispatch tick's `mark-ready-after-codeql` action (`pipeline-cli/src/hierarchy/mark-ready.ts`) runs `gh pr ready` on it: #2552 opened 07:33:46Z and flipped 07:37:36Z, #2556 07:48:56Z and 07:52:08Z, #2558 08:08:48Z and 08:11:30Z, #2559 08:10:19Z and 08:13:09Z. The `ready_for_review` event starts the gate (`ai-sdlc-gate.yml`), whose `Review verdict (code PRs)` job runs `cli-attestation verdict-check` on the head. The executor is still at `06-dev-done`; reviewers have not run and no `refs/ai-sdlc/verdicts/<head>` exists, so the job fails with `no-record`, `ai-sdlc/attestation` and `ai-sdlc/pr-ready` post failure, the reconciler classifies the PR `no-match` and routes it to the planner, and the planner issues a conditional rerun order to dispatch. The signing round (Step 10) then pushes a new head with the ref and the order is moot. Net cost per task: one wasted gate run, one routed PR, one planner ask, one dispatch order, and a red check on every task PR for 10 to 20 minutes.

**Cause.** `mark-ready.ts` flips a qualifying draft (`TASK_BRANCH_RE = /^ai-sdlc\//`) on one condition only: every `Analyze` check on its head is `success`. That condition predates RFC-0061; it never checks that a verdict ref for the head exists. `flipReady()` in `steps/land-prep.ts` is the guarded flip (approved aggregate verdict, CodeQL green, no CHANGES_REQUESTED) and Step 11 auto-promote (`execute-pipeline.ts`, AISDLC-354) already runs `gh pr ready` once the verdict is APPROVED, so the tick's early flip is both premature and redundant for task PRs. The AISDLC-1227 sole-pusher fix removed a different race (two pushers on one branch) and did not change this.

## Fix

**Five-step review (requirements first).**
1. Question: must a task draft be ready before its verdict exists? No. A ready task PR with no verdict ref can never pass the gate, so flipping it early buys nothing and fires a guaranteed red run.
2. Delete: the CodeQL-only flip of task drafts in `mark-ready.ts` for branches whose task is inflight on the board (the pipeline flips them itself at Step 11 auto-promote once the verdict is approved). Keep the tick flip for drafts that have a verdict ref on origin but were left draft (an executor died between signing and auto-promote), since that is the recovery case the action exists for.
3. Simplify: one extra predicate in `mark-ready.ts`: flip only when `git ls-remote origin refs/ai-sdlc/verdicts/<headSha>` returns a ref (or the task's `done/` verdict names this head). Everything else about the action (superseded, conflicting, failed Analyze reporting) is unchanged.
4. Accelerate: none; this removes work from the gate.
5. Automate: unit tests for the new predicate (ref present flips, ref absent leaves draft with reason `draft: no verdict ref for head`, Analyze failed still reported); keep the report shape.

## Acceptance Criteria

- [ ] AC-1: `mark-ready.ts` never flips a draft whose head has no `refs/ai-sdlc/verdicts/<headSha>` on origin; the skipped entry carries reason `no verdict ref for head`. Unit test beside the existing ones, no network (runner stub).
- [ ] AC-2: a draft with the verdict ref on origin and clean Analyze still flips (recovery case), and one with a failed Analyze is still reported under `failedAnalyze`; existing tests keep passing.
- [ ] AC-3: Step 11 auto-promote (`execute-pipeline.ts`) remains the flip for the normal path; the PR body states where the two flips meet and why no task PR can now reach `ready` without a verdict ref.
- [ ] AC-4: `docs/operations/cli-hierarchy.md` (dispatch tick actions) and `docs/operations/session-hierarchy.md` describe the new condition in one sentence each; the Step 11 comment in `pipeline-cli/src/steps/11-push-and-pr.ts` that cites the deleted `docs/operations/aisdlc-218-draft-pr-flow.md` points at the surviving doc instead.
- [ ] AC-5: evidence in the PR body: the first task PR opened after this lands shows a single gate run on its first ready flip with `Review verdict` passing (or the executor's own CI round shows no `no-record` failure).
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
