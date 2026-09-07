#!/usr/bin/env bash
# persist-reviewer-artifacts.sh — coordinator-side persistence of reviewer
# transcripts + verdicts under `.ai-sdlc/` (AISDLC-599).
#
# WHY THIS EXISTS: Step 7c of `/ai-sdlc execute` reads each reviewer's
# transcript at `.ai-sdlc/transcripts/<task-id-lower>/<agent>.jsonl` and
# verdict at `.ai-sdlc/verdicts/<agent>-<task-id-lower>.json`, then
# `emit-leaf`s them for v6 signing. Those files CANNOT be written by the
# reviewer subagents themselves — `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`
# ALWAYS refuses Write/Edit under `.ai-sdlc/**`, including for subagents the
# coordinator just spawned. That block stays absolute (AISDLC-599 design
# decision: coordinator-persists, not "narrow the block").
#
# So the coordinator (the main `/ai-sdlc execute` session, NOT a subagent)
# does this work itself, via shell (`cp`/`cat`/`mkdir -p`) — NOT via the
# Write/Edit tools, which enforce-blocked-actions.js refuses regardless of
# caller. Bash `cp`/heredoc IS permitted; that is the load-bearing fact this
# script depends on.
#
# The reviewer's real transcript is NOT anything the subagent writes — it is
# the harness-captured JSONL Claude Code itself records per-subagent-run at
# `~/.claude/projects/<project-slug>/<session-uuid>/subagents/agent-<agent-id>.jsonl`.
# Resolving by `find ~/.claude/projects -name agent-<id>.jsonl` sidesteps the
# unreliable worktree-topology project-dir derivation (newest-mtime wins on
# ties, since a stale duplicate from an earlier run may still exist on disk).
#
# Usage:
#   persist-reviewer-artifacts.sh \
#     --worktree <path> \
#     --task-id <id> \
#     --reviewer <name> \
#     --agent-id <harness-agent-id> \
#     --verdict-file <path-to-verdict-json>
#
# Exit codes:
#   0  success — transcript copied + verdict written
#   1  usage error (missing required flag)
#   2  no harness transcript found for --agent-id under ~/.claude/projects
#   3  --verdict-file does not exist / is not readable
#
# Idempotent: re-running with the same args overwrites cleanly.

set -euo pipefail

CLAUDE_PROJECTS_DIR="${AI_SDLC_CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

WORKTREE=""
TASK_ID=""
REVIEWER=""
AGENT_ID=""
VERDICT_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --worktree)
      WORKTREE="$2"
      shift 2
      ;;
    --task-id)
      TASK_ID="$2"
      shift 2
      ;;
    --reviewer)
      REVIEWER="$2"
      shift 2
      ;;
    --agent-id)
      AGENT_ID="$2"
      shift 2
      ;;
    --verdict-file)
      VERDICT_FILE="$2"
      shift 2
      ;;
    *)
      echo "persist-reviewer-artifacts.sh: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$WORKTREE" ] || [ -z "$TASK_ID" ] || [ -z "$REVIEWER" ] || [ -z "$AGENT_ID" ] || [ -z "$VERDICT_FILE" ]; then
  echo "usage: persist-reviewer-artifacts.sh --worktree <path> --task-id <id> --reviewer <name> --agent-id <harness-agent-id> --verdict-file <path>" >&2
  exit 1
fi

if [ ! -f "$VERDICT_FILE" ]; then
  echo "persist-reviewer-artifacts.sh: verdict file not found or unreadable: $VERDICT_FILE" >&2
  exit 3
fi

TASK_ID_LOWER=$(echo "$TASK_ID" | tr '[:upper:]' '[:lower:]')

# Resolve the harness-captured transcript by agent-id. Multiple matches can
# occur (a stale file from an earlier run under a different project dir, or
# a duplicate session) — newest-mtime wins, matching the disclosed-race
# heuristic AISDLC-216 already uses for `.active-task` sentinel resolution.
if [ ! -d "$CLAUDE_PROJECTS_DIR" ]; then
  echo "persist-reviewer-artifacts.sh: no such directory: $CLAUDE_PROJECTS_DIR (set AI_SDLC_CLAUDE_PROJECTS_DIR to override)" >&2
  exit 2
fi

# mtime accessor differs between BSD stat (macOS) and GNU stat (Linux) —
# detect once and use whichever flavor works.
_mtime_of() {
  stat -f '%m' "$1" 2>/dev/null || stat -c '%Y' "$1" 2>/dev/null
}

TRANSCRIPT_SRC=""
BEST_MTIME=-1
while IFS= read -r -d '' candidate; do
  m=$(_mtime_of "$candidate")
  m=${m:-0}
  if [ "$m" -gt "$BEST_MTIME" ]; then
    BEST_MTIME="$m"
    TRANSCRIPT_SRC="$candidate"
  fi
done < <(find "$CLAUDE_PROJECTS_DIR" -type f -name "agent-${AGENT_ID}.jsonl" -print0 2>/dev/null)

if [ -z "${TRANSCRIPT_SRC:-}" ] || [ ! -f "${TRANSCRIPT_SRC:-/nonexistent}" ]; then
  echo "persist-reviewer-artifacts.sh: no harness transcript found for agent-id '${AGENT_ID}' under ${CLAUDE_PROJECTS_DIR} (searched for agent-${AGENT_ID}.jsonl)" >&2
  exit 2
fi

TRANSCRIPT_DEST_DIR="$WORKTREE/.ai-sdlc/transcripts/${TASK_ID_LOWER}"
VERDICT_DEST_DIR="$WORKTREE/.ai-sdlc/verdicts"
TRANSCRIPT_DEST="$TRANSCRIPT_DEST_DIR/${REVIEWER}.jsonl"
VERDICT_DEST="$VERDICT_DEST_DIR/${REVIEWER}-${TASK_ID_LOWER}.json"

mkdir -p "$TRANSCRIPT_DEST_DIR" "$VERDICT_DEST_DIR"
cp "$TRANSCRIPT_SRC" "$TRANSCRIPT_DEST"
cp "$VERDICT_FILE" "$VERDICT_DEST"

echo "persist-reviewer-artifacts.sh: persisted ${REVIEWER} transcript (from ${TRANSCRIPT_SRC}) -> ${TRANSCRIPT_DEST}"
echo "persist-reviewer-artifacts.sh: persisted ${REVIEWER} verdict -> ${VERDICT_DEST}"
