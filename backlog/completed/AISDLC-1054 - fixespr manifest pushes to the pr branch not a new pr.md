---
id: AISDLC-1054
title: 'A manifest with fixesPr runs on and pushes to that PR''s head branch; the pipeline opens no new PR'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline-cli
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/steps/02-compute-branch.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/dispatch/types.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Context (2026-10-23 ~06:20Z).** PR #1907 was red on patch coverage and needed one new test. The resume path cannot run a developer on an unchanged patch id, so a fresh task was filed and its queued manifest rewritten by dispatch to `branch: <the PR's head branch>`, `baseSha: <its merge-base>`, `fixesPr: 1907`. The executor's worktree did start on that branch and the developer added the test on top of it, but Step 2 computed a new task-named branch for the fresh task, Step 11 pushed there and opened PR #1950, which duplicates #1907 commit for commit plus the new attestation. #1907 got the same commits through the shared local branch but not the envelope, so it can never go green itself; the duplicate must land and #1907 be closed under the DEC-0266 exception. Along the way the first claim happened before the manifest rewrite, on a branch cut from main where the file to test did not exist, costing two forced releases and five discarded commits.

**Root cause.** `fixesPr` is only a claim-eligibility flag in the board (`pipeline-cli/src/dispatch/types.ts`, `board.ts`); nothing downstream reads it. The manifest `branch` is honoured by worktree setup but Step 2 still derives the push branch from the task id, and Step 11 always opens a PR.

**Five-step review (requirements first).**
1. Requirement questioned: does a fix-on-PR task need its own PR at all? No: its deliverable is the existing PR going green; a second PR is pure duplication and a closed-unmerged PR afterwards.
2. Delete: the new-PR path when `fixesPr` is set; nothing else.
3. Simplify: when the manifest carries `fixesPr`, Step 2 resolves the branch from the PR (`gh pr view <n> --json headRefName`, or the manifest's `prHeadRef`), Step 3 checks out that branch, Step 11 lease-pushes to it (the hook already allows it under DEC-0264) and edits the existing PR body to append a "fixed by <task id>" line instead of creating a PR; the task file still moves to `backlog/completed/` in that push; the verdict's `prNumber` is the fixed PR.
4. Accelerate: `cli-file task` accepts `--fixes-pr <n>` and writes `fixesPr` plus the PR's head branch into the generated brief entry, so dispatch never rewrites a manifest by hand and the first claim cannot race the rewrite.
5. Automate: a pipeline test with a manifest carrying `fixesPr` asserts that Step 2 yields the PR branch, that Step 11 performs no PR creation and pushes to that branch, and that a manifest without `fixesPr` is unchanged.

**Velocity impact.** Positive: a red PR that needs code is fixed by one task that lands on the same PR, with no duplicate PR, no manual manifest surgery and no DEC-0266 close afterwards.

## Acceptance Criteria

- [ ] With `fixesPr` set, Step 2 resolves the PR's head branch, Step 3 checks it out, Step 11 lease-pushes to it and appends to the existing PR body; no new PR is created; the verdict names the fixed PR.
- [ ] Without `fixesPr`, behaviour is unchanged (existing tests pass).
- [ ] `cli-file task --fixes-pr <n>` writes `fixesPr` and the PR head branch into the brief entry, and `cli-dispatch enqueue --from-brief` carries them into the manifest.
- [ ] Tests cover the three points above; `docs/operations/cli-hierarchy.md` documents the fix-on-PR flow.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
