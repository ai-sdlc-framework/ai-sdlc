#!/usr/bin/env bash
# AISDLC-137 + AISDLC-358: orchestrator-repo state hardening.
#
# Idempotent self-heal for the parent repo's branch + bare-flag + main-branch
# staleness. Runs at the start of every /ai-sdlc execute dispatch (Step 0) AND
# at the entry of every autonomous orchestrator tick so the orchestrator state
# is correct before any worktree is created or frontier work begins.
#
# Pattern C contract (memory: project_orchestrator_repo_layout.md):
#   - Parent dir = non-bare, has main checked out
#   - Parent's working tree on main is READ-ONLY by contract
#   - All edits happen in .worktrees/<task-id>/
#
# Hard guards (AISDLC-358):
#   1. Parent MUST be on `main`. If not:
#      - Clean working tree → auto-checkout main + reset hard. Log recovery.
#      - Dirty working tree → REFUSE (exit 1). Print branch + dirty paths + fix cmd.
#   2. core.bare MUST be false (AISDLC-137). Auto-correct if true.
#   3. Parent main ref MUST match origin/main. Reset --hard if clean + stale.
#
# Because parent is read-only, it's safe to git-reset --hard to origin/main
# whenever a sync is needed — but only when the working tree is verifiably
# clean. If the operator (or a tool) has uncommitted modifications, abort
# with a clear warning and let them resolve manually.
#
# Skip with: AI_SDLC_SKIP_ORCHESTRATOR_STATE_CHECK=1

set -euo pipefail

if [ "${AI_SDLC_SKIP_ORCHESTRATOR_STATE_CHECK:-}" = "1" ]; then
  echo "[orchestrator-state] skipped (AI_SDLC_SKIP_ORCHESTRATOR_STATE_CHECK=1)"
  exit 0
fi

# Resolve the parent (orchestrator) repo root. May be invoked from any
# worktree; the common .git dir's parent is the orchestrator root.
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
if [ -z "$GIT_COMMON_DIR" ]; then
  echo "[orchestrator-state] not in a git repo; skipping"
  exit 0
fi

# Make the path absolute (it may be `.git` when invoked from the parent itself,
# or an absolute path to .git when invoked from a worktree).
GIT_COMMON_DIR_ABS=$(cd "$GIT_COMMON_DIR" 2>/dev/null && pwd)
if [ -z "$GIT_COMMON_DIR_ABS" ]; then
  echo "[orchestrator-state] cannot resolve git-common-dir; skipping"
  exit 0
fi

PARENT_ROOT=$(dirname "$GIT_COMMON_DIR_ABS")
cd "$PARENT_ROOT"

# AISDLC-363: skip the orchestrator state check when running inside a GH
# merge-queue read-only probe branch or a shallow CI clone. These run BEFORE
# the AISDLC-358 parent-on-main guard because the queue probe IS a non-main
# branch by design (sanctioned ephemeral state) and the guard would otherwise
# try (and fail) to recover.
CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
if [[ "$CURRENT_BRANCH" == gh-readonly-queue/* ]]; then
  echo "[orchestrator-state] skipping: running inside GH merge-queue probe branch (${CURRENT_BRANCH})"
  exit 0
fi

# Detect shallow clone: if git rev-parse refs/heads/main fails, we're likely
# in a shallow checkout without a local main ref.
if ! git rev-parse refs/heads/main >/dev/null 2>&1; then
  echo "[orchestrator-state] skipping: local refs/heads/main not present — likely a shallow CI clone"
  exit 0
fi

# 1a. AISDLC-358: Pattern-C contract — parent MUST be on main.
#     Read the symbolic HEAD ref. If it's detached or on a feature branch,
#     auto-recover (clean tree) or refuse (dirty tree).
if [ -z "$CURRENT_BRANCH" ]; then
  echo "[orchestrator-state] WARN: parent HEAD is detached; skipping branch check (manual recovery needed)"
elif [ "$CURRENT_BRANCH" != "main" ]; then
  # Parent is on the wrong branch. Inspect working tree cleanliness.
  DIRTY_TRACKED_BRANCH=$(git status --porcelain 2>/dev/null | grep -vE "^\?\?" | head -1 || true)
  if [ -n "$DIRTY_TRACKED_BRANCH" ]; then
    # Dirty — cannot auto-recover safely. Refuse with clear instructions.
    echo "[orchestrator-state] ERROR: parent working tree is on branch '$CURRENT_BRANCH' (expected 'main') AND has uncommitted tracked changes."
    echo "[orchestrator-state]       Dirty paths:"
    git status --porcelain | grep -vE "^\?\?" | head -10 | sed 's/^/[orchestrator-state]         /'
    echo "[orchestrator-state] Recovery: stash or commit your changes, then run:"
    echo "[orchestrator-state]   git -C \"${PARENT_ROOT}\" checkout main"
    echo "[orchestrator-state]   git -C \"${PARENT_ROOT}\" reset --hard origin/main"
    exit 1
  else
    # Clean tree — auto-recover: checkout main + reset to origin/main.
    echo "[orchestrator-state] auto-recovering parent from '${CURRENT_BRANCH}' to main"
    if ! git checkout main; then
      echo "[orchestrator-state] ERROR: git checkout main failed in ${PARENT_ROOT}" >&2
      exit 1
    fi
    if ! git reset --hard origin/main; then
      echo "[orchestrator-state] ERROR: git reset --hard origin/main failed in ${PARENT_ROOT}" >&2
      exit 1
    fi
    echo "[orchestrator-state] auto-recovered parent from '${CURRENT_BRANCH}' to main at $(git rev-parse --short HEAD)"
    exit 0
  fi
fi

# 1b. (AISDLC-137) Auto-correct core.bare if it's true. Some local editor extensions / tools
#    flip this back periodically; we re-correct it on every dispatch.
BARE=$(git config --get core.bare 2>/dev/null || echo "false")
if [ "$BARE" = "true" ]; then
  echo "[orchestrator-state] WARN: core.bare=true detected; auto-correcting to false"
  git config core.bare false
  # When transitioning from bare→non-bare, we also need HEAD pointing at main
  # so the working tree can be materialized.
  git symbolic-ref HEAD refs/heads/main 2>/dev/null || true
fi

# 2. Fetch latest main + update the local main ref. update-ref is atomic;
#    failures (network, etc.) leave the previous ref intact.
if ! git fetch --quiet origin main 2>/dev/null; then
  echo "[orchestrator-state] WARN: git fetch origin main failed; skipping sync"
  exit 0
fi

ORIGIN_MAIN=$(git rev-parse refs/remotes/origin/main 2>/dev/null || echo "")
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

if [ -z "$ORIGIN_MAIN" ]; then
  echo "[orchestrator-state] WARN: cannot resolve origin/main; skipping sync"
  exit 0
fi

# Already up-to-date — nothing to do.
if [ "$HEAD_SHA" = "$ORIGIN_MAIN" ]; then
  exit 0
fi

# 3. Sync needed. Check working tree cleanliness BEFORE any destructive op.
#    "Clean" = no tracked files modified/staged/deleted. Untracked files are
#    allowed (reset --hard preserves them) — they include .worktrees/ +
#    in-flight backlog task drafts.
DIRTY_TRACKED=$(git status --porcelain 2>/dev/null | grep -vE "^\?\?" | head -1 || true)
if [ -n "$DIRTY_TRACKED" ]; then
  echo "[orchestrator-state] WARN: parent working tree has uncommitted tracked changes; skipping reset"
  echo "[orchestrator-state]       ${PARENT_ROOT}"
  git status --porcelain | grep -vE "^\?\?" | head -10 | sed 's/^/[orchestrator-state]         /'
  echo "[orchestrator-state] Resolve manually: stash, commit, or discard. Then re-run."
  exit 0
fi

# Reset HEAD + working tree in one op (also moves refs/heads/main since HEAD
# is the symref pointing at it). Untracked files survive.
echo "[orchestrator-state] resetting parent working tree: $HEAD_SHA -> $ORIGIN_MAIN"
git reset --hard "$ORIGIN_MAIN" >/dev/null
echo "[orchestrator-state] parent now at $(git rev-parse --short HEAD)"

exit 0
