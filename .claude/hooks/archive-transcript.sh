#!/bin/bash
#
# AI-SDLC Transcript Archive Hook (SessionEnd)
#
# Copies the session transcript Claude Code keeps under ~/.claude/projects/
# into <project>/.claude/transcripts/ so the conversation history lives with
# the project. Also copies any subagent transcripts of that session.
# Must be fast and never fail: every error exits 0.
#
# Output name: <date>-<reason>-<session-id>.jsonl
# The directory is gitignored: transcripts are plaintext and may hold secrets.

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DEST_DIR="${PROJECT_DIR}/.claude/transcripts"

INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // "end"' 2>/dev/null)

[ -n "$SESSION_ID" ] && [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

mkdir -p "$DEST_DIR" 2>/dev/null || exit 0
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
cp -f "$TRANSCRIPT" "${DEST_DIR}/${STAMP}-${REASON}-${SESSION_ID}.jsonl" 2>/dev/null || exit 0

# Subagent transcripts sit next to the main one: <dir>/<session-id>/subagents/*.jsonl
SUB_DIR="$(dirname "$TRANSCRIPT")/${SESSION_ID}/subagents"
if [ -d "$SUB_DIR" ]; then
  mkdir -p "${DEST_DIR}/${SESSION_ID}-subagents" 2>/dev/null && \
    cp -f "$SUB_DIR"/*.jsonl "${DEST_DIR}/${SESSION_ID}-subagents/" 2>/dev/null || true
fi

printf '%s\n' "$(date -u +%FT%TZ) ${REASON} ${SESSION_ID} -> ${DEST_DIR}" >> "${DEST_DIR}/.log" 2>/dev/null || true
exit 0
