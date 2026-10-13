---
id: AISDLC-848
title: >-
  step 10.5 commits pending transcript leaves before the pre-sign rebase and names the git refusal instead of conflict unknown
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - pipeline
  - executor
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/ship.test.ts
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/attestation/patch-id.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The executor pipeline dies at Step 10.5 with `rebase-conflict 'unknown'` although there is no conflict. Seen twice on 2026-10-13 on the AISDLC-827 executor run (PR #1449) and once on 2026-10-11 under the name "rebase-loop".

Code path found in `pipeline-cli/src/next-step/`:

1. Step 7 reviewer round: `cli-attestation emit-leaf` (called from `pipeline-cli/src/steps/07-build-review-prompts.ts` flow) writes `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`. Nothing commits it; it stays an uncommitted change in the worktree.
2. `next-step.ts` (around line 418): on an APPROVED verdict with `postRebaseReviewed` false, it calls `preSignRebase` (`ship.ts`, "10.5 pre-sign rebase").
3. `preSignRebase` runs `git rebase origin/<target>` (`ship.ts` ~line 109) with the worktree dirty. Git refuses ("cannot rebase: You have unstaged changes"), exit non-zero, no conflict markers.
4. Since AISDLC-818 any non-zero exit is treated as a conflict. `git diff --name-only --diff-filter=U` is empty, so the file list is empty and the reason becomes `Step 10.5 rebase conflict in: unknown (see git status)`. Git's stderr is discarded and the run aborts with outcome `rebase-conflict` (`orchestrator/loop.ts` ~line 1455 surfaces it).
5. The Step 10 chore commit (which would have committed the leaves) is after 10.5, so it never runs. Every requeue re-runs the review, re-emits the leaves, dirties the tree and fails identically until the retry cap.

`.ai-sdlc/transcript-leaves/` and `.ai-sdlc/transcript-leaves.jsonl` are in `PATCH_ID_EXCLUSIONS` (`pipeline-cli/src/attestation/patch-id.ts`), the same list the verifier and the pre-push hook mirror (attestation-only descendant relaxation), so committing the leaves does not change the patch-id.

**Five-step review (requirements first).** Requirement questioned: "rebase before signing", set by AISDLC-102/AISDLC-818 (Step 10.5) to keep the envelope subject fresh. Under strict=false a PR need not be current with main, and when main moved only in paths excluded from the content hash the rebase buys nothing, so whether the rebase is needed at all in that case is left to the implementer to test; the minimal fix keeps it. Delete: the `unknown` label, and the rule that any non-zero rebase exit is a conflict. Simplify: commit pending leaves first so the tree is clean, the same shape the Step 10 chore commit already uses. Accelerate: fail on the first run with the real cause instead of burning retries to the cap. Automate: none.

## Fix

1. In `preSignRebase` (`ship.ts`), before `git rebase`, if `git status --porcelain` shows changes only under the attestation-excluded paths (`.ai-sdlc/transcript-leaves/`, `.ai-sdlc/transcript-leaves.jsonl`), stage them and commit `chore: emit transcript leaves (<task-id>)`. Any other dirty path is a real error: fail with cause `dirty-worktree` naming the paths.
2. When `git rebase` exits non-zero and there are no unmerged files, do not report a conflict. Return a failure whose record carries a cause id (`dirty-worktree` when git's stderr says unstaged/uncommitted changes, else `rebase-failed`) and git's stderr verbatim. `unknown (see git status)` is removed. Real conflicts keep the conflicting-file list.
3. Carry the cause id and stderr through `next-step.ts` `fail(...)` into the failure record so `outcomes[i].failure` in `orchestrator/loop.ts` shows them.
4. Hermetic test in `ship.test.ts`: real temp git repo, a dirty `.ai-sdlc/transcript-leaves/<id>.jsonl`, origin/main ahead. Assert the rebase succeeds after the leaf commit, and a second case with a dirty non-excluded file asserts `dirty-worktree` plus verbatim stderr.

Velocity impact: positive. Removes a deterministic retry-to-cap loop on every executor run whose base moved; no new gate, no governance control loosened.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A hermetic test reproduces the dirty-leaf case (uncommitted `.ai-sdlc/transcript-leaves/` file, base moved) and `preSignRebase` succeeds after committing the leaves
- [ ] #2 A rebase refusal without conflict markers yields a failure record with a cause id (`dirty-worktree` or `rebase-failed`) and git's stderr verbatim; the string `unknown` no longer appears as a conflict label
- [ ] #3 The patch-id computed before and after the leaf commit is identical (exclusion list covers the leaves)
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Follow-up

(none)
