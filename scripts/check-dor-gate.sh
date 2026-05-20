#!/usr/bin/env bash
# AISDLC-370: pre-push DoR gate. Catches gate-2 markers, gate-3 unresolved
# references, gate-7 dependency phrases, and upstream-OQ blocks on any
# `backlog/{tasks,completed}/*.md` files staged in this push BEFORE CI runs.
#
# Reads stdin per git's pre-push hook contract:
#   <local ref> <local sha> <remote ref> <remote sha>
# For each push, computes the range `<remote sha>..<local sha>` and asks
# `cli-dor-check --staged --push-range` to walk the touched task files.
#
# Skip with AI_SDLC_SKIP_DOR_GATE=1.
# No-op when the bin isn't built yet (fresh worktree before pnpm build).

set -euo pipefail

if [ "${AI_SDLC_SKIP_DOR_GATE:-}" = "1" ]; then
  echo "[dor-gate] AI_SDLC_SKIP_DOR_GATE=1 — skipping"
  exit 0
fi

# Locate the bin. Fresh worktrees may not have built pipeline-cli yet —
# in that case no-op so the hook doesn't block a first-build push.
BIN="pipeline-cli/bin/cli-dor-check.mjs"
DIST="pipeline-cli/dist/cli/dor-check.js"
if [ ! -f "$BIN" ] || [ ! -f "$DIST" ]; then
  # Bin or compiled module missing — fresh worktree. Silently skip.
  exit 0
fi

# Parse pre-push stdin protocol. Each line: <local ref> <local sha> <remote ref> <remote sha>
# Aggregate every touched task file across all push lines, then run ONE check.
TASK_FILES=""
ALL_ZEROS="0000000000000000000000000000000000000000"

while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  # Skip deletions and pushes that aren't to a real ref
  if [ "$LOCAL_SHA" = "$ALL_ZEROS" ]; then continue; fi

  if [ "$REMOTE_SHA" = "$ALL_ZEROS" ]; then
    # New branch — compare against origin/main as the base
    if git show-ref --verify --quiet refs/remotes/origin/main; then
      RANGE_BASE=$(git merge-base "$LOCAL_SHA" origin/main 2>/dev/null || echo "")
      [ -z "$RANGE_BASE" ] && continue
    else
      # No origin/main locally — fall back to checking just the HEAD commit
      RANGE_BASE="${LOCAL_SHA}^"
    fi
  else
    RANGE_BASE="$REMOTE_SHA"
  fi

  # Collect changed task files in this range
  RANGE_FILES=$(git diff --name-only --diff-filter=AMR "${RANGE_BASE}..${LOCAL_SHA}" -- 'backlog/tasks/**.md' 'backlog/completed/**.md' 2>/dev/null || true)
  if [ -n "$RANGE_FILES" ]; then
    TASK_FILES="${TASK_FILES}${RANGE_FILES}
"
  fi
done

# Deduplicate task files
TASK_FILES=$(printf '%s' "$TASK_FILES" | sort -u | sed '/^$/d')

if [ -z "$TASK_FILES" ]; then
  # No backlog task changes in this push — nothing to check
  exit 0
fi

echo "[dor-gate] checking $(echo "$TASK_FILES" | wc -l | tr -d ' ') backlog task file(s)..."

BLOCKED=0
while IFS= read -r FILE; do
  [ -z "$FILE" ] && continue
  if ! node "$BIN" --task "$FILE"; then
    BLOCKED=$((BLOCKED + 1))
  fi
done <<< "$TASK_FILES"

if [ "$BLOCKED" -gt 0 ]; then
  echo ""
  echo "[dor-gate] $BLOCKED DoR violation(s) in staged backlog tasks."
  echo "[dor-gate] Fix the offending task body and re-run git push."
  echo "[dor-gate] Defer this gate (NOT recommended) with: AI_SDLC_SKIP_DOR_GATE=1 git push"
  exit 1
fi

echo "[dor-gate] all $(echo "$TASK_FILES" | wc -l | tr -d ' ') task file(s) passed DoR"
exit 0
