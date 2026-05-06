---
id: AISDLC-204
title: >-
  Step 0 worktree sweep misses squash-merged PRs because source branch is
  deleted from remote
status: Done
assignee: []
created_date: '2026-05-05 21:30'
labels:
  - bug
  - pipeline-cli
  - worktree
  - cleanup
  - framework-bug
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - .ai-sdlc/pipeline-backlog.yaml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Step 0 of `/ai-sdlc execute` (in `ai-sdlc-plugin/commands/execute.md`) iterates `.worktrees/*/`, looks up each worktree's branch's PR via `gh pr list --head <branch> --state merged --json mergedAt --jq '.[0].mergedAt'`, and removes the worktree if the PR has merged. Empirically observed (2026-05-05): the sweep removed ZERO worktrees even though 11 of them had merged PRs. The `gh pr list --head <branch>` query returns `[]` (empty array) for branches whose source ref was deleted from the remote after squash-merge.

## Root cause

GitHub deletes the source branch from the remote when a PR squash-merges (default repo policy on this repo: `delete_branch_on_merge: true`). After deletion, `gh pr list --head <deleted-branch>` returns no results — the API treats `--head` as a current-branch filter, not a historical one. The PR still exists with `mergedAt` populated, but it's not findable via the `--head` filter.

Net: the sweep heuristic produces false negatives on every squash-merged PR. Only PRs that merge with branch retention (or non-squash methods that leave the ref) get swept.

## Reproducer

After PRs #326, #327, #328, #329 squash-merged on 2026-05-05:
```bash
gh pr list --head ai-sdlc/aisdlc-201-safe-execute-default-mock --state merged --json mergedAt --jq '.[0].mergedAt'
# returns: empty (null) — even though PR #328 is MERGED
```

vs the working query:
```bash
gh pr list --head ai-sdlc/aisdlc-201-safe-execute-default-mock --state all --json state,number --jq '.[0]'
# returns: {"state":"MERGED","number":328} — finds it because --state all includes deleted branches
```

## Impact

Every merged-PR worktree accumulates indefinitely. Operator-side cleanup (`/ai-sdlc cleanup` per-task or manual `git worktree remove`) is needed to reclaim disk + keep the worktree-list readable. On 2026-05-05 the operator manually swept 11 stale worktrees; without the fix this will recur every dispatch cycle.

Composes badly with: nested worktrees (`.worktrees/<task-id>/.worktrees/<other-task>/`) accidentally created when a previous session's bash cwd persisted into a child worktree (see `feedback_bash_cwd_persists.md`). Those nested ones additionally don't appear in `git worktree list` until `git worktree prune` runs.

## Fix

Replace the sweep query with one that doesn't rely on the source branch existing on the remote:

```bash
# Old (broken):
MERGED_AT=$(gh pr list --head "$WT_BRANCH" --state merged --json mergedAt --jq '.[0].mergedAt' 2>/dev/null)
if [ -n "$MERGED_AT" ] && [ "$MERGED_AT" != "null" ]; then
  ...
fi

# New (proposed):
PR_INFO=$(gh pr list --head "$WT_BRANCH" --state all --json number,state,mergedAt --jq '.[0]' 2>/dev/null)
PR_STATE=$(echo "$PR_INFO" | jq -r '.state // empty')
if [ "$PR_STATE" = "MERGED" ]; then
  MERGED_AT=$(echo "$PR_INFO" | jq -r '.mergedAt')
  ...
fi
```

`--state all` includes both open and closed PRs and works regardless of whether the source branch has been deleted from the remote. Filter by `.state == "MERGED"` in the jq expression to keep the original intent (only sweep merged PRs, not abandoned-and-closed ones).

## Implementation notes

- Update the shell snippet in `ai-sdlc-plugin/commands/execute.md` Step 0 sweep
- Also update `pipeline-cli/src/cleanup.ts` (or wherever `/ai-sdlc cleanup` lives) if it has the same query pattern
- Add a regression test that mocks `gh pr list --head <deleted-branch>` returning empty AND `gh pr list --head <branch> --state all` returning the merged PR — assert the sweep removes the worktree
- Verify cleanup happens BEFORE Step 0's other operations so the worktree dir isn't accidentally re-used by a fresh dispatch with the same task ID
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Step 0 sweep in `ai-sdlc-plugin/commands/execute.md` uses `gh pr list --state all` query so squash-merged PRs (with deleted source branches) are correctly identified as merged
- [x] #2 Sweep correctly removes worktrees whose PR is in MERGED state, regardless of whether the source branch still exists on the remote
- [x] #3 Sweep does NOT remove worktrees whose PR is CLOSED but not MERGED (e.g., abandoned work) — those need explicit operator cleanup
- [x] #4 Sweep does NOT remove worktrees that have no associated PR yet (e.g., dispatch in flight before the PR opens) — those are active
- [x] #5 If `pipeline-cli/src/cleanup.ts` (or equivalent for `/ai-sdlc cleanup`) has the same query bug, update there too (checked: `13-cleanup.ts` removes the sentinel only, no PR query; `00-sweep.ts` was the only location with the bug)
- [x] #6 Regression test: simulate a worktree on a branch whose `gh pr list --head <branch>` returns empty (deleted source branch) but `--state all` returns a MERGED PR — assert sweep removes it
<!-- AC:END -->

## Final Summary

Step 0 worktree sweep now uses `--state all` instead of `--state merged` to identify merged PRs, fixing the root cause where squash-merged PRs with deleted source branches were missed.

### Changes
- `pipeline-cli/src/steps/00-sweep.ts` (modified): Replaced `--state merged` query with `--state all` + client-side `.state === "MERGED"` filter. Extracted `lookupPrState()` as a separately-testable helper. Added detailed JSDoc explaining the AISDLC-204 root cause.
- `pipeline-cli/src/steps/00-sweep.test.ts` (modified): Expanded from 5 tests to 15 tests covering all required cases: squash-merged with deleted branch (a), still-open PR (b), no PR (c), detached HEAD (d), CLOSED/abandoned PR (e), git failure (f), no .worktrees dir (g), network failure (h), multi-worktree sweep, and regression guard asserting `--state all` is always used.
- `ai-sdlc-plugin/commands/execute.md` (modified): Updated Step 0 shell snippet to use `--state all` + jq `.state` filter. Added explanatory callout documenting the AISDLC-204 root cause so future maintainers understand why the old pattern was broken.

### Design decisions
- **`--state all` + client-side filter** over `gh search prs <sha>`: The recommended approach from the task notes. Simpler, works in the same `gh` call, doesn't require reading the HEAD commit SHA from each worktree. No new persistence layer needed.
- **Extracted `lookupPrState()`**: Makes the PR-state lookup independently unit-testable without going through the full sweep loop.
- **CLOSED PRs are NOT swept**: Intentionally preserved — abandoned work needs explicit operator cleanup, not silent removal.

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1760 tests passed (107 files)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up
(none)
