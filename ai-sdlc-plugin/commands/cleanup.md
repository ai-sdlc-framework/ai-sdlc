---
name: cleanup
description: Remove worktrees under .worktrees/ — defaults to merged-PR sweep, or pass a task-id to force-remove a specific one.
argument-hint: '[<task-id>]'
allowed-tools: Bash, Read
model: haiku
rung: 3
bounds: "tightly scoped template prompt over structured inputs; fixed output; no free prose; no retries beyond the caller cap"
---

Companion to `/ai-sdlc execute`. Two modes:

## Mode 1 — Sweep leftover worktrees (no arguments)

When `$ARGUMENTS` is empty, run the same sweep as the dispatch tick (AISDLC-1108), so the manual and the automatic path agree. A worktree is removed when its disposition is one of:

- `remove-merged`: its PR is MERGED.
- `remove-closed`: its PR is CLOSED and not merged.
- `remove-no-pr`: the branch has no PR and the directory is older than the grace window (default 6 h).
- `remove-stale`: the PR is OPEN but the branch head has not moved for 14 days.

It keeps `keep-inflight` (task inflight on the board, or a `.active-task` sentinel younger than 24 h) and `keep-open-pr`. PR state is looked up per branch. A dirty tree does not block removal; the untracked paths are logged, `git worktree remove --force` runs with its exit code checked, and a refusal falls back to `rm -rf` plus `git worktree prune`. **Branches are never deleted**, locally or on origin: only the worktree directory goes, and a resume recreates it from the branch. Also remove the legacy project-level `.worktrees/.active-task` sentinel if present (superseded by per-worktree sentinels in AISDLC-81).

```bash
rm -f .worktrees/.active-task

if [ ! -d .worktrees ]; then
  echo "No .worktrees/ directory — nothing to sweep."
  exit 0
fi

PLUGIN_SCRIPTS_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-$(pwd)/ai-sdlc-plugin}}/scripts"
if [ -z "${PIPELINE_CLI_BIN:-}" ]; then
  if [ -f "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh" ]; then
    PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || { echo "ERROR: @ai-sdlc/pipeline-cli not found; export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin" >&2; exit 1; }
  else
    PIPELINE_CLI_BIN="$(pwd)/pipeline-cli/bin"
  fi
fi
# Optional preview: node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" sweep-worktrees --dry-run
node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" sweep-worktrees
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
