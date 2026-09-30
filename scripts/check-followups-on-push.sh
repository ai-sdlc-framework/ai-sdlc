#!/usr/bin/env bash
# Pre-push follow-up gate. Reads git's pre-push stdin
# (<local ref> <local sha> <remote ref> <remote sha>), computes the push range
# per ref and runs `check-followups.mjs --staged --push-range` so only completed
# task files added/modified in the range are checked. Blocks on a violation and
# on any script error (fail closed).
#
# Skip with AI_SDLC_SKIP_FOLLOWUP_GATE=1. AI_SDLC_BYPASS_ALL_GATES=1 also skips.

set -euo pipefail

if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[followup-gate] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi
if [ "${AI_SDLC_SKIP_FOLLOWUP_GATE:-}" = "1" ]; then
  echo "[followup-gate] AI_SDLC_SKIP_FOLLOWUP_GATE=1 — skipping"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECK="$SCRIPT_DIR/check-followups.mjs"
ALL_ZEROS="0000000000000000000000000000000000000000"
BLOCKED=0

while read -r LOCAL_REF LOCAL_SHA REMOTE_REF REMOTE_SHA; do
  if [ "$LOCAL_SHA" = "$ALL_ZEROS" ]; then continue; fi

  if [ "$REMOTE_SHA" = "$ALL_ZEROS" ]; then
    if git show-ref --verify --quiet refs/remotes/origin/main; then
      RANGE_BASE=$(git merge-base "$LOCAL_SHA" origin/main 2>/dev/null || echo "")
      [ -z "$RANGE_BASE" ] && continue
    else
      RANGE_BASE="${LOCAL_SHA}^"
    fi
  else
    RANGE_BASE="$REMOTE_SHA"
  fi

  if ! node "$CHECK" --staged --push-range "${RANGE_BASE}..${LOCAL_SHA}"; then
    BLOCKED=$((BLOCKED + 1))
  fi
done

if [ "$BLOCKED" -gt 0 ]; then
  echo "[followup-gate] push blocked: fix the Follow-up section and re-run git push." >&2
  echo "[followup-gate] Defer this gate (NOT recommended) with: AI_SDLC_SKIP_FOLLOWUP_GATE=1 git push" >&2
  exit 1
fi
exit 0
