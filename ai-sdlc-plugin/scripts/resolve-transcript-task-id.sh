#!/usr/bin/env bash
# resolve-transcript-task-id.sh — AISDLC-562, fail-soft-unique regression fix AISDLC-623
#
# Resolves which task a reviewer-subagent transcript run should be attributed
# to. Reviewer agents (code-reviewer, test-reviewer, correctness-reviewer,
# and their -codex variants) call this script instead of inlining
# `${TASK_ID:-$(cat .active-task ...) || echo 'UNKNOWN'}` so an unattributable
# run never collides with another unattributed run on a SHARED path.
#
# Precedence order:
#   1. $TASK_ID env var        — explicit override, set by the caller
#   2. `.active-task` sentinel — per-worktree file in $PWD (AISDLC-81)
#   3. $AI_SDLC_ACTIVE_TASK_ID  — documented env fallback (CLAUDE.md
#                                 "Cross-repo writes" / Pattern C routing)
#
# AISDLC-562 hardened this script to REFUSE (exit 1, print nothing) when none
# of the three sources resolved, on the theory that writing to a shared
# `.ai-sdlc/transcripts/UNKNOWN/` directory lets unrelated runs silently
# overwrite each other's evidence. That hardening over-reached: in ANY
# reviewer dispatch not routed through `/ai-sdlc execute` (adopter repos,
# ad-hoc reviewer invocations, CI reviewer fallback), none of the three
# attribution sources exist, so every reviewer refused at Step 0 before ever
# reading the diff — no reviews, no attestation, nothing ever merges. This is
# AISDLC-623: the fix is to fail SOFT instead of hard for the missing-
# attribution case, while preserving the 562 no-collision property by making
# the unattributed id UNIQUE per invocation instead of a shared literal.
#
# Fail-soft-unique contract (AISDLC-623):
#   - Missing attribution (none of the three sources resolved) is now a SOFT
#     failure: this script prints a unique
#     `UNKNOWN-<reviewer>-<UTC-timestamp>-<random>` id to stdout and exits 0.
#     The review proceeds; the transcript is simply unattributed to a task,
#     and because the id is unique per invocation, two unattributed runs
#     never collide on the same directory (the actual evidence-destruction
#     concern AISDLC-562 was about).
#   - A malformed PRESENT id (a `.active-task` or $AI_SDLC_ACTIVE_TASK_ID
#     value that fails the path-shape guard below) is still a HARD failure:
#     that is a genuine misconfiguration (path traversal risk, alias risk),
#     not the "adopter has no attribution wiring at all" case, so it is not
#     softened.
#
# On success: prints the resolved (or synthesized unattributed) task id to
#             stdout (nothing else), exit 0.
# On hard failure (malformed present id only): prints a named, actionable
#             error to stderr, exit 1. Callers MUST NOT invent a fallback
#             directory in this case — refuse to write any transcript at all.
#
# Usage: resolve-transcript-task-id.sh <reviewer-name>
set -euo pipefail

REVIEWER="${1:?usage: resolve-transcript-task-id.sh <reviewer-name>}"

TASK_ID="${TASK_ID:-}"
SOURCE=""

if [ -z "$TASK_ID" ] && [ -f .active-task ]; then
  TASK_ID="$(tr -d '[:space:]' < .active-task)"
  [ -n "$TASK_ID" ] && SOURCE=".active-task"
fi

if [ -z "$TASK_ID" ] && [ -n "${AI_SDLC_ACTIVE_TASK_ID:-}" ]; then
  TASK_ID="$(printf '%s' "$AI_SDLC_ACTIVE_TASK_ID" | tr -d '[:space:]')"
  [ -n "$TASK_ID" ] && SOURCE="AI_SDLC_ACTIVE_TASK_ID"
fi

if [ -z "$TASK_ID" ]; then
  # AISDLC-623: no attribution source resolved. Fail SOFT — synthesize a
  # UNIQUE unattributed id (timestamp-to-millisecond + a short random suffix)
  # so this run never collides with any other unattributed run on disk, and
  # let the review proceed rather than refusing outright.
  #
  # Portable millisecond timestamp: prefer `date +%N` (GNU/BSD-recent date
  # support nanoseconds), fall back to seconds-only when %N isn't supported
  # (some minimal/BusyBox `date` builds print the literal 'N').
  UTC_TIMESTAMP="$(date -u +%Y%m%dT%H%M%S 2>/dev/null || echo "00000000T000000")"
  NANOS="$(date -u +%N 2>/dev/null || echo "")"
  case "$NANOS" in
    ''|*N*) MILLIS="000" ;;
    *) MILLIS="$(printf '%s' "$NANOS" | cut -c1-3)" ;;
  esac
  # Portable random suffix: prefer bash's $RANDOM (always available in this
  # bash-shebang'd script); do NOT depend on `openssl` or `/dev/urandom`
  # being present (BusyBox / minimal containers may lack both). The process
  # id ($$) is appended so that on platforms where `date +%N` is unsupported
  # (BSD/macOS collapse MILLIS to '000') two same-second concurrent runs in
  # DIFFERENT processes still get distinct ids — hardening the AISDLC-562
  # no-collision property beyond the 16-bit $RANDOM alone.
  RANDOM_SUFFIX="$(printf '%04x' "$((RANDOM % 65536))" 2>/dev/null || echo "0000")"
  # Defense-in-depth (AISDLC-623 review): the fail-soft branch exits 0 before
  # reaching the PRESENT-id shape guard below, so the $REVIEWER component
  # ($1) would otherwise be interpolated into a filesystem path component
  # unvalidated. Every in-tree caller passes a trusted literal, but a future
  # or ad-hoc caller passing an unsafe name ('..' / a '/'-containing value)
  # must not be able to escape .ai-sdlc/transcripts/. Sanitize (not refuse —
  # this branch must always proceed) any char outside the path-safe class to
  # '_', guaranteeing the synthesized id satisfies the same
  # ^[A-Za-z0-9][A-Za-z0-9._-]*$ contract the PRESENT-id path enforces.
  # '.' is deliberately EXCLUDED from the allowed set (unlike the shape
  # guard) so that a name like '../evil' collapses to '___evil' with no '..'
  # substring at all — the rest of the id (timestamp/hex/pid) never contains
  # a dot, so the synthesized id is guaranteed dot-free and cannot form a
  # '..' segment. Real reviewer names only use alphanumerics and hyphens.
  SAFE_REVIEWER="$(printf '%s' "$REVIEWER" | tr -c 'A-Za-z0-9_-' '_')"
  TASK_ID="UNKNOWN-${SAFE_REVIEWER}-${UTC_TIMESTAMP}${MILLIS}Z-${RANDOM_SUFFIX}-$$"

  cat >&2 <<EOF
[resolve-transcript-task-id] WARNING: proceeding with an UNATTRIBUTED transcript for reviewer '$REVIEWER'.

Neither of the following was found:
  - the .active-task sentinel file in this worktree ($(pwd)/.active-task)
  - the AI_SDLC_ACTIVE_TASK_ID environment variable

The review will still proceed — this transcript is simply not attributed to
a task. A UNIQUE id ('$TASK_ID') is used instead of a shared 'UNKNOWN'
directory so this run cannot collide with any other unattributed run
(AISDLC-562's evidence-destruction concern is about SHARING one path across
unrelated runs, not about attribution being absent).

To attribute this run to a task, write the task id to
<worktree>/.active-task, or export AI_SDLC_ACTIVE_TASK_ID=<TASK-ID> before
invoking this reviewer.
EOF
  printf '%s\n' "$TASK_ID"
  exit 0
fi

# Defense-in-depth: the resolved task id becomes a filesystem path component
# (`.ai-sdlc/transcripts/<task-id>/`). A malformed id ('..', a '/'-containing
# value, or anything else that isn't a plain path-safe token) could either
# escape the transcripts directory (path traversal) or alias two distinct
# runs onto the same directory via unexpected normalization — both are the
# same evidence-destruction class this script exists to prevent. This case
# is a genuine misconfiguration of a PRESENT attribution source (unlike the
# missing-attribution case above), so it stays a HARD refusal — refuse
# rather than sanitize: sanitizing silently could still alias two different
# malformed ids to the same safe string.
if ! printf '%s' "$TASK_ID" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
  cat >&2 <<EOF
[resolve-transcript-task-id] refusing to write a transcript for reviewer '$REVIEWER': resolved task id has an unsafe shape.

Resolved task id: '$TASK_ID' (source: ${SOURCE:-unknown})

Task ids used as transcript directory names must match ^[A-Za-z0-9][A-Za-z0-9._-]*\$
(no '/', no '..', no leading dot/dash, no whitespace). A malformed id could
escape the transcripts directory (path traversal) or alias two distinct runs
onto the same directory — the exact evidence-destruction class AISDLC-562
exists to prevent. This is a genuine misconfiguration of a PRESENT
attribution source, not the "no attribution at all" case, so it is not
softened by AISDLC-623.

Fix: correct the value in <worktree>/.active-task or AI_SDLC_ACTIVE_TASK_ID.
EOF
  exit 1
fi

printf '%s\n' "$TASK_ID"
