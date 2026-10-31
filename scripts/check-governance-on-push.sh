#!/usr/bin/env bash
# AISDLC-1123: pre-push copy of the deterministic CI governance checks, run over the push
# range (origin/main merge-base..HEAD) so a red CI would raise is fixed before the push. Same scripts,
# same arguments as CI; CI stays the only merge gate. Reads git's pre-push stdin.
#
#   conflict markers  added lines starting with a conflict marker refuse the push.
#   waived-tests      check-pr-governance.mjs waived-tests (AISDLC-1022).
#   reviewers         check-pr-governance.mjs reviewers, only when the range already adds an
#                     attestation envelope (a draft pushed before the reviewers ran has none)
#                     and the push is not docs-only.
#   backlog drift     only when the range deletes or renames a file that backlog/ mentions.
#   gate tests        scripts/run-gate-tests.mjs, only when a gate test directory changed and
#                     the push is not docs-only.
#   attestation verify runs in check-attestation-sign.sh (AISDLC-694), via pre-push-fixups.sh.
#
# Skip with AI_SDLC_SKIP_GOVERNANCE_GATE=1. Emergency: AI_SDLC_BYPASS_ALL_GATES=1.

set -euo pipefail

if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[governance-gate] AI_SDLC_BYPASS_ALL_GATES=1 - skipping" >&2
  exit 0
fi
if [ "${AI_SDLC_SKIP_GOVERNANCE_GATE:-}" = "1" ]; then
  echo "[governance-gate] AI_SDLC_SKIP_GOVERNANCE_GATE=1 - skipping" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel)"
ALL_ZEROS="0000000000000000000000000000000000000000"
BLOCKED=0

while read -r _LOCAL_REF LOCAL_SHA _REMOTE_REF REMOTE_SHA; do
  [ -z "${LOCAL_SHA:-}" ] && continue
  [ "$LOCAL_SHA" = "$ALL_ZEROS" ] && continue
  # AISDLC-1143: always the origin/main merge-base (the CI range), never the remote head: after
  # a rebase the remote-head merge-base is the old fork point and sweeps in landed main commits.
  git show-ref --verify --quiet refs/remotes/origin/main || continue
  BASE="$(git merge-base "$LOCAL_SHA" origin/main 2>/dev/null || true)"
  [ -z "$BASE" ] && continue

  FILES="$(git diff --name-only --no-renames "$BASE..$LOCAL_SHA")"
  [ -z "$FILES" ] && continue
  DOCS_ONLY=false
  if printf '%s\n' "$FILES" | node scripts/is-docs-only-changeset.mjs >/dev/null 2>&1; then
    DOCS_ONLY=true
  fi

  # Conflict markers in added lines (any file).
  if git diff -U0 --no-renames "$BASE..$LOCAL_SHA" | grep -E '^\+(<<<<<<< |=======$|>>>>>>> )' >/dev/null; then
    echo "[governance-gate] conflict marker left in the push range $BASE..$LOCAL_SHA" >&2
    git diff -U0 --no-renames "$BASE..$LOCAL_SHA" | grep -nE '^\+(<<<<<<< |=======$|>>>>>>> )' >&2 || true
    BLOCKED=$((BLOCKED + 1))
  fi

  if ! node scripts/check-pr-governance.mjs waived-tests --base "$BASE" --head "$LOCAL_SHA" </dev/null; then
    BLOCKED=$((BLOCKED + 1))
  fi

  if [ "$DOCS_ONLY" = "false" ] \
    && [ -n "$(git diff --name-only --no-renames --diff-filter=A "$BASE..$LOCAL_SHA" -- .ai-sdlc/attestations/)" ]; then
    if ! node scripts/check-pr-governance.mjs reviewers --base "$BASE" --head "$LOCAL_SHA" </dev/null; then
      BLOCKED=$((BLOCKED + 1))
    fi
  fi

  # Backlog drift: only a removed or renamed file that backlog/ references can cause it.
  DRIFT=0
  while IFS= read -r GONE; do
    [ -z "$GONE" ] && continue
    case "$GONE" in backlog/*) continue ;; esac
    if grep -rlF -- "$GONE" backlog/ >/dev/null 2>&1; then DRIFT=1; break; fi
  done <<EOF_GONE
$(git diff --name-only --diff-filter=DR "$BASE..$LOCAL_SHA")
EOF_GONE
  if [ "$DRIFT" = "1" ]; then
    echo "[governance-gate] a removed file is referenced from backlog/; running backlog-drift" >&2
    if ! npx backlog-drift@0.1.3 check </dev/null; then
      echo "[governance-gate] backlog drift: fix with npx backlog-drift fix --task <id>" >&2
      BLOCKED=$((BLOCKED + 1))
    fi
  fi

  if [ "$DOCS_ONLY" = "false" ] \
    && printf '%s\n' "$FILES" | grep -qE '^(scripts/|\.github/workflows/__tests__/|ai-sdlc-plugin/(agents|commands|hooks|scripts)/)'; then
    if ! node scripts/run-gate-tests.mjs </dev/null; then
      BLOCKED=$((BLOCKED + 1))
    fi
  fi
done

if [ "$BLOCKED" -gt 0 ]; then
  echo "[governance-gate] push blocked: fix the findings above and re-run git push." >&2
  echo "[governance-gate] Defer (NOT recommended) with: AI_SDLC_SKIP_GOVERNANCE_GATE=1 git push" >&2
  exit 1
fi
exit 0
