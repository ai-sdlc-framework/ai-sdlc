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
# AISDLC-750 additions:
#   4. Provable stale-index self-heal. When HEAD moved alone (a bare update-ref),
#      the index and working tree still hold an ancestor's tree. If `git write-tree`
#      equals the tree of a commit within the last 200 of HEAD, nothing is unstaged,
#      and HEAD is current or behind origin/main, every staged "change" is explained
#      by that commit and `git read-tree -u -m <match> HEAD` loses nothing. Otherwise
#      the existing refuse/warn behaviour stays.
#   5. Parent independence from worktree hook copies. Git runs post-rewrite from the
#      worktree doing the rebase, so a worktree whose branch predates the guard fix
#      would still move the parent's refs/heads/main alone. CHOICE (a): on every run
#      this script rewrites the GENERATED, gitignored husky shim
#      `<worktree>/.husky/_/post-rewrite` in every registered worktree to exec the main
#      checkout's `.husky/post-rewrite`, logging each rewrite. The tracked
#      `.husky/post-rewrite` is deliberately NOT touched: editing it would leave the
#      worktree with a dirty tracked file that blocks `git rebase`. `pnpm run prepare`
#      regenerates the shim, so this re-applies on the next Step 0.
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

# AISDLC-750 (5): repoint every worktree's generated post-rewrite shim at the main
# checkout's hook so a stale worktree copy cannot desync the parent. Non-fatal.
PARENT_REWRITE_HOOK="${PARENT_ROOT}/.husky/post-rewrite"
if [ -f "$PARENT_REWRITE_HOOK" ]; then
  PROXY_BODY=$(printf '#!/usr/bin/env sh\n# AISDLC-750 proxy: run the main checkout post-rewrite guard, not this worktree copy\nexec bash "%s" "$@"\n' "$PARENT_REWRITE_HOOK")
  while IFS= read -r wt_line; do
    case "$wt_line" in worktree\ *) ;; *) continue ;; esac
    wt_path="${wt_line#worktree }"
    [ "$wt_path" = "$PARENT_ROOT" ] && continue
    shim="${wt_path}/.husky/_/post-rewrite"
    [ -d "${wt_path}/.husky/_" ] || continue
    if [ "$(cat "$shim" 2>/dev/null)" != "$PROXY_BODY" ]; then
      if printf '%s\n' "$PROXY_BODY" > "$shim" 2>/dev/null && chmod +x "$shim" 2>/dev/null; then
        echo "[orchestrator-state] repointed post-rewrite shim in worktree ${wt_path} at the main checkout hook (AISDLC-750)"
      fi
    fi
  done < <(git worktree list --porcelain 2>/dev/null || true)
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

# AISDLC-750 (4): provable stale-index self-heal (see header). Only when HEAD is
# current or behind origin/main and the index differs from HEAD.
if [ -n "$HEAD_SHA" ] && ! git diff --cached --quiet HEAD 2>/dev/null \
  && git merge-base --is-ancestor "$HEAD_SHA" "$ORIGIN_MAIN" 2>/dev/null \
  && git diff --quiet 2>/dev/null; then
  INDEX_TREE=$(git write-tree 2>/dev/null || echo "")
  STALE_MATCH=""
  if [ -n "$INDEX_TREE" ]; then
    while read -r cand cand_tree; do
      if [ "$cand_tree" = "$INDEX_TREE" ]; then STALE_MATCH="$cand"; break; fi
    done < <(git log -n 200 --format='%H %T' HEAD 2>/dev/null || true)
  fi
  if [ -n "$STALE_MATCH" ]; then
    echo "[orchestrator-state] stale index detected: index/tree equal ${STALE_MATCH:0:8}, HEAD is ${HEAD_SHA:0:8}; healing with read-tree"
    if git read-tree -u -m "$STALE_MATCH" HEAD 2>/dev/null; then
      echo "[orchestrator-state] healed parent index/working tree: ${STALE_MATCH} -> ${HEAD_SHA}"
    else
      echo "[orchestrator-state] WARN: read-tree heal failed; recover manually: git -C \"${PARENT_ROOT}\" read-tree -u -m ${STALE_MATCH} HEAD"
    fi
  fi
fi

# AISDLC-708: the index/working tree can differ from HEAD even when HEAD is
# current (something moved HEAD alone). Count tracked paths that diverge and warn
# loudly; never auto-reset here, because the changes are not provably ours.
DIVERGED_PATHS=$(
  { git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached HEAD 2>/dev/null; } \
  | sort -u | grep -v '^$' || true
)
DIVERGED_COUNT=0
if [ -n "$DIVERGED_PATHS" ]; then
  DIVERGED_COUNT=$(printf '%s\n' "$DIVERGED_PATHS" | wc -l | tr -d ' ')
fi

# Already up-to-date — nothing to sync.
if [ "$HEAD_SHA" = "$ORIGIN_MAIN" ]; then
  if [ "$DIVERGED_COUNT" -gt 0 ]; then
    echo "[orchestrator-state] WARN: parent index/working tree differs from HEAD in ${DIVERGED_COUNT} path(s)"
    printf '%s\n' "$DIVERGED_PATHS" | head -10 | sed 's/^/[orchestrator-state]         /'
    echo "[orchestrator-state] Inspect: git -C \"${PARENT_ROOT}\" status"
    echo "[orchestrator-state] If the changes are not yours: git -C \"${PARENT_ROOT}\" reset --hard origin/main"
  fi
  exit 0
fi

# 3. Sync needed. Check working tree cleanliness BEFORE any destructive op.
#    "Clean" = no tracked files modified/staged/deleted. Untracked files are
#    allowed (reset --hard preserves them) — they include .worktrees/ +
#    in-flight backlog task drafts.
DIRTY_TRACKED=$(git status --porcelain 2>/dev/null | grep -vE "^\?\?" | head -1 || true)
if [ -n "$DIRTY_TRACKED" ]; then
  # AISDLC-369: "behind on main with no local edits" can manifest as tracked
  # modifications when the only dirty paths are backlog task lifecycle files
  # (backlog/tasks/*.md or backlog/completed/*.md) that were moved by a
  # pipeline run or pre-push hook and staged/modified in the parent instead
  # of the worktree. These modifications WILL be resolved by reset --hard to
  # origin/main (because origin/main already has the correct state). We detect
  # this case and proceed with the reset rather than refusing.
  #
  # Safety check: all dirty tracked paths must match the backlog task pattern.
  # We use `git diff --name-only HEAD` + `git diff --name-only --cached HEAD`
  # to enumerate changed paths without relying on porcelain's quoted-path
  # format (which uses C-style quoting for filenames with spaces).
  # If ANY changed path is outside backlog/{tasks,completed}/, we still refuse.
  ALL_DIRTY_PATHS=$(
    { git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached HEAD 2>/dev/null; } \
    | sort -u
  )
  NON_BACKLOG=$(echo "$ALL_DIRTY_PATHS" | grep -vE '^backlog/(tasks|completed)/' | grep -v '^$' | head -1 || true)
  if [ -n "$NON_BACKLOG" ]; then
    echo "[orchestrator-state] WARN: parent working tree has uncommitted tracked changes; skipping reset"
    echo "[orchestrator-state]       ${PARENT_ROOT}"
    git status --porcelain | grep -vE "^\?\?" | head -10 | sed 's/^/[orchestrator-state]         /'
    echo "[orchestrator-state] Resolve manually: stash, commit, or discard. Then re-run."
    exit 0
  fi
  # AISDLC-708: resetting is only harmless when every dirty path already holds
  # exactly what origin/main has (or is absent in both). Anything else is a local
  # change we did not create: refuse instead of resetting over it.
  UNSAFE_PATHS=""
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if git cat-file -e "${ORIGIN_MAIN}:${p}" 2>/dev/null; then
      # Present on origin/main: index and working tree must both match it.
      if ! git diff --quiet "$ORIGIN_MAIN" -- "$p" 2>/dev/null \
        || ! git diff --quiet --cached "$ORIGIN_MAIN" -- "$p" 2>/dev/null; then
        UNSAFE_PATHS="${UNSAFE_PATHS}${p}"$'\n'
      fi
    else
      # Gone on origin/main: only harmless if also gone from index and tree.
      if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || [ -e "$p" ]; then
        UNSAFE_PATHS="${UNSAFE_PATHS}${p}"$'\n'
      fi
    fi
  done <<< "$ALL_DIRTY_PATHS"
  if [ -n "$UNSAFE_PATHS" ]; then
    echo "[orchestrator-state] WARN: parent has backlog changes that differ from origin/main (not created by this check); skipping reset"
    printf '%s' "$UNSAFE_PATHS" | head -10 | sed 's/^/[orchestrator-state]         /'
    echo "[orchestrator-state] Resolve manually: git -C \"${PARENT_ROOT}\" status, then stash/commit, or discard with reset --hard origin/main if they are not yours."
    exit 0
  fi
  echo "[orchestrator-state] auto-recovering: dirty paths are backlog task lifecycle files identical to origin/main (will be resolved by reset)"
  git status --porcelain | grep -vE "^\?\?" | head -10 | sed 's/^/[orchestrator-state]   staging: /'
fi

# Reset HEAD + working tree in one op (also moves refs/heads/main since HEAD
# is the symref pointing at it). Untracked files survive.
echo "[orchestrator-state] resetting parent working tree: $HEAD_SHA -> $ORIGIN_MAIN"
git reset --hard "$ORIGIN_MAIN" >/dev/null
echo "[orchestrator-state] parent now at $(git rev-parse --short HEAD)"

# AISDLC-708: built output is untracked, so a reset leaves it stale. Warn (no
# auto-build) when a package's sources changed and its dist exists.
for pkg_spec in "pipeline-cli:@ai-sdlc/pipeline-cli" "orchestrator:@ai-sdlc/orchestrator"; do
  pkg_dir="${pkg_spec%%:*}"
  pkg_name="${pkg_spec#*:}"
  if [ -d "${pkg_dir}/dist" ] && [ -n "$(git diff --name-only "$HEAD_SHA" "$ORIGIN_MAIN" -- "${pkg_dir}/src" 2>/dev/null | head -1)" ]; then
    echo "[orchestrator-state] WARN: ${pkg_dir}/dist is stale (sources changed in this sync). Rebuild: pnpm --filter ${pkg_name} build"
  fi
done

exit 0
