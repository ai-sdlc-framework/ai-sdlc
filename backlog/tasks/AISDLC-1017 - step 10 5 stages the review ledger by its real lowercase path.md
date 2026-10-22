---
id: AISDLC-1017
title: >-
  Step 10.5 stages the review ledger by its real lowercase path (ledger-not-staged on every task since AISDLC-967)
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - pipeline
  - velocity
  - root-cause
  - hotfix
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/attestation/reviews-ledger.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (2026-10-21 19:15Z, blocks every landing).** AISDLC-967 (#1848, on main as fce26ed50) made Step 10.5 fail closed when `git add` of the review ledger is a no-op. The ledger writer (`reviewsLedgerPath` in `pipeline-cli/src/attestation/reviews-ledger.ts`) writes `.ai-sdlc/reviews/<task-id-lower>.jsonl`; all 211 ledgers committed on main are lowercase. Step 10.5 in `pipeline-cli/src/next-step/ship.ts` builds the path by hand as `.ai-sdlc/reviews/${state.taskId}.jsonl` with the uppercase id, so `git ls-files --error-unmatch` finds nothing and the step now stops with `ledger-not-staged` for a file that exists and is not ignored. First victim: AISDLC-969 (#1852, three approved review rounds, ledger untracked in `.worktrees/aisdlc-969`). Every task reaching Step 10.5 from now on fails the same way until this lands.

**Root cause.** Two spellings of one path: the writer lowercases, the stager does not. Before 967 the mismatch was hidden because the failing `git add` was silent (on the case-insensitive macOS filesystem it even added the file under the uppercase name on some runs, which is what the AISDLC-966 recovery cleaned up).

**Five-step review (requirements first).**
1. Requirement questioned: "Step 10.5 stages the ledger": kept. The requirement that the stager know the ledger's filename on its own is dropped.
2. Delete: the hand-built ledger path in `ship.ts`.
3. Simplify: `ship.ts` calls `reviewsLedgerPath(state.taskId, wt)` (relative to the worktree for the git invocations) so there is exactly one spelling; the error message prints the path it actually checked.
4. Accelerate: the executor that runs this task will itself hit the bug at Step 10.5 (the pipeline runs the parent's build); its documented recovery is to `git add .ai-sdlc/reviews/<task-id-lower>.jsonl`, commit with the pipeline's chore message, and re-run `/ai-sdlc execute` as a sign-push resume. Record that in the PR body; it is the one-time path, not a precedent.
5. Automate: a unit test for Step 10.5 with a mixed-case task id asserting the lowercase ledger is staged and no `ledger-not-staged` is raised; a second test that a genuinely ignored ledger still raises it (967 regression).

**Velocity impact.** Restores landings; nothing loosened (967's fail-closed stays).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ship.ts` derives the ledger path from `reviewsLedgerPath` (or the same lowercase helper) and no longer concatenates `state.taskId` into a `.jsonl` filename
- [ ] #2 Step 10.5 on a worktree with an untracked, unignored `.ai-sdlc/reviews/<id-lower>.jsonl` stages and commits it and does not return `ledger-not-staged` (test with an uppercase task id)
- [ ] #3 Step 10.5 on an ignored ledger still returns `ledger-not-staged` naming the ignore rule (AISDLC-967 test stays green)
- [ ] #4 The `ledger-not-staged` message prints the exact path checked
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli test -- ship`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
