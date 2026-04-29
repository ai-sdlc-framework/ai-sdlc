---
name: cleanup
description: Remove worktrees under .worktrees/ — defaults to merged-PR sweep, or pass a task-id to force-remove a specific one.
argument-hint: '[<task-id>]'
allowed-tools: Bash, Read
model: inherit
---

Companion to `/ai-sdlc execute`. Two modes:

## Mode 1 — Sweep all merged worktrees (no arguments)

When `$ARGUMENTS` is empty, do exactly what `/ai-sdlc execute` does at start: walk `.worktrees/`, check each branch's PR status via `gh pr list`, remove any whose PR has merged. Also remove the legacy project-level `.worktrees/.active-task` sentinel if present — it's no longer written by `/ai-sdlc execute` (per-worktree sentinels replaced it in AISDLC-81) and would only ever be a leftover from a much older run. Per-worktree `.active-task` files inside each worktree directory are removed automatically when `git worktree remove` deletes the worktree.

```bash
# Clear the legacy project-level sentinel if it still exists. Safe to delete:
# /ai-sdlc execute now writes per-worktree sentinels at .worktrees/<id>/.active-task
# instead of the project-level path.
rm -f .worktrees/.active-task

if [ ! -d .worktrees ]; then
  echo "No .worktrees/ directory — nothing to sweep."
  exit 0
fi

REMOVED=0
for wt in .worktrees/*/; do
  [ -d "$wt" ] || continue
  WT_BRANCH=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [ -z "$WT_BRANCH" ] && continue
  [ "$WT_BRANCH" = "HEAD" ] && continue
  MERGED_AT=$(gh pr list --head "$WT_BRANCH" --state merged --json mergedAt --jq '.[0].mergedAt' 2>/dev/null)
  if [ -n "$MERGED_AT" ] && [ "$MERGED_AT" != "null" ]; then
    echo "Removing $wt (branch $WT_BRANCH merged at $MERGED_AT)"
    # The per-worktree .active-task sentinel (if any) is removed atomically
    # with the worktree itself.
    git worktree remove --force "$wt" 2>/dev/null || true
    REMOVED=$((REMOVED + 1))
  fi
done
echo "Swept $REMOVED merged worktree(s)."
```

## Mode 2 — Force-remove a specific task's worktree

When `$ARGUMENTS` is a task ID (e.g. `AISDLC-68`), remove that worktree regardless of PR status. Useful for retries after a failed `/ai-sdlc execute` that left state behind.

```bash
TASK_ID_LOWER=$(echo "$ARGUMENTS" | tr '[:upper:]' '[:lower:]')
WORKTREE_PATH=".worktrees/$TASK_ID_LOWER"
if [ ! -d "$WORKTREE_PATH" ]; then
  echo "No worktree at $WORKTREE_PATH — nothing to clean up."
  exit 0
fi

# Capture the branch name before removing so we can remind the operator.
BRANCH=$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null)

# git worktree remove --force deletes the entire worktree directory, which
# includes the per-worktree .active-task sentinel written by /ai-sdlc execute
# Step 4. No separate `rm` needed — the sentinel goes with the worktree.
git worktree remove --force "$WORKTREE_PATH"
echo "Removed worktree $WORKTREE_PATH (was on branch $BRANCH)."

# Branch deletion is destructive and may erase work — leave it to the operator.
echo ""
echo "The branch '$BRANCH' is still present locally and possibly on origin."
echo "If you want to delete it: git branch -D '$BRANCH' && git push origin --delete '$BRANCH'"
echo "(NOT done automatically — branch deletion is operator-controlled per CLAUDE.md.)"
```

## What this command DOES NOT do

- **Never deletes branches.** Branch deletion is destructive (could lose unmerged work). The operator decides.
- **Never closes or merges PRs.** Cleanup is local-state-only.
- **Never touches `.worktrees/` directories that aren't standalone git worktrees.** If `git -C $wt rev-parse` fails, the entry is skipped with no message — could be a stray empty dir, the operator can rm it themselves.
