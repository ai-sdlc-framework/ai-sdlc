---
id: AISDLC-820
title: >-
  pre-push attestation chain converges on a rebased branch: squash leaves a single chore commit alone and sign re-runs at most once
status: Done
assignee: []
created_date: '2026-10-12'
labels:
  - pipeline
  - fix
  - hooks
dependencies: []
references:
  - scripts/squash-attestation-chores.sh
  - scripts/check-attestation-sign.sh
  - scripts/pre-push-fixups.sh
  - scripts/check-attestation-sign.test.mjs
  - .husky/pre-push
priority: critical
dispatchable: true
---

## Description

Filed under the DEC-0127 drain exception (fixes an existing PR, #1416, and the resumes behind it).

**Context.** On AISDLC-814's worktree (code commit c825f116 rebased onto main, PR #1416, three reviewers approved, 0 critical/major) every lease push loops: `.husky/pre-push` runs `scripts/squash-attestation-chores.sh`, which collapses the two `chore: auto-sign attestation` commits at HEAD into one; then `scripts/check-attestation-sign.sh` finds the envelope subject mismatched against the new HEAD, signs again, adds a new chore commit and exits 1 with "re-run git push". The next push squashes again and the cycle repeats; the executor ran it three times with no convergence (2026-10-12 00:30Z). Origin still holds the stale pre-rebase commit 1f350783. The executor escalated DEC-0131 (options: fix-hooks / bypass with AI_SDLC_SKIP_SQUASH_CHORES=1); the planner answered fix-hooks: a skip-variable push loosens a pre-push control, and the same loop is expected on every rebased bucket-A re-sign resume in the current PR drain (742, 773, 653.2, 711, 713, 695, 556, 799), so the hook fix pays back on each.

**Five-step review (requirements first).**
1. Requirement questioned: "stacked chore-sign commits are squashed before signing" (AISDLC-386 ordering, set to keep history clean) and "the signer's subject is the pre-chore HEAD" (AISDLC-419). Each is fine alone; together, on a rebased branch, the squash rewrites the commit the envelope is bound to, so the signer invalidates its own previous output.
2. Delete: the squash step's rewrite when it is not needed. A single chore commit whose envelope already binds to its parent must be left alone; consider deleting the squash step entirely if the signer can replace its own chore commit instead of stacking a new one.
3. Simplify: one rule. The signer verifies first; if the envelope at HEAD binds to HEAD's parent (attestation-only descendant) it is a no-op; if not, it replaces the existing chore commit's envelope instead of adding a second chore commit, so the chain reaches a fixed point after one re-run.
4. Accelerate: a push on a rebased branch needs at most two `git push` invocations.
5. Automate: hermetic test in `scripts/check-attestation-sign.test.mjs` (and the squash script's test if one exists) that builds a rebased branch with two chore commits and asserts the pre-push chain converges within two runs and that a converged branch is a no-op.

Velocity impact: positive; unblocks #1416 and every rebased re-sign in the drain, and removes a 3-attempt executor loop.

## Acceptance Criteria

- [ ] AC-1: On a branch with code commit C and two stacked chore-sign commits whose latest envelope binds to C, the pre-push chain (squash, fixups, task-move, attestation-sign) exits 0 without rewriting anything.
- [ ] AC-2: On a rebased branch whose envelope subject is orphaned, the first `git push` produces exactly one chore commit with a valid envelope bound to the new C and asks for one re-run; the second `git push` exits 0 (verifier `status=valid`). No third run is ever needed.
- [ ] AC-3: `scripts/squash-attestation-chores.sh` never rewrites a lone chore commit, and never rewrites when the envelope at HEAD already verifies against HEAD's parent.
- [ ] AC-4: Hermetic tests cover both cases above and the previous looping shape (two chores plus orphaned subject), running under `pnpm test:attestation-sign-gate` (or the squash script's own test target).
- [ ] AC-5: No new skip variable; existing `AI_SDLC_SKIP_SQUASH_CHORES` / `AI_SDLC_SKIP_ATTESTATION_SIGN` semantics unchanged.
- [ ] AC-6: AISDLC-814's worktree (`.worktrees/aisdlc-814`, PR #1416) pushes successfully with the fixed hooks, as the real-world check, and the PR body records the push transcript.

## Notes

Developer verification note: run `pnpm build`, the hook-gate tests (`pnpm test:attestation-sign-gate`, `pnpm test:pre-push-fixups-gate`, `pnpm test:task-move-gate`) and `pnpm lint`. On the operator machine the full `pnpm test` currently shows known environment failures outside this change (verify-runtime x3, bin-invocation x4, usage-ingest x1, fixed by #1416); list them in the PR body and do not report the task failed for them.

Related: AISDLC-814 (#1416), AISDLC-419 (attestation-only descendant), AISDLC-386 (pre-push fixups ordering), AISDLC-618 (three-way exclusion lockstep), DEC-0131.
