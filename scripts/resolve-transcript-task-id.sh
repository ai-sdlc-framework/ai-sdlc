#!/usr/bin/env bash
# resolve-transcript-task-id.sh — AISDLC-562, reworked by AISDLC-1334
#
# Resolves which task a reviewer-subagent transcript run is attributed to.
# Reviewer subagents start in the PARENT checkout (the Agent tool has no
# working-directory setting), so `.active-task` in $PWD is not their task.
# The review prompt carries an attribution block with the task id and the
# absolute worktree path; the reviewer passes both here.
#
# Usage: resolve-transcript-task-id.sh <reviewer-name> [<task-id> <worktree>]
#
# Precedence:
#   1. <task-id> <worktree> arguments — win over every other source. The id
#      must have a safe shape and <worktree>/.active-task must hold the same id.
#   2. $TASK_ID env var
#   3. `.active-task` sentinel in $PWD (AISDLC-81)
#   4. $AI_SDLC_ACTIVE_TASK_ID
#
# AISDLC-1334: this script NEVER invents an id. When no source resolves, it
# prints nothing on stdout, names the cause and the fix on stderr, and exits 1;
# the caller then writes no transcript (the coordinator persists it from the
# harness record) and still returns its verdict. A malformed or mismatched id
# also exits 1 with a reason.
#
# On success: prints the resolved task id to stdout (nothing else), exit 0.
# The script creates no file or directory.
set -euo pipefail

REVIEWER="${1:-reviewer}"
ARG_ID="${2:-}"
ARG_WORKTREE="${3:-}"

SHAPE_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
ENV_TASK_ID="${TASK_ID:-}"
TASK_ID=""
SOURCE=""

if [ -n "$ARG_ID" ] || [ -n "$ARG_WORKTREE" ]; then
  TASK_ID="$ARG_ID"
  SOURCE="argument"
  if ! printf '%s' "$TASK_ID" | grep -qE "$SHAPE_RE"; then
    cat >&2 <<MSG
[resolve-transcript-task-id] refusing to write a transcript for reviewer '$REVIEWER': the task id from the prompt has an unsafe or empty shape ('$TASK_ID').
Task ids must match $SHAPE_RE (no '/', no '..', no whitespace).
Fix: the review prompt's attribution block must carry the real task id. Write no transcript; the coordinator persists it.
MSG
    exit 1
  fi
  if [ -z "$ARG_WORKTREE" ] || [ ! -d "$ARG_WORKTREE" ]; then
    echo "[resolve-transcript-task-id] refusing for reviewer '$REVIEWER': worktree '$ARG_WORKTREE' is missing or not a directory. Fix: the attribution block must name the absolute task worktree path. Write no transcript; the coordinator persists it." >&2
    exit 1
  fi
  if [ ! -f "$ARG_WORKTREE/.active-task" ]; then
    echo "[resolve-transcript-task-id] refusing for reviewer '$REVIEWER': '$ARG_WORKTREE/.active-task' does not exist, so the worktree is not confirmed as task '$TASK_ID'. Fix: use the worktree path from the prompt. Write no transcript; the coordinator persists it." >&2
    exit 1
  fi
  WT_ID="$(tr -d '[:space:]' < "$ARG_WORKTREE/.active-task")"
  if [ "$WT_ID" != "$TASK_ID" ]; then
    echo "[resolve-transcript-task-id] refusing for reviewer '$REVIEWER': '$ARG_WORKTREE/.active-task' names '$WT_ID', not '$TASK_ID'. Fix: the attribution block's task id and worktree must belong together. Write no transcript; the coordinator persists it." >&2
    exit 1
  fi
  printf '%s\n' "$TASK_ID"
  exit 0
fi

TASK_ID="$ENV_TASK_ID"
if [ -n "$TASK_ID" ]; then
  SOURCE="TASK_ID"
elif [ -f .active-task ]; then
  TASK_ID="$(tr -d '[:space:]' < .active-task)"
  [ -n "$TASK_ID" ] && SOURCE=".active-task"
fi

if [ -z "$TASK_ID" ] && [ -n "${AI_SDLC_ACTIVE_TASK_ID:-}" ]; then
  TASK_ID="$(printf '%s' "$AI_SDLC_ACTIVE_TASK_ID" | tr -d '[:space:]')"
  [ -n "$TASK_ID" ] && SOURCE="AI_SDLC_ACTIVE_TASK_ID"
fi

if [ -z "$TASK_ID" ]; then
  cat >&2 <<MSG
[resolve-transcript-task-id] no task attribution for reviewer '$REVIEWER'; no transcript id was created.
Cause: no <task-id> <worktree> arguments, no TASK_ID, no .active-task in $(pwd), and no AI_SDLC_ACTIVE_TASK_ID.
Fix: pass the task id and absolute worktree path from the review prompt's attribution block. Write no transcript; still return your verdict (the coordinator persists the transcript).
MSG
  exit 1
fi

if ! printf '%s' "$TASK_ID" | grep -qE "$SHAPE_RE"; then
  cat >&2 <<MSG
[resolve-transcript-task-id] refusing to write a transcript for reviewer '$REVIEWER': resolved task id has an unsafe shape.
Resolved task id: '$TASK_ID' (source: ${SOURCE:-unknown})
Task ids used as transcript directory names must match $SHAPE_RE (no '/', no '..', no leading dot/dash, no whitespace).
Fix: correct the value in <worktree>/.active-task or AI_SDLC_ACTIVE_TASK_ID.
MSG
  exit 1
fi

printf '%s\n' "$TASK_ID"
