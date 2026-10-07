---
id: AISDLC-750
title: >-
  parent main checkout self-heals the provable stale-index state and the post-rewrite guard survives stale worktree hook copies
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - orchestrator
  - reliability
dependencies: []
references:
  - ai-sdlc-plugin/scripts/check-orchestrator-state.sh
  - ai-sdlc-plugin/scripts/check-orchestrator-state.parity.test.mjs
  - .husky/post-rewrite
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The stale-index state fixed in PR #1233 recurred twice on 2026-10-06 (17:08 and 18:36 PDT, reflog entries on `refs/heads/main` with empty messages). The parent main checkout ended with HEAD at 4fff9bf8 while the index and working tree still held the exact tree of ancestor commit 11c9de3d, so `git status` listed 11 staged deletions and modifications (backlog tasks 737 to 745, `.ai-sdlc/_decisions/events.jsonl`, task 704.5) that nobody made. The dispatch session had to work from a separate clean copy and the planner repaired it by hand with `git read-tree -u -m 11c9de3d HEAD` followed by `git merge --ff-only origin/main`.

Two gaps cause the recurrence:

1. The `.husky/post-rewrite` guard from PR #1233 (exit when the parent has `main` checked out) only exists in the hook copy checked out on branches that include that commit. Git runs the hook file from the worktree where the rebase happens, so every worktree whose branch predates the fix still runs the old bare `update-ref` and moves the parent ref alone. On 2026-10-06 19:10 PDT, 58 of the worktrees under `.worktrees/` carried the pre-fix hook. Removing merged worktrees is only a mitigation; the parent must not depend on every worktree's copy of the hook.

2. `check-orchestrator-state.sh` (Step 0) detects the divergence but refuses to heal it because one dirty path (`events.jsonl`) is outside `backlog/`, and the "not provably ours" rule then stops at a warning. This state IS provable: `git write-tree` of the index equals the tree of a commit that is an ancestor of HEAD, and `git diff --quiet` against the index shows no unstaged edits. Nothing local can be lost by `git read-tree -u -m <that-commit> HEAD`.

Fix:
- In `check-orchestrator-state.sh`, before the existing backlog-only heuristic, add a provable self-heal: when HEAD is current or behind, compute the index tree with `git write-tree`, look for a commit in `git rev-list HEAD` (bounded, for example 200 commits) whose tree matches it, and confirm the working tree has no unstaged changes against the index and no staged change that is not explained by that commit. When all hold, run `git read-tree -u -m <match> HEAD`, log the recovery with both SHAs, and continue into the normal fast-forward sync. When they do not hold, keep the current refuse-and-warn behaviour. Cover the new branch in `check-orchestrator-state.parity.test.mjs` with a fixture that moves `refs/heads/main` with a bare `update-ref` and asserts the heal and the no-local-loss guarantee (a fixture with a real unstaged edit must still refuse).
- Make the parent independent of each worktree's hook copy. Pick one: (a) have Step 0 and the worktree setup step rewrite `.husky/post-rewrite` in every registered worktree from the main checkout's copy when the content differs (log each rewrite), or (b) install the guard at a level all worktrees share (for example a `core.hooksPath` under the common git dir that proxies to the worktree's `.husky/_` after the guard). Document the choice in the script header. Also make the `/ai-sdlc cleanup` sweep and `/ai-sdlc doctor` report worktrees whose hook copy predates the fix.
- The doctor check must turn red for the stale-index state and print the exact one-line recovery command.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A parent checkout whose index and working tree equal an ancestor commit's tree, with no unstaged edits, is healed automatically by Step 0 with a logged `read-tree` recovery, and a fixture with a genuine unstaged edit is still refused with the existing warning.
- [ ] A rebase in a worktree carrying the pre-fix `post-rewrite` copy can no longer move the parent `refs/heads/main` alone, verified by a test or a documented manual check against a worktree with the old hook.
- [ ] `/ai-sdlc doctor` reports the stale-index state red with the recovery command, and the cleanup sweep lists worktrees whose hook copy predates the fix.
- [ ] Parity tests cover the new Step 0 branches and the full test suite passes apart from the 14 pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), which are disclosed in the PR body.
