---
id: AISDLC-951
title: 'Step 10.5 rebase converges when the review ledger re-dirties after its commit, instead of looping until the executor fails'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - pipeline
  - execute
  - bug
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/ship.test.ts
  - pipeline-cli/src/cli/reviews.ts
  - ai-sdlc-plugin/commands/execute.md
priority: high
dispatchable: true
---

## Description

Step 10.5 (`ship.ts`, pre-sign rebase) commits pending transcript leaves before `git rebase` so an untracked file does not make git refuse the rebase. The review ledger `.ai-sdlc/reviews/<task>.jsonl` is not handled the same way: the reviewers append to it during the review round, the executor commits it as `chore: commit round-1 review ledger records (<task>)`, the rebase runs, the review round re-appends to the ledger, and the next Step 10.5 attempt finds the tree dirty again. On 2026-10-16 executor delta looped on AISDLC-725 (PR #1346) this way: HEAD `2b6d2b6a6` carries two ledger commits and two transcript-leaf commits, the three reviewers had approved, the worktree ended clean and 4 commits ahead, and the task was still reported failed with `dirty-worktree`. The work had to be pushed by hand.

**Five-step review (requirements first).**
1. Requirement questioned: must the ledger be committed before the rebase at all? It must be in the PR (the ledgers are committed, `.gitignore` line 135), but it does not need a separate commit per attempt.
2. Delete: the per-attempt `chore: commit round-1 review ledger records` commit when the ledger is already identical to HEAD (nothing to commit).
3. Simplify: Step 10.5 treats `.ai-sdlc/reviews/<task>.jsonl` exactly like `.ai-sdlc/transcript-leaves/`: stage and commit it in the same pre-rebase commit, in one place in `ship.ts`, so no prose in `execute.md` has to do it.
4. Accelerate: a rebase attempt whose only dirt is pipeline-owned files (leaves, ledger) never returns `dirty-worktree`; it commits them and proceeds, so the step converges in one attempt.
5. Automate: a `ship.test.ts` case where the ledger is dirty before the rebase and asserts one commit, a successful rebase and no `dirty-worktree`; a second case where the ledger is dirty again after the rebase and asserts the step still converges.

Velocity impact: positive; a multi-round review no longer ends in a failed verdict and a hand push.

## Acceptance Criteria

- [ ] AC-1: Step 10.5 stages and commits a modified or untracked `.ai-sdlc/reviews/<task>.jsonl` together with pending transcript leaves before the rebase, in `ship.ts`, and never returns `dirty-worktree` for those paths.
- [ ] AC-2: When the ledger or leaves are dirty again after a rebase (a new review round appended), the next Step 10.5 attempt commits them and completes; the step converges within one further attempt.
- [ ] AC-3: No empty commit is created when the ledger is already identical to HEAD.
- [ ] AC-4: `ship.test.ts` covers AC-1, AC-2 and AC-3; `execute.md` no longer instructs the executor to commit the ledger by hand.

## Notes

Origin: AISDLC-725 failed verdict on executor delta, 2026-10-16 ~20:00Z; HEAD 2b6d2b6a6 in `.worktrees/aisdlc-725`.
