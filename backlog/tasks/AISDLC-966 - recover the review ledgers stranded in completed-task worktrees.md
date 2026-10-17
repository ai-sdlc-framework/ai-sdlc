---
id: AISDLC-966
title: 'Recover the .ai-sdlc/reviews ledgers stranded in completed-task worktrees into one chore PR before any worktree sweep'
status: To Do
assignee: []
created_date: '2026-10-17'
labels:
  - chore
  - observability
dependencies: []
references:
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/src/next-step/ship.ts
  - docs/operations/transcript-management.md
priority: high
dispatchable: true
---

## Description

Review ledgers (`.ai-sdlc/reviews/<task>.jsonl`, written by `pipeline-cli/src/attestation/reviews-ledger.ts` and staged by `pipeline-cli/src/next-step/ship.ts`; the parent copies were moved to the planner scratchpad `parent-ledgers/` on 2026-10-17 to unblock Step 0.5) are the committed, append-only record of every reviewer verdict and finding; `cli-reviews`, `cli-usage scorecard`, replay and the incremental review (which reads prior findings only from committed ledgers) all join on them. Between 2026-10-11 and 2026-10-17 an interim line in the parent checkout's `.git/info/exclude` hid `.ai-sdlc/reviews/` from git in every worktree, so Step 10.5 staged nothing and no ledger reached a PR. The line is removed; in-flight tasks commit theirs at their next ship. The ledgers of tasks that already landed exist only on disk, in their old worktrees under `.worktrees/`, and a `/ai-sdlc:cleanup` sweep would delete them.

Worktrees holding an uncommitted ledger for a completed task at audit time: 534, 549, 582, 604, 651.5, 676, 704.4, 719, 729, 738, 744, 746, 762, 765, 795.1, 804, 840, 842, 846, 847, 849, 887, 899, 929. Eleven more copies sit in the parent `.ai-sdlc/reviews/` (543, 546, 562, 663.5, 700, 702, 708, 716, 720.1, 721, 730); those are misrouted debris that `ai-sdlc doctor --fix` deletes, but compare each against its worktree copy first and keep the longer file.

**Five-step review (requirements first).**
1. Requirement questioned: do we need the old rows at all? Yes: the scorecard and replay corpus measure reviewer marginal value across the whole window, and a gap of a week of the busiest drain is exactly the data they need.
2. Delete: the eleven parent copies after the comparison; nothing else.
3. Simplify: one chore PR, docs-only lane (ledger paths are patch-id excluded and need no attestation), one commit per ledger is not needed: one commit.
4. Accelerate: a shell loop over `.worktrees/*/.ai-sdlc/reviews/*.jsonl` that copies a file only when its task is in `backlog/completed/` and the parent copy is absent or a strict prefix of it.
5. Automate: `ai-sdlc doctor` check `untracked-review-ledgers` also looks inside `.worktrees/*/` and reports a ledger whose task is completed but whose rows are not on main, so this cannot go unnoticed again.

## Acceptance Criteria

- [ ] Every completed task listed above has its ledger rows on `main`, with no row lost (worktree file is a prefix of, or equal to, the committed file).
- [ ] The eleven parent debris copies are gone, each after a comparison with its worktree copy.
- [ ] `ai-sdlc doctor` reports a completed task whose worktree ledger has rows missing from main.
- [ ] No worktree is removed by this task.
