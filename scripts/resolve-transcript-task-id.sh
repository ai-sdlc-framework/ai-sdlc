#!/usr/bin/env bash
# resolve-transcript-task-id.sh — AISDLC-562
#
# Resolves which task a reviewer-subagent transcript run should be attributed
# to. Reviewer agents (code-reviewer, test-reviewer, and their -codex variants)
# call this script instead of inlining `${TASK_ID:-$(cat .active-task ...
# || echo 'UNKNOWN')}` so an unattributable run FAILS LOUDLY rather than
# silently writing to a shared `.ai-sdlc/transcripts/UNKNOWN/` directory that
# unrelated runs then clobber (evidence destruction — see task body).
#
# Precedence order:
#   1. $TASK_ID env var        — explicit override, set by the caller
#   2. `.active-task` sentinel — per-worktree file in $PWD (AISDLC-81)
#   3. $AI_SDLC_ACTIVE_TASK_ID  — documented env fallback (CLAUDE.md
#                                 "Cross-repo writes" / Pattern C routing)
#
# On success: prints the resolved task id to stdout (nothing else), exit 0.
# On failure: prints a named, actionable error to stderr, exit 1. Callers
#             MUST NOT invent a fallback directory — refuse to write any
#             transcript at all when this script fails.
#
# Usage: resolve-transcript-task-id.sh <reviewer-name>
set -euo pipefail

REVIEWER="${1:?usage: resolve-transcript-task-id.sh <reviewer-name>}"

TASK_ID="${TASK_ID:-}"

if [ -z "$TASK_ID" ] && [ -f .active-task ]; then
  TASK_ID="$(tr -d '[:space:]' < .active-task)"
fi

if [ -z "$TASK_ID" ] && [ -n "${AI_SDLC_ACTIVE_TASK_ID:-}" ]; then
  TASK_ID="$(printf '%s' "$AI_SDLC_ACTIVE_TASK_ID" | tr -d '[:space:]')"
fi

if [ -z "$TASK_ID" ]; then
  cat >&2 <<EOF
[resolve-transcript-task-id] refusing to write an unattributable transcript for reviewer '$REVIEWER'.

Neither of the following was found:
  - the .active-task sentinel file in this worktree ($(pwd)/.active-task)
  - the AI_SDLC_ACTIVE_TASK_ID environment variable

Writing this reviewer's transcript to a shared UNKNOWN/ directory would silently
collide with other unattributed runs and corrupt the attestation evidence chain
(AISDLC-562: an attestation that cannot be attributed to a task is
indistinguishable from one that can — two runs writing one path is evidence
destruction, not a naming inconvenience).

Fix: write the task id to <worktree>/.active-task, or export
AI_SDLC_ACTIVE_TASK_ID=<TASK-ID> before invoking this reviewer.
EOF
  exit 1
fi

printf '%s\n' "$TASK_ID"
