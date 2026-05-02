#!/usr/bin/env bash
#
# AISDLC-133: Auto-sign DSSE review attestation in the pre-push hook when
# verdict files exist. This removes the "sign-attestation" step from the
# LLM's responsibility per the "anything mechanical → hook/workflow, never
# LLM" pattern (2026-05-01 design discussion).
#
# Why this exists: `/ai-sdlc execute` Step 10 used to drive signing inline
# from the slash command body, which (a) consumed model context for a purely
# deterministic operation and (b) coupled signing to a successful main-session
# turn. Moving signing into pre-push makes it idempotent, automatic, and
# survives session restarts (verdict file lives in the worktree, not /tmp/).
#
# Behaviour:
#
#   1. Honour AI_SDLC_SKIP_ATTESTATION_SIGN=1 (operator deferral / hand-resign).
#   2. Read the per-worktree active-task sentinel at `<worktree>/.active-task`
#      (per AISDLC-81). Sentinel absent → exit 0 (chore PRs, ad-hoc commits,
#      docs-only PRs all push without an attestation).
#   3. Read the verdict file at `<worktree>/.ai-sdlc/verdicts/<task-id>.json`.
#      Verdict file absent → exit 0 (reviewers haven't run yet; the verdict
#      file is the explicit "we're ready to attest" handoff from /ai-sdlc
#      execute).
#   4. Idempotency: if `.ai-sdlc/attestations/<head-sha>.dsse.json` already
#      exists at current HEAD, exit 0 (we already signed this commit).
#   5. Invoke the signer (default:
#      `node ai-sdlc-plugin/scripts/sign-attestation.mjs`; overridable via
#      AI_SDLC_SIGN_ATTESTATION_CMD for tests).
#   6. Stage + commit the new envelope as a chore commit (no --no-verify is
#      needed: husky's pre-commit + commit-msg hooks pass on the chore body
#      because it carries no CI-skip tokens; we DO bypass commit-msg+pre-commit
#      via `git commit --no-verify` to avoid re-entrant lint-staged on a
#      one-file generated commit, which is consistent with the AISDLC-87
#      CI-side attestor's chore-commit pattern).
#   7. Exit 1 with a clear "re-push required" message: the new commit is local
#      only; the operator (or wrapping `git push` retry) must invoke `git push`
#      again to send it. The next push will skip step 5 entirely (idempotent
#      check at step 4 sees the attestation already exists for HEAD).
#
# Activation: invoked from `.husky/pre-push` AFTER the coverage gate. Wiring
# is in `.husky/pre-push` itself.
#
# Override:
#   AI_SDLC_SKIP_ATTESTATION_SIGN=1 git push
# Use only when deferring sign for operator hand-resign — the verifier will
# mark the resulting PR "invalid (missing)" until an attestation lands.
#
# Test override:
#   AI_SDLC_SIGN_ATTESTATION_CMD="<command>" — overrides the signer invocation
#   so tests can stub it without needing the orchestrator built. The override
#   is invoked with the same args the real signer accepts and is responsible
#   for writing `.ai-sdlc/attestations/<head-sha>.dsse.json`.
#
# Exit codes:
#   0 — nothing to sign (no sentinel, no verdict, or already attested), or
#       AI_SDLC_SKIP_ATTESTATION_SIGN=1 short-circuit.
#   1 — signed + committed an attestation; push aborted; operator must
#       re-run `git push` to send the new chore commit.
#   2 — signer invocation itself failed (refuses to abort the push silently).

set -euo pipefail

# ── Step 1: env-var deferral ─────────────────────────────────────────
if [ "${AI_SDLC_SKIP_ATTESTATION_SIGN:-0}" = "1" ]; then
  echo "[attestation-sign] AI_SDLC_SKIP_ATTESTATION_SIGN=1 — skipping auto-sign" >&2
  exit 0
fi

# ── Step 2: locate worktree root + per-worktree active-task sentinel ─
# AISDLC-81 wrote the sentinel inside the worktree (not the project-level
# .worktrees/.active-task). Use `git rev-parse --show-toplevel` so this
# script works correctly when invoked from any subdirectory.
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '')
if [ -z "$WT_ROOT" ]; then
  # Not a git repo (shouldn't happen in pre-push, but defend anyway).
  exit 0
fi

SENTINEL="$WT_ROOT/.active-task"
if [ ! -f "$SENTINEL" ]; then
  # No active task. This is a chore commit, ad-hoc fix, docs-only PR, or
  # a manual push outside of /ai-sdlc execute — none of these need an
  # attestation. Exit silently (the verifier will report missing for any
  # downstream PR that actually needs one and post the fallback comment).
  exit 0
fi

TASK_ID=$(tr -d '[:space:]' < "$SENTINEL")
if [ -z "$TASK_ID" ]; then
  echo "[attestation-sign] WARN: $SENTINEL is empty; skipping (no task ID to bind)" >&2
  exit 0
fi

# ── Step 3: locate the verdict file ──────────────────────────────────
# `/ai-sdlc execute` Step 10 (post-AISDLC-133) writes the aggregated reviewer
# verdicts to <worktree>/.ai-sdlc/verdicts/<task-id-lowercase>.json. The
# canonical filename is lowercase (matches the backlog/tasks/<id-lower>-*.md
# filename convention from AISDLC-92); we check the lowercase candidate
# FIRST so case-insensitive file systems (macOS APFS default) don't trick
# us into reporting the uppercase-named file the operator may have hand-
# created. The uppercase-named file is accepted as a defensive fallback.
TASK_ID_LOWER=$(printf '%s' "$TASK_ID" | tr '[:upper:]' '[:lower:]')
VERDICT_DIR="$WT_ROOT/.ai-sdlc/verdicts"
VERDICT_FILE=""
for candidate in "$VERDICT_DIR/$TASK_ID_LOWER.json" "$VERDICT_DIR/$TASK_ID.json"; do
  if [ -f "$candidate" ]; then
    VERDICT_FILE="$candidate"
    break
  fi
done

if [ -z "$VERDICT_FILE" ]; then
  # No verdicts yet — reviewers haven't approved (or the slash command body
  # didn't write the verdict file). Exit 0 so the push proceeds; the
  # verifier's fallback comment + CI-side attestor (AISDLC-87) will handle
  # it on the PR side.
  exit 0
fi

# ── Step 4: idempotency check ────────────────────────────────────────
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ -z "$HEAD_SHA" ]; then
  echo "[attestation-sign] WARN: cannot resolve HEAD; skipping" >&2
  exit 0
fi

ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.dsse.json"
if [ -f "$ATT_FILE" ]; then
  # Already signed for this HEAD. Either the previous push aborted (this
  # script set exit 1, operator re-pushed, and the chore commit is now on
  # HEAD with the envelope present), or the operator pre-signed manually.
  # Either way: nothing to do, push proceeds.
  exit 0
fi

# ── Step 5: invoke the signer ────────────────────────────────────────
# The default signer is the same script `/ai-sdlc execute` Step 10 used to
# call directly. Tests inject a stub via AI_SDLC_SIGN_ATTESTATION_CMD so
# they don't need the orchestrator built.
ITERATION_COUNT="${AI_SDLC_ITERATION_COUNT:-1}"
HARNESS_NOTE="${AI_SDLC_HARNESS_NOTE:-}"

echo "[attestation-sign] Auto-signing attestation for $TASK_ID against HEAD $HEAD_SHA" >&2

if [ -n "${AI_SDLC_SIGN_ATTESTATION_CMD:-}" ]; then
  # Test override: split on whitespace via word splitting (intentional —
  # callers can pass multi-word commands like "node /tmp/fake-signer.mjs").
  # shellcheck disable=SC2086
  if ! $AI_SDLC_SIGN_ATTESTATION_CMD \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE"; then
    echo "[attestation-sign] ERROR: signer invocation (override) failed; aborting push" >&2
    exit 2
  fi
else
  if ! node "$WT_ROOT/ai-sdlc-plugin/scripts/sign-attestation.mjs" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE"; then
    echo "[attestation-sign] ERROR: sign-attestation.mjs failed; aborting push" >&2
    echo "[attestation-sign]        (run \`pnpm --filter @ai-sdlc/orchestrator build\` if dist is missing)" >&2
    exit 2
  fi
fi

# Confirm the signer wrote what we expected before we try to commit it.
if [ ! -f "$ATT_FILE" ]; then
  echo "[attestation-sign] ERROR: signer did not produce $ATT_FILE; aborting push" >&2
  exit 2
fi

# ── Step 6: stage + commit the chore ─────────────────────────────────
# We commit ONLY the new attestation file, not the whole `.ai-sdlc/` tree,
# so concurrent uncommitted edits in the worktree don't get swept in.
# `--no-verify` here skips re-entering pre-commit (lint-staged has nothing
# to do with a generated JSON envelope). It does NOT skip the next pre-push
# invocation — the operator's re-`git push` will trigger pre-push again,
# at which point the idempotent check at Step 4 sees the file and exits 0.
(
  cd "$WT_ROOT"
  git add -- "$ATT_FILE"
  git commit --no-verify -m "chore: auto-sign attestation for $TASK_ID (AISDLC-133)

Auto-generated by .husky/pre-push (scripts/check-attestation-sign.sh).
Reviewers' verdicts at .ai-sdlc/verdicts/$TASK_ID_LOWER.json.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" >&2
) || {
  echo "[attestation-sign] ERROR: git add/commit of attestation failed; aborting push" >&2
  exit 2
}

# ── Step 7: re-push required ─────────────────────────────────────────
{
  echo ""
  echo "[attestation-sign] Hook added an attestation chore commit on top of"
  echo "                   $HEAD_SHA. The push you just attempted does NOT"
  echo "                   include that new commit — re-run \`git push\` to send it."
  echo ""
  echo "                   The next push is a no-op for this hook (idempotent: the"
  echo "                   attestation file already exists at the new HEAD)."
  echo ""
  echo "                   Defer with: AI_SDLC_SKIP_ATTESTATION_SIGN=1 git push"
} >&2

exit 1
