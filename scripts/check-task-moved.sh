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
#   3. Select exactly ONE task id (AISDLC-683, DEC-0028): the `<worktree>/.active-task`
#      sentinel id when present (and cited in the range), else from the
#      `(AISDLC-N[.M])` ids cited in the range: ignore id-less subjects and the
#      chore ids AISDLC-133 / AISDLC-220, drop any id that is a STRICT ancestor
#      of another cited id (656 is dropped when 656.1 is cited; 656.1 is not an
#      ancestor of 656.2), and select the id if exactly one remains. More than
#      one => do nothing and print the ids seen.
#      For the selected id:
#      0. Skip (and print the open children) if `backlog/tasks/aisdlc-N.*`
#         child tasks exist — an umbrella is never closed implicitly.
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

if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[task-move] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

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
#
# AISDLC-683: a commit may legitimately CITE other tasks (e.g. a sub-task
# commit naming its umbrella). Citation therefore does NOT mean "this task is
# done". Exactly one task is selected for auto-close:
#   1. the id in the per-worktree `.active-task` sentinel, when present and
#      well-formed (it must also be cited by at least one commit subject in the
#      range, so a stale sentinel cannot close an unrelated task); else
#   2. (DEC-0028) from the ids cited in the range: id-less subjects contribute
#      nothing, the chore ids below are ignored, and any id that is a STRICT
#      ancestor of another cited id is dropped (AISDLC-656 when AISDLC-656.1 is
#      cited; AISDLC-656.1 is NOT an ancestor of AISDLC-656.2). Exactly one id
#      left => select it; more than one => do nothing and print the ids seen.
# Ids that the pre-push chore commits themselves carry (sign / auto-close).
CHORE_IDS="AISDLC-133 AISDLC-220"

extract_ids() {
  # stdin: one commit subject; stdout: sorted-unique upper-case task ids.
  { grep -oiE '\(AISDLC-[0-9]+(\.[0-9]+)?\)' || true; } \
    | { grep -oiE 'AISDLC-[0-9]+(\.[0-9]+)?' || true; } \
    | tr '[:lower:]' '[:upper:]' \
    | sort -u
}

SUBJECTS=$(git log --format='%s' "${REMOTE_SHA}..${LOCAL_SHA}" 2>/dev/null || true)

ALL_SEEN=""   # union of ids across all subjects (newline separated)
while IFS= read -r SUBJECT; do
  [ -z "$SUBJECT" ] && continue
  SUBJECT_IDS=$(printf '%s\n' "$SUBJECT" | extract_ids)
  if [ -n "$SUBJECT_IDS" ]; then
    ALL_SEEN=$(printf '%s\n%s\n' "$ALL_SEEN" "$SUBJECT_IDS" | sed '/^$/d' | sort -u)
  fi
done <<< "$SUBJECTS"

if [ -z "$ALL_SEEN" ]; then
  # No (AISDLC-N) references in the push range. Nothing to do.
  exit 0
fi

SENTINEL_ID=""
SENTINEL_FILE="$WT_ROOT/.active-task"
if [ -f "$SENTINEL_FILE" ]; then
  SENTINEL_RAW=$(tr -d '[:space:]' < "$SENTINEL_FILE" 2>/dev/null || true)
  if printf '%s' "$SENTINEL_RAW" | grep -qiE '^AISDLC-[0-9]+(\.[0-9]+)?$'; then
    SENTINEL_ID=$(printf '%s' "$SENTINEL_RAW" | tr '[:lower:]' '[:upper:]')
  elif [ -n "$SENTINEL_RAW" ]; then
    echo "[task-move] WARN: .active-task value '$SENTINEL_RAW' is not an AISDLC task id; ignoring sentinel" >&2
  fi
fi

SELECTED_ID=""
if [ -n "$SENTINEL_ID" ]; then
  if printf '%s\n' "$ALL_SEEN" | grep -qxF "$SENTINEL_ID"; then
    SELECTED_ID="$SENTINEL_ID"
  else
    echo "[task-move] .active-task is $SENTINEL_ID but no commit subject in the push range cites it — not auto-closing" >&2
    exit 0
  fi
else
  # Cited ids minus the chore ids.
  CITED=""
  while IFS= read -r CAND; do
    [ -z "$CAND" ] && continue
    IS_CHORE=0
    for CHORE in $CHORE_IDS; do
      if [ "$CAND" = "$CHORE" ]; then IS_CHORE=1; fi
    done
    if [ "$IS_CHORE" -eq 1 ]; then continue; fi
    CITED=$(printf '%s\n%s\n' "$CITED" "$CAND" | sed '/^$/d')
  done <<< "$ALL_SEEN"

  # Drop any id that is a strict ancestor of another cited id (N is an
  # ancestor of N.M; N.M is not an ancestor of N.K).
  LEAVES=""
  while IFS= read -r CAND; do
    [ -z "$CAND" ] && continue
    HAS_DESCENDANT=0
    while IFS= read -r OTHER; do
      [ -z "$OTHER" ] && continue
      case "$OTHER" in
        "$CAND".*) HAS_DESCENDANT=1 ;;
      esac
    done <<< "$CITED"
    if [ "$HAS_DESCENDANT" -eq 1 ]; then continue; fi
    LEAVES=$(printf '%s\n%s\n' "$LEAVES" "$CAND" | sed '/^$/d')
  done <<< "$CITED"

  LEAF_COUNT=$(printf '%s\n' "$LEAVES" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$LEAF_COUNT" -eq 1 ]; then
    SELECTED_ID=$(printf '%s\n' "$LEAVES" | sed '/^$/d')
  elif [ "$LEAF_COUNT" -eq 0 ]; then
    # Only chore ids were cited — nothing to close.
    exit 0
  else
    SEEN_LABEL=$(printf '%s\n' "$LEAVES" | paste -sd ',' - | sed 's/,/, /g')
    echo "[task-move] cannot pick a single task to auto-close without an .active-task sentinel (ids seen in push range: $SEEN_LABEL) — not auto-closing" >&2
    exit 0
  fi
fi
TASK_IDS_RAW="$SELECTED_ID"

# ── Step 5: decide whether to move the selected task ─────────────────
TASKS_TO_MOVE=()

while IFS= read -r TASK_ID; do
  [ -z "$TASK_ID" ] && continue
  TASK_ID_LOWER=$(printf '%s' "$TASK_ID" | tr '[:upper:]' '[:lower:]')

  # Check if already in completed/ — use git ls-files so we match git-tracked
  # state rather than filesystem state. Silent exit 0 (no log noise, no chore
  # commit) — this is the normal path for /ai-sdlc execute PRs where the dev
  # subagent already moved the file before push. (AISDLC-402)
  # -c core.quotePath=false ensures non-ASCII filenames render unquoted so the
  # grep pattern matches consistently regardless of unicode chars in titles.
  if git -C "$WT_ROOT" -c core.quotePath=false ls-files "backlog/completed/" 2>/dev/null | \
      grep -qi "^backlog/completed/$TASK_ID_LOWER "; then
    continue
  fi

  # Check if the task file exists in tasks/.
  if ! compgen -G "$WT_ROOT/backlog/tasks/$TASK_ID_LOWER - "*.md > /dev/null 2>&1; then
    echo "[task-move] $TASK_ID not found in backlog/tasks/ — skipping (nothing to move)" >&2
    continue
  fi

  # AISDLC-683 open-children guard: never implicitly close an umbrella whose
  # children (aisdlc-N.M - *.md) are still open. Closing the umbrella stays an
  # explicit step: `node pipeline-cli/bin/cli-task-complete.mjs AISDLC-N`.
  OPEN_CHILDREN=""
  for CHILD_FILE in "$WT_ROOT/backlog/tasks/$TASK_ID_LOWER".[0-9]*" - "*.md; do
    [ -e "$CHILD_FILE" ] || continue
    OPEN_CHILDREN="$OPEN_CHILDREN    $(basename "$CHILD_FILE")
"
  done
  if [ -n "$OPEN_CHILDREN" ]; then
    {
      echo "[task-move] $TASK_ID still has open child task(s) in backlog/tasks/ — not auto-closing the umbrella:"
      printf '%s' "$OPEN_CHILDREN"
      echo "[task-move]   close it explicitly once the last child completes:"
      echo "[task-move]   node pipeline-cli/bin/cli-task-complete.mjs $TASK_ID"
    } >&2
    continue
  fi

  TASKS_TO_MOVE+=("$TASK_ID")
done <<< "$TASK_IDS_RAW"

if [ "${#TASKS_TO_MOVE[@]}" -eq 0 ]; then
  # Already in completed/, none in tasks/, or guarded by open children. No-op.
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

# ── Step 8: re-push required (or orchestrator mode) ──────────────────
# When AI_SDLC_INTERNAL_NO_EXIT_1=1 is set, the pre-push-fixups.sh
# orchestrator (AISDLC-386) is managing the exit-1 cycle itself. It invokes
# all mechanical fixup sub-hooks in one pass and emits a single consolidated
# "re-run git push" message after all of them have run. In that mode the
# sub-hook must exit 0 after doing its work so the orchestrator can continue
# to the next sub-hook (attestation-sign, etc.). Standalone invocations (e.g.
# from .husky/pre-push direct or from tests) retain exit-1 for backward compat.
if [ "${AI_SDLC_INTERNAL_NO_EXIT_1:-0}" = "1" ]; then
  echo "[task-move] fixup done (orchestrator mode — suppressing exit-1)" >&2
  exit 0
fi

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
