#!/usr/bin/env bash
#
# AISDLC-486: Pre-push backlog-drift gate — catch new error-severity drift
# BEFORE pushing so the required CI "Backlog Drift" gate is satisfied locally.
#
# ## Why this exists
# PR #789 (AISDLC-474) renamed `ai-sdlc-plugin/commands/review.md` to
# `review-pr.md`. The backlog task AISDLC-71 had a frontmatter reference to
# the old path. After the rename, `backlog-drift check` flagged the task as
# error-severity (`✗ Referenced file no longer exists: …`), blocking the PR
# until manually fixed. The developer subagent that performed the rename did
# not search for or update inbound references. This script is the LOCAL gate
# that catches that class of issue before push.
#
# ## What it checks
# TWO complementary checks run in sequence:
#
# 1. Inbound-reference scan (rename/move/delete detection):
#    For every file renamed, moved, or deleted in the push range, grep
#    `backlog/` for references to the OLD path. Any match means a backlog task
#    will have a dangling reference after this push. This is always a NEW error
#    (the rename/delete itself is what creates it), so it always blocks.
#
# 2. Full-repo backlog-drift error scan (NEW errors only):
#    Run `npx backlog-drift check --json` on the tasks TOUCHED in this push
#    only (via --since <merge-base>). This catches drift errors introduced by
#    changes to backlog task files themselves (e.g. a reference added to a
#    task that points to a non-existent file).
#    Note: pre-existing repo-wide errors (in tasks NOT touched by this push)
#    are NOT surfaced here — they are a pre-existing condition that would
#    block all pushes unfairly. The full CI scan catches those.
#
# ## How it fits into the pre-push chain
# Runs AFTER the coverage + DoR gates (which can fail on unrelated issues) and
# BEFORE the attestation-sign fixup. Skip individually with
# AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1 or all gates with
# AI_SDLC_BYPASS_ALL_GATES=1.
#
# ## Escape hatches
#   AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1  — skip just this gate
#   AI_SDLC_BYPASS_ALL_GATES=1              — skip ALL pre-push gates
#   git push --no-verify                    — skip the entire pre-push chain
#
# ## Exit codes
#   0 — no new error-severity drift introduced by this push
#   1 — this push introduces new error-severity drift (stale backlog references)

set -euo pipefail

# ── Master bypass ─────────────────────────────────────────────────────
if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[backlog-drift-push] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

if [ "${AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE:-}" = "1" ]; then
  echo "[backlog-drift-push] AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1 — skipping" >&2
  exit 0
fi

# ── Locate repo root ──────────────────────────────────────────────────
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '')
if [ -z "$WT_ROOT" ]; then
  exit 0
fi

ALL_ZEROS="0000000000000000000000000000000000000000"

# ── Parse push range from stdin ───────────────────────────────────────
# Pre-push stdin: <local ref> <local sha> <remote ref> <remote sha>
PUSH_STDIN="$(cat || true)"

# Aggregate deleted/renamed files and touched task files across all push lines
DELETED_OR_RENAMED=""
EARLIEST_RANGE_BASE=""

while IFS= read -r line; do
  [ -z "$line" ] && continue
  LOCAL_SHA=$(printf '%s' "$line" | awk '{print $2}')
  REMOTE_SHA=$(printf '%s' "$line" | awk '{print $4}')

  # Skip deletions
  [ "$LOCAL_SHA" = "$ALL_ZEROS" ] && continue

  if [ "$REMOTE_SHA" = "$ALL_ZEROS" ]; then
    # New branch — compare against origin/main as the base
    if git show-ref --verify --quiet refs/remotes/origin/main; then
      RANGE_BASE=$(git merge-base "$LOCAL_SHA" origin/main 2>/dev/null || echo "")
      [ -z "$RANGE_BASE" ] && continue
    else
      RANGE_BASE="${LOCAL_SHA}^"
    fi
  else
    RANGE_BASE="$REMOTE_SHA"
  fi

  # Track the earliest range base for the task-level drift check
  if [ -z "$EARLIEST_RANGE_BASE" ]; then
    EARLIEST_RANGE_BASE="$RANGE_BASE"
  fi

  # Collect renamed/deleted files (these create inbound-reference drift)
  # diff-filter=D catches Deleted, R catches Renamed (with old name in col 1)
  RANGE_CHANGES=$(
    git diff --name-status --diff-filter=DR "${RANGE_BASE}..${LOCAL_SHA}" 2>/dev/null || true
  )
  if [ -n "$RANGE_CHANGES" ]; then
    DELETED_OR_RENAMED="${DELETED_OR_RENAMED}${RANGE_CHANGES}
"
  fi
done <<< "$PUSH_STDIN"

FAILED=0

# ── Check 1: inbound-reference scan ──────────────────────────────────
# For each deleted or renamed file, grep backlog/ for references to the OLD path.
# This always indicates NEW drift introduced by this push.
INBOUND_FAILURES=()

if [ -n "$DELETED_OR_RENAMED" ] && [ -d "${WT_ROOT}/backlog" ]; then
  while IFS= read -r status_line; do
    [ -z "$status_line" ] && continue

    STATUS=$(printf '%s' "$status_line" | awk '{print $1}')

    case "$STATUS" in
      D)
        OLD_PATH=$(printf '%s' "$status_line" | awk '{print $2}')
        ;;
      R*)
        # R<score>  old-path  new-path
        OLD_PATH=$(printf '%s' "$status_line" | awk '{print $2}')
        ;;
      *)
        continue
        ;;
    esac

    # grep the backlog/ subtree for literal references to the old path.
    # Search for the full path to minimize false positives on common basenames.
    MATCHES=$(
      grep -rl --include="*.md" "$OLD_PATH" "${WT_ROOT}/backlog/" 2>/dev/null || true
    )

    if [ -n "$MATCHES" ]; then
      while IFS= read -r match_file; do
        [ -z "$match_file" ] && continue
        REL_MATCH="${match_file#"${WT_ROOT}/"}"
        INBOUND_FAILURES+=("${OLD_PATH}  →  ${REL_MATCH}")
      done <<< "$MATCHES"
    fi
  done <<< "$DELETED_OR_RENAMED"
fi

if [ ${#INBOUND_FAILURES[@]} -gt 0 ]; then
  FAILED=1
  echo "" >&2
  echo "[backlog-drift-push] ERROR: This push renames/deletes files that are" >&2
  echo "  still referenced by backlog tasks. The CI Backlog Drift gate WILL fail." >&2
  echo "" >&2
  for failure in "${INBOUND_FAILURES[@]}"; do
    echo "  ✗ ${failure}" >&2
  done
  echo "" >&2
  echo "  Fix: update the backlog references to the new path, then re-commit." >&2
  echo "  Auto-fix: npx backlog-drift fix --task <TASK-ID>" >&2
  echo "" >&2
fi

# ── Check 2: task-level drift scan for touched tasks ──────────────────
# Run backlog-drift check scoped to tasks touched in this push only.
# This catches errors introduced by edits to backlog task files themselves.
# We use --since <range-base> to scope to only tasks changed in this push.
if [ -n "$EARLIEST_RANGE_BASE" ]; then
  DRIFT_ERRORS=""
  DRIFT_JSON=$(
    cd "$WT_ROOT" && npx backlog-drift check --since "$EARLIEST_RANGE_BASE" --json 2>/dev/null
  ) || true

  if [ -n "$DRIFT_JSON" ]; then
    DRIFT_ERRORS=$(
      printf '%s' "$DRIFT_JSON" \
        | node --input-type=module --eval "
          let buf = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', d => buf += d);
          process.stdin.on('end', () => {
            try {
              const items = JSON.parse(buf);
              const errors = items.filter(x => x.severity === 'error');
              for (const e of errors) {
                process.stdout.write(e.taskId + ': ' + e.message + '\n');
              }
            } catch {}
          });
        " 2>/dev/null
    ) || true
  fi

  if [ -n "$DRIFT_ERRORS" ]; then
    FAILED=1
    echo "" >&2
    echo "[backlog-drift-push] ERROR: backlog tasks changed in this push have" >&2
    echo "  error-severity drift issues. The CI Backlog Drift gate WILL fail." >&2
    echo "" >&2
    while IFS= read -r err_line; do
      [ -z "$err_line" ] && continue
      echo "  ✗ ${err_line}" >&2
    done <<< "$DRIFT_ERRORS"
    echo "" >&2
    echo "  Run: npx backlog-drift check   (see full details)" >&2
    echo "  Run: npx backlog-drift fix --task <TASK-ID>   (auto-fix)" >&2
    echo "" >&2
  fi
fi

if [ "$FAILED" -eq 1 ]; then
  echo "[backlog-drift-push] Push blocked: fix the above drift errors before pushing." >&2
  echo "  Escape: AI_SDLC_SKIP_BACKLOG_DRIFT_PUSH_GATE=1 git push" >&2
  exit 1
fi

exit 0
