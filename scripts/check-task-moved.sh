#!/usr/bin/env bash
#
# AISDLC-220: Auto-move backlog task file to completed/ in the originating PR's
# pre-push hook when the commit subject contains (AISDLC-N). This removes the
# need for the retired `.github/workflows/backlog-task-complete.yml` workflow
# (which created orphan chore PRs after merge per the "mechanical → hook, never
# workflow" pattern).
#
# Why this exists: `backlog-task-complete.yml` created a separate follow-up PR
# to move the task file after every code PR merged. This split a single logical
# change across two PRs, and GITHUB_TOKEN-pushed PRs don't fire CI or trigger
# auto-enable-auto-merge — producing orphan PRs that never auto-merged.
#
# Behaviour:
#
#   1. Honour AI_SDLC_SKIP_TASK_MOVE=1 (operator deferral / manual move).
#   2. Locate the push range from husky's pre-push args ($1 remote, $2 url) via
#      stdin. Parse lines: `<local-ref> <local-sha> <remote-ref> <remote-sha>`.
#      Fall back to HEAD~1..HEAD if stdin is empty or all-zeros remote SHA.
#   3. Scan every commit subject in the range for `(AISDLC-N)` or `(AISDLC-N.M)`
#      patterns (case-insensitive prefix). For each task ID found:
#      a. Skip if `backlog/completed/aisdlc-N - *.md` already exists at HEAD
#         (move already on HEAD — idempotent path).
#      b. Skip if `backlog/tasks/aisdlc-N - *.md` does NOT exist (nothing to move).
#      c. Otherwise: invoke `node pipeline-cli/bin/cli-task-complete.mjs AISDLC-N`,
#         stage the moved file, and record it for the chore commit.
#   4. If any moves were staged, create a single
#      `chore: auto-close AISDLC-N1[, AISDLC-N2 ...] (AISDLC-220)` commit
#      and exit 1 with a clear "re-run git push" message.
#   5. If all tasks were already moved (or nothing to move), exit 0.
#
# Activation: invoked from `.husky/pre-push` AFTER the coverage gate and
# BEFORE the attestation-sign gate. Order is load-bearing (see AISDLC-220 AC
# #2): attestation's contentHashV4 binds {path, headBlobSha} per file. If the
# task move happens AFTER attestation sign, the envelope hashes the OLD path
# (`backlog/tasks/…`) but the actual PR diff contains the NEW path
# (`backlog/completed/…`) — verify-attestation will reject the envelope.
# Order in `.husky/pre-push`: check-coverage.sh → check-task-moved.sh →
# check-attestation-sign.sh.
#
# Override:
#   AI_SDLC_SKIP_TASK_MOVE=1 git push
# Use only when deferring the move for a manual git mv (e.g. operator wants
# to control exactly which commit the move lands in).
#
# Exit codes:
#   0 — nothing to move (no matching task IDs, or all already in completed/),
#       or AI_SDLC_SKIP_TASK_MOVE=1 short-circuit.
#   1 — moved one or more task files + committed the chore; push aborted;
#       operator must re-run `git push` to send the new chore commit.
#   2 — cli-task-complete invocation failed or post-move integrity error.

set -euo pipefail

# ── Step 1: env-var deferral ─────────────────────────────────────────
if [ "${AI_SDLC_SKIP_TASK_MOVE:-0}" = "1" ]; then
  echo "[task-move] AI_SDLC_SKIP_TASK_MOVE=1 — skipping auto-close" >&2
  exit 0
fi

# ── Step 2: locate worktree root ─────────────────────────────────────
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '')
if [ -z "$WT_ROOT" ]; then
  # Not a git repo (shouldn't happen in pre-push, but defend anyway).
  exit 0
fi

# ── Step 3: resolve the push range ───────────────────────────────────
# Husky writes push info to stdin in the format:
#   <local-ref> <local-sha> <remote-ref> <remote-sha>
# We read only the first push line (handles single-branch pushes; the common
# case). When remote-sha is all zeros (`0000000000000000000000000000000000000000`)
# this is a new branch — diff from the merge-base with origin/main.
NULL_SHA="0000000000000000000000000000000000000000"

LOCAL_SHA=""
REMOTE_SHA=""

while read -r LOCAL_REF LOCAL_SHA_STDIN REMOTE_REF REMOTE_SHA_STDIN; do
  LOCAL_SHA="$LOCAL_SHA_STDIN"
  REMOTE_SHA="$REMOTE_SHA_STDIN"
  break  # only need first line
done

# If stdin was empty (direct invocation in tests / non-husky context),
# or if we only received partial data, fall back to HEAD.
if [ -z "$LOCAL_SHA" ]; then
  LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
fi
if [ -z "$REMOTE_SHA" ] || [ "$REMOTE_SHA" = "$NULL_SHA" ]; then
  # New branch — scan from merge-base with origin/main, or HEAD~1..HEAD.
  MERGE_BASE=$(git merge-base HEAD "origin/main" 2>/dev/null || echo '')
  if [ -n "$MERGE_BASE" ]; then
    REMOTE_SHA="$MERGE_BASE"
  else
    REMOTE_SHA=$(git rev-parse 'HEAD~1' 2>/dev/null || echo '')
    if [ -z "$REMOTE_SHA" ]; then
      # Single-commit history: use empty tree SHA.
      REMOTE_SHA=$(git hash-object -t tree /dev/null 2>/dev/null || echo '')
    fi
  fi
fi

if [ -z "$LOCAL_SHA" ]; then
  echo "[task-move] WARN: cannot resolve HEAD SHA; skipping" >&2
  exit 0
fi

# ── Step 4: scan commit subjects for (AISDLC-N) patterns ─────────────
# git log range: REMOTE_SHA..LOCAL_SHA (commits that are in LOCAL but not yet
# in REMOTE, i.e., the commits being pushed).
TASK_IDS_RAW=$(
  git log --format='%s' "${REMOTE_SHA}..${LOCAL_SHA}" 2>/dev/null \
    | grep -oiE '\(AISDLC-[0-9]+(\.[0-9]+)?\)' \
    | grep -oiE 'AISDLC-[0-9]+(\.[0-9]+)?' \
    | tr '[:lower:]' '[:upper:]' \
    | sort -u \
  || true
)

if [ -z "$TASK_IDS_RAW" ]; then
  # No (AISDLC-N) references in the push range. Nothing to do.
  exit 0
fi

# ── Step 5: for each task ID, decide whether to move ─────────────────
TASKS_TO_MOVE=()

while IFS= read -r TASK_ID; do
  [ -z "$TASK_ID" ] && continue
  TASK_ID_LOWER=$(printf '%s' "$TASK_ID" | tr '[:upper:]' '[:lower:]')

  # Check if already in completed/ (idempotent).
  if compgen -G "$WT_ROOT/backlog/completed/$TASK_ID_LOWER - "*.md > /dev/null 2>&1; then
    echo "[task-move] $TASK_ID already in backlog/completed/ — skipping" >&2
    continue
  fi

  # Check if the task file exists in tasks/.
  if ! compgen -G "$WT_ROOT/backlog/tasks/$TASK_ID_LOWER - "*.md > /dev/null 2>&1; then
    echo "[task-move] $TASK_ID not found in backlog/tasks/ — skipping (nothing to move)" >&2
    continue
  fi

  TASKS_TO_MOVE+=("$TASK_ID")
done <<< "$TASK_IDS_RAW"

if [ "${#TASKS_TO_MOVE[@]}" -eq 0 ]; then
  # All task files already in completed/, or none exist in tasks/. No-op.
  exit 0
fi

# ── Step 5b: idempotency check via HEAD subject ───────────────────────
# Mirror AISDLC-135 loop-prevention from check-attestation-sign.sh: if HEAD
# is already an auto-close chore commit (from a previous run of this hook),
# treat it as "second push of the same cycle" and exit 0.
LAST_COMMIT_SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null || echo '')
if [[ "${LAST_COMMIT_SUBJECT:-}" == "chore: auto-close "* ]]; then
  exit 0
fi

# ── Step 6: invoke cli-task-complete for each task + stage results ────
CLI_TASK_COMPLETE="${AI_SDLC_TASK_COMPLETE_CMD:-}"
MOVED_IDS=()

for TASK_ID in "${TASKS_TO_MOVE[@]}"; do
  TASK_ID_LOWER=$(printf '%s' "$TASK_ID" | tr '[:upper:]' '[:lower:]')
  echo "[task-move] Auto-closing $TASK_ID — invoking cli-task-complete" >&2

  (
    cd "$WT_ROOT"
    # `--allow-already-done` collapses cli-task-complete's exit-2 ("already in completed/")
    # to exit-0. Without it, a benign filesystem race between Step 5's compgen pre-check and
    # the cli invocation surfaces as a hard push abort. With it, the post-move integrity
    # guard at line ~190 still catches genuine failures.
    if [ -n "$CLI_TASK_COMPLETE" ]; then
      # Test override: split on whitespace via word splitting (intentional).
      # shellcheck disable=SC2086
      if ! $CLI_TASK_COMPLETE "$TASK_ID" --allow-already-done; then
        echo "[task-move] ERROR: cli-task-complete (override) failed for $TASK_ID; aborting push" >&2
        exit 2
      fi
    else
      if ! node "$WT_ROOT/pipeline-cli/bin/cli-task-complete.mjs" "$TASK_ID" --allow-already-done; then
        echo "[task-move] ERROR: cli-task-complete.mjs failed for $TASK_ID; aborting push" >&2
        echo "[task-move]        (run \`pnpm --filter @ai-sdlc/pipeline-cli build\` if dist is missing)" >&2
        exit 2
      fi
    fi
  ) || exit 2

  # Verify the move happened as expected.
  if ! compgen -G "$WT_ROOT/backlog/completed/$TASK_ID_LOWER - "*.md > /dev/null 2>&1; then
    echo "[task-move] ERROR: cli-task-complete did not produce backlog/completed/$TASK_ID_LOWER - *.md; aborting push" >&2
    exit 2
  fi

  # Stage the deletion from tasks/ and the addition to completed/.
  (
    cd "$WT_ROOT"
    # Stage removed file(s) in tasks/.
    git add -- "backlog/tasks/" "backlog/completed/"
  ) || {
    echo "[task-move] ERROR: git add of moved files failed for $TASK_ID; aborting push" >&2
    exit 2
  }

  MOVED_IDS+=("$TASK_ID")
done

if [ "${#MOVED_IDS[@]}" -eq 0 ]; then
  exit 0
fi

# ── Step 7: create single chore commit for all moves ─────────────────
MOVED_LABEL=$(IFS=', '; echo "${MOVED_IDS[*]}")

(
  cd "$WT_ROOT"
  git commit --no-verify -m "chore: auto-close $MOVED_LABEL (AISDLC-220)

Auto-generated by .husky/pre-push (scripts/check-task-moved.sh).
Task file(s) moved from backlog/tasks/ to backlog/completed/.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" >&2
) || {
  echo "[task-move] ERROR: git commit of task-move chore failed; aborting push" >&2
  exit 2
}

# ── Step 8: re-push required ─────────────────────────────────────────
{
  echo ""
  echo "[task-move] Hook moved $MOVED_LABEL to backlog/completed/ and committed"
  echo "            a chore commit on top of HEAD. The push you just attempted"
  echo "            does NOT include that new commit — re-run \`git push\` to"
  echo "            send it."
  echo ""
  echo "            The next push is a no-op for this hook (idempotent: the"
  echo "            task file already exists in backlog/completed/ at the new HEAD)."
  echo ""
  echo "            Defer with: AI_SDLC_SKIP_TASK_MOVE=1 git push"
} >&2

exit 1
