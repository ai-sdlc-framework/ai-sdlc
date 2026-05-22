#!/usr/bin/env bash
#
# AISDLC-386: Orchestrator hook — collapse pre-push "re-push required" chain
# into a single pass.
#
# Problem: the pre-push chain has up to three hooks that each exit-1 with
# "re-run git push" after doing mechanical work:
#   1. check-task-moved.sh  — auto-mv + chore commit
#   2. check-mcp-bundle-sync.sh — rebuild + chore commit (DELETE per AISDLC-385)
#   3. check-attestation-sign.sh — sign + chore commit
#
# Worst case: operator runs `git push` FOUR times (one per fixup, then one
# final push). This orchestrator collapses those into AT MOST TWO: one to
# trigger fixups, one to actually send.
#
# How it works:
#   1. Invoke each sub-hook in dependency order (task-move → mcp-bundle-sync
#      → attestation-sign) with AI_SDLC_INTERNAL_NO_EXIT_1=1 set. That env var
#      suppresses the exit-1-after-fixup in each sub-hook but still does the work.
#   2. Track whether any fixup made changes (via its stdout sentinel or exit code).
#   3. After all sub-hooks complete: if ANY fixup ran, exit 1 ONCE with a
#      consolidated summary. If no fixups ran, exit 0 silently.
#
# AC-2 consolidated message format:
#   [pre-push-fixups] Auto-fixed: <list>. Re-run `git push` to send.
#
# Sub-hook output is prefixed with [<hook-name>] for debuggability (AC-6).
#
# Order is load-bearing (per AISDLC-220):
#   task-move MUST run before attestation-sign because the attestation envelope
#   binds {path, headBlobSha} per file — if task-move happens AFTER sign, the
#   envelope hashes the old path → verify-attestation rejects.
#
# Activation:
#   Invoked from `.husky/pre-push` AFTER coverage + DoR gates (which can fail)
#   and BEFORE the individual hook invocations (which act as a defense-in-depth
#   fallback on the re-push after the orchestrator exits 1).
#
# Bypass:
#   AI_SDLC_BYPASS_ALL_GATES=1 git push — skips this orchestrator and all sub-hooks.
#
# Individual sub-hook bypasses:
#   AI_SDLC_SKIP_TASK_MOVE=1, AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1,
#   AI_SDLC_SKIP_ATTESTATION_SIGN=1 — forwarded to sub-hooks as-is.
#
# Exit codes:
#   0 — no fixups were needed (sub-hooks all exited 0)
#   1 — one or more fixups ran; re-run `git push` to send the new commits
#   2 — a sub-hook hard-failed (not the "I did work" exit-1); push aborted

set -euo pipefail

# ── Master bypass ─────────────────────────────────────────────────────
if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[pre-push-fixups] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

# ── Locate script dir + worktree root ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '')
if [ -z "$WT_ROOT" ]; then
  exit 0
fi

# ── Read push range from stdin ────────────────────────────────────────
# Husky captures the full stdin into $PUSH_STDIN before calling us. We need
# to forward it to each sub-hook so they can compute the push range.
# Caller passes stdin via pipe; we capture it here.
PUSH_STDIN="$(cat || true)"

# ── Helper: run a sub-hook in "no-exit-1" mode ───────────────────────
# Usage: run_sub_hook <hook-name> <hook-path>
# Returns:
#   0 — hook ran and no fixup was needed (or hook was skipped by its own skip-var)
#   1 — hook ran and did a fixup (work was done; normally would exit-1)
#   2 — hook hard-failed (not a fixup; a real error)
# When AI_SDLC_INTERNAL_NO_EXIT_1=1, sub-hooks exit 0 after fixup instead of 1.
# We detect "fixup happened" by a dedicated sentinel line on stderr:
#   [<hook>] FIXUP_DONE
run_sub_hook() {
  local HOOK_NAME="$1"
  local HOOK_PATH="$2"

  if [ ! -f "$HOOK_PATH" ]; then
    echo "[pre-push-fixups] WARN: $HOOK_PATH not found — skipping $HOOK_NAME" >&2
    return 0
  fi

  local TMPOUT
  TMPOUT=$(mktemp)

  local EXIT_CODE=0
  # Forward stdin (push range) to the sub-hook and capture combined stderr.
  # stdout is not normally used by these hooks but we redirect it too.
  printf '%s\n' "$PUSH_STDIN" | \
    AI_SDLC_INTERNAL_NO_EXIT_1=1 bash "$HOOK_PATH" \
    > "$TMPOUT" 2>&1 \
    || EXIT_CODE=$?

  # Prefix each line of the sub-hook's output with [hook-name] and emit to stderr.
  while IFS= read -r LINE; do
    # Avoid double-prefixing: sub-hook already prefixes with [hook-name] internally.
    echo "$LINE" >&2
  done < "$TMPOUT"
  rm -f "$TMPOUT"

  return "$EXIT_CODE"
}

# ── Track which fixups ran ────────────────────────────────────────────
FIXED=()

# ── Sub-hook 1: task-move ─────────────────────────────────────────────
# Dependency: MUST run before attestation-sign (contentHashV4 binding).
HEAD_BEFORE_TASK_MOVE=$(git rev-parse HEAD 2>/dev/null || echo '')
TASK_MOVE_EXIT=0
run_sub_hook "task-move" "$SCRIPT_DIR/check-task-moved.sh" || TASK_MOVE_EXIT=$?

if [ "$TASK_MOVE_EXIT" -ge 2 ]; then
  echo "[pre-push-fixups] task-move hard-failed (exit $TASK_MOVE_EXIT) — aborting push" >&2
  exit "$TASK_MOVE_EXIT"
fi

HEAD_AFTER_TASK_MOVE=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ "$HEAD_BEFORE_TASK_MOVE" != "$HEAD_AFTER_TASK_MOVE" ]; then
  FIXED+=("task-move")
fi

# ── Sub-hook 2: mcp-bundle-sync ───────────────────────────────────────
# Will be removed in AISDLC-385. Included here per task spec (386 ships
# before 385 deletes the hook).
HEAD_BEFORE_MCP=$(git rev-parse HEAD 2>/dev/null || echo '')
MCP_EXIT=0
run_sub_hook "mcp-bundle-sync" "$SCRIPT_DIR/check-mcp-bundle-sync.sh" || MCP_EXIT=$?

if [ "$MCP_EXIT" -ge 2 ]; then
  echo "[pre-push-fixups] mcp-bundle-sync hard-failed (exit $MCP_EXIT) — aborting push" >&2
  exit "$MCP_EXIT"
fi

HEAD_AFTER_MCP=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ "$HEAD_BEFORE_MCP" != "$HEAD_AFTER_MCP" ]; then
  FIXED+=("mcp-bundle-sync")
fi

# ── Sub-hook 3: attestation-sign ─────────────────────────────────────
# Dependency: MUST run AFTER task-move so the envelope hashes the moved path.
HEAD_BEFORE_ATTEST=$(git rev-parse HEAD 2>/dev/null || echo '')
ATTEST_EXIT=0
run_sub_hook "attestation-sign" "$SCRIPT_DIR/check-attestation-sign.sh" || ATTEST_EXIT=$?

if [ "$ATTEST_EXIT" -ge 2 ]; then
  echo "[pre-push-fixups] attestation-sign hard-failed (exit $ATTEST_EXIT) — aborting push" >&2
  exit "$ATTEST_EXIT"
fi

HEAD_AFTER_ATTEST=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ "$HEAD_BEFORE_ATTEST" != "$HEAD_AFTER_ATTEST" ]; then
  FIXED+=("attestation-sign")
fi

# ── Exit determination ────────────────────────────────────────────────
if [ "${#FIXED[@]}" -eq 0 ]; then
  # AC-3: no fixups → exit 0 silently.
  exit 0
fi

# AC-2: consolidated exit-1 with summary.
FIXED_LIST=$(IFS=', '; echo "${FIXED[*]}")
{
  echo ""
  echo "[pre-push-fixups] Auto-fixed: $FIXED_LIST. Re-run \`git push\` to send."
  echo ""
  echo "            The following mechanical fixup commit(s) were added on top"
  echo "            of your HEAD. The push you just attempted does NOT include"
  echo "            them — re-run \`git push\` to send all commits."
  echo ""
  echo "            On the next push these sub-hooks are all idempotent (no"
  echo "            fixup needed → exit 0 → push proceeds normally)."
  echo ""
  echo "            Emergency bypass: AI_SDLC_BYPASS_ALL_GATES=1 git push"
} >&2

exit 1
