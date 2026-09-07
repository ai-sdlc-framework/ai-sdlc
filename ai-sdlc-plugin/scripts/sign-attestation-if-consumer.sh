#!/usr/bin/env bash
#
# AISDLC-598: `/ai-sdlc execute` — sign the v6 attestation envelope
# in-process on consumer repos.
#
# Problem this fixes: `/ai-sdlc execute` Step 10 writes the reviewer
# verdicts file at `<worktree>/.ai-sdlc/verdicts/<task-id-lower>.json` and
# relies on the *monorepo's* husky `pre-push` hook
# (`.husky/pre-push` -> `scripts/check-attestation-sign.sh`) to detect the
# verdict file at push time and sign the DSSE envelope. That hook lives in
# THIS monorepo's own `.husky/`. In a consumer/adopter repo, `.husky/pre-push`
# is the ADOPTER's own hook — it does not know about ai-sdlc attestation
# signing at all — so the push produces NO envelope and `verify-attestation`
# is permanently red for that repo. There was previously no in-process
# consumer signing path in `execute` at all.
#
# What this script does:
#   1. Probe the *current repo's* push path (`.husky/pre-push`) to decide
#      whether the ai-sdlc attestation signer (`check-attestation-sign.sh`)
#      is already reachable from it (directly, or transitively via
#      `pre-push-fixups.sh`). If it IS reachable, this is a "monorepo-style"
#      repo: the hook owns signing and this script is a strict no-op (never
#      double-sign the same commit).
#   2. If the signer is NOT reachable from the push path (a "consumer"
#      repo), this script signs the DSSE envelope in-process, right now,
#      using the exact same signer + args the hook would have used, stages +
#      commits the resulting envelope, and self-verifies with
#      `verify-attestation.mjs` before returning success. If verification is
#      red, it ABORTS (non-zero exit + actionable message) — the caller
#      (`/ai-sdlc execute` Step 10.x) must NOT proceed to push an
#      unverifiable state.
#
# Detection is a PUSH-PATH PROBE, not a hardcoded "is this the ai-sdlc
# monorepo" check and not a new operator env flag (AC #4): we literally grep
# the repo's own `.husky/pre-push` (and, transitively,
# `scripts/pre-push-fixups.sh` if that's what pre-push delegates to) for a
# reference to `check-attestation-sign.sh`. Any repo — including a fork or a
# consumer repo that vendors the monorepo's exact hook chain — that reaches
# the signer via its push path is treated as "hook owns it" and this script
# no-ops. Any repo whose push path does NOT reach it (the common
# consumer/adopter case, or no `.husky/pre-push` at all) gets the in-process
# signing path.
#
# Sentinel + verdict-file conventions mirror `check-attestation-sign.sh`
# exactly (per-worktree `.active-task` sentinel; `.ai-sdlc/verdicts/<task-id
# -lower>.json`), so a repo with neither in place is a legitimate "nothing to
# sign yet" no-op — not an error.
#
# Usage (invoked from `/ai-sdlc execute` Step 10.x, BEFORE the push loop in
# Step 11):
#   bash "$PLUGIN_SCRIPTS_DIR/sign-attestation-if-consumer.sh"
#
# Test overrides (mirror check-attestation-sign.sh's contract exactly):
#   AI_SDLC_SIGN_ATTESTATION_CMD  — substitute signer command (requires
#                                    AI_SDLC_ALLOW_SIGNER_OVERRIDE=1, same
#                                    arbitrary-command-execution gate as
#                                    check-attestation-sign.sh; AISDLC-555).
#   AI_SDLC_VERIFY_ATTESTATION_CMD — substitute verifier command for tests
#                                    that don't want to build the real
#                                    runtime. Must print `status=valid` or
#                                    `status=invalid` on stdout and exit
#                                    0/1 to match, same as the real verifier.
#
# Exit codes:
#   0 — no-op (monorepo push path owns signing, OR no sentinel/verdict file
#       yet, OR AI_SDLC_SKIP_ATTESTATION_SIGN=1), OR consumer path signed +
#       committed + self-verified successfully.
#   1 — consumer path: signer produced an envelope that FAILED self-verify.
#       The commit already landed (so the failure is inspectable) but the
#       caller MUST NOT proceed to push.
#   2 — consumer path: the signer invocation itself failed, or the resulting
#       commit could not be created.

set -euo pipefail

# ── Master bypasses ───────────────────────────────────────────────────
if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[sign-attestation-if-consumer] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi
if [ "${AI_SDLC_SKIP_ATTESTATION_SIGN:-0}" = "1" ]; then
  echo "[sign-attestation-if-consumer] AI_SDLC_SKIP_ATTESTATION_SIGN=1 — skipping" >&2
  exit 0
fi

WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '')
if [ -z "$WT_ROOT" ]; then
  echo "[sign-attestation-if-consumer] not a git repo — skipping" >&2
  exit 0
fi

# ── Step 1: push-path probe ───────────────────────────────────────────
# Decide whether THIS repo's push path already reaches the ai-sdlc
# attestation signer hook. We treat "reaches" as: `.husky/pre-push` (the
# canonical husky entrypoint) contains a literal reference to
# `check-attestation-sign.sh`, either directly or via a reference to
# `pre-push-fixups.sh` whose OWN contents in turn reference
# `check-attestation-sign.sh`.
PRE_PUSH_HOOK="$WT_ROOT/.husky/pre-push"
SIGNER_ON_PUSH_PATH=0
if [ -f "$PRE_PUSH_HOOK" ]; then
  if grep -q 'check-attestation-sign\.sh' "$PRE_PUSH_HOOK" 2>/dev/null; then
    SIGNER_ON_PUSH_PATH=1
  elif grep -q 'pre-push-fixups\.sh' "$PRE_PUSH_HOOK" 2>/dev/null; then
    FIXUPS_HOOK="$WT_ROOT/scripts/pre-push-fixups.sh"
    if [ -f "$FIXUPS_HOOK" ] && grep -q 'check-attestation-sign\.sh' "$FIXUPS_HOOK" 2>/dev/null; then
      SIGNER_ON_PUSH_PATH=1
    fi
  fi
fi

if [ "$SIGNER_ON_PUSH_PATH" = "1" ]; then
  echo "[sign-attestation-if-consumer] monorepo-style push path detected (.husky/pre-push reaches check-attestation-sign.sh) — hook owns signing, no-op" >&2
  exit 0
fi

echo "[sign-attestation-if-consumer] consumer-style push path detected (no attestation signer on .husky/pre-push) — signing in-process" >&2

# ── Step 2: locate the active-task sentinel ───────────────────────────
SENTINEL="$WT_ROOT/.active-task"
if [ ! -f "$SENTINEL" ]; then
  echo "[sign-attestation-if-consumer] no .active-task sentinel — nothing to sign, skipping" >&2
  exit 0
fi

TASK_ID=$(tr -d '[:space:]' < "$SENTINEL")
if [ -z "$TASK_ID" ]; then
  echo "[sign-attestation-if-consumer] WARN: $SENTINEL is empty; skipping (no task ID to bind)" >&2
  exit 0
fi

# ── Step 3: locate the verdict file ───────────────────────────────────
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
  echo "[sign-attestation-if-consumer] no verdicts file at $VERDICT_DIR/$TASK_ID_LOWER.json — skipping (no attestation needed yet)" >&2
  exit 0
fi

# ── Step 4: schema version + idempotency check ────────────────────────
# Mirrors check-attestation-sign.sh's polarity exactly so both the hook and
# this script would compute the same envelope filename for the same commit
# (defense against ever double-signing if both happen to run).
if [ "${AI_SDLC_V5_LEGACY:-0}" = "1" ] || [ "${AI_SDLC_V6_CUTOVER_ACTIVE:-1}" = "0" ]; then
  SCHEMA_VERSION="${AI_SDLC_SCHEMA_VERSION:-v5}"
else
  SCHEMA_VERSION="${AI_SDLC_SCHEMA_VERSION:-v6}"
fi

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ -z "$HEAD_SHA" ]; then
  echo "[sign-attestation-if-consumer] WARN: cannot resolve HEAD; skipping" >&2
  exit 0
fi

MERGE_BASE=$(git merge-base "origin/main" HEAD 2>/dev/null || echo '')
PATCH_ID=""
if [ -n "$MERGE_BASE" ] && [ ${#MERGE_BASE} -eq 40 ]; then
  DIFF_OUTPUT=$(git diff-tree --no-color -p "${MERGE_BASE}..HEAD" -- ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves/' ':!.ai-sdlc/transcript-leaves.jsonl' 2>/dev/null || echo '')
  if [ -n "$DIFF_OUTPUT" ]; then
    PATCH_ID_LINE=$(printf '%s' "$DIFF_OUTPUT" | git patch-id --stable 2>/dev/null | head -1 || echo '')
    PATCH_ID=$(printf '%s' "$PATCH_ID_LINE" | cut -c1-40 2>/dev/null || echo '')
    if ! printf '%s' "$PATCH_ID" | grep -qE '^[0-9a-f]{40}$'; then
      PATCH_ID=""
    fi
  fi
fi

if [ "$SCHEMA_VERSION" = "v6" ]; then
  EXT=".v6.dsse.json"
else
  EXT=".dsse.json"
fi
if [ -n "$PATCH_ID" ]; then
  ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$PATCH_ID$EXT"
else
  ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA$EXT"
fi

if [ -f "$ATT_FILE" ]; then
  echo "[sign-attestation-if-consumer] envelope already exists at $ATT_FILE — already signed, no-op" >&2
  exit 0
fi

LAST_COMMIT_SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null || echo '')
if [[ "${LAST_COMMIT_SUBJECT:-}" == "chore: sign attestation for "* ]]; then
  echo "[sign-attestation-if-consumer] HEAD is already an attestation-sign chore commit — no-op" >&2
  exit 0
fi

# ── Step 5: invoke the signer ──────────────────────────────────────────
# The signer is resolved relative to THIS script's own on-disk location
# (mirrors AISDLC-555's SELF_SCRIPT_DIR pattern for check-attestation-sign.sh)
# so it works regardless of install topology (plugin cache, CLAUDE_PLUGIN_ROOT,
# or this monorepo) without depending on env vars a git hook / bash tool call
# may not inherit.
SELF_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGN_ATTESTATION_MJS="$SELF_SCRIPT_DIR/sign-attestation.mjs"
VERIFY_ATTESTATION_MJS="$SELF_SCRIPT_DIR/verify-attestation.mjs"

ITERATION_COUNT="${AI_SDLC_ITERATION_COUNT:-1}"
HARNESS_NOTE="${AI_SDLC_HARNESS_NOTE:-}"

HARNESS_ARGS=()
if [ -n "${CODEX_VERSION:-}" ]; then
  CODEX_VERSION_NUM="${CODEX_VERSION#codex@}"
  HARNESS_ARGS=(--harness-name codex --harness-version "$CODEX_VERSION_NUM")
fi

echo "[sign-attestation-if-consumer] signing attestation for $TASK_ID against HEAD $HEAD_SHA (schema: $SCHEMA_VERSION)" >&2

if [ -n "${AI_SDLC_SIGN_ATTESTATION_CMD:-}" ] && [ "${AI_SDLC_ALLOW_SIGNER_OVERRIDE:-0}" != "1" ]; then
  # AISDLC-555 round-3/5 security review — same gate as check-attestation-sign.sh.
  # This override, if honoured unconditionally, is arbitrary command execution
  # for anything able to set env before `/ai-sdlc execute` runs. Refuse rather
  # than silently ignore.
  echo "[sign-attestation-if-consumer] ERROR: AI_SDLC_SIGN_ATTESTATION_CMD is set but" >&2
  echo "[sign-attestation-if-consumer]   AI_SDLC_ALLOW_SIGNER_OVERRIDE=1 is not. Refusing to run a" >&2
  echo "[sign-attestation-if-consumer]   substitute signer. This override exists for tests only." >&2
  exit 2
fi

if [ -n "${AI_SDLC_SIGN_ATTESTATION_CMD:-}" ]; then
  read -r -a _AI_SDLC_SIGN_CMD <<< "$AI_SDLC_SIGN_ATTESTATION_CMD"
  if [ ${#_AI_SDLC_SIGN_CMD[@]} -eq 0 ]; then
    echo "[sign-attestation-if-consumer] ERROR: AI_SDLC_SIGN_ATTESTATION_CMD is set but empty" >&2
    exit 2
  fi
  if ! "${_AI_SDLC_SIGN_CMD[@]}" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE" \
      --schema-version "$SCHEMA_VERSION" \
      ${HARNESS_ARGS[@]+"${HARNESS_ARGS[@]}"}; then
    echo "[sign-attestation-if-consumer] ERROR: signer invocation (override) failed; aborting" >&2
    exit 2
  fi
else
  if [ ! -f "$SIGN_ATTESTATION_MJS" ]; then
    echo "[sign-attestation-if-consumer] ERROR: signer not found at $SIGN_ATTESTATION_MJS" >&2
    exit 2
  fi
  if ! node "$SIGN_ATTESTATION_MJS" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE" \
      --schema-version "$SCHEMA_VERSION" \
      ${HARNESS_ARGS[@]+"${HARNESS_ARGS[@]}"}; then
    echo "[sign-attestation-if-consumer] ERROR: sign-attestation.mjs failed; aborting" >&2
    exit 2
  fi
fi

if [ ! -f "$ATT_FILE" ]; then
  echo "[sign-attestation-if-consumer] ERROR: signer did not produce $ATT_FILE; aborting" >&2
  exit 2
fi

# ── Step 6: stage + commit the envelope ────────────────────────────────
(
  cd "$WT_ROOT"
  git add -- "$ATT_FILE"
  if [ -d "$WT_ROOT/.ai-sdlc/transcript-leaves" ]; then
    git add -- "$WT_ROOT/.ai-sdlc/transcript-leaves/"
  fi
  git commit --no-verify -m "chore: sign attestation for $TASK_ID (AISDLC-598)

Signed in-process by scripts/sign-attestation-if-consumer.sh because this
repo's push path does not reach the ai-sdlc attestation signer hook.
Reviewers' verdicts at .ai-sdlc/verdicts/$TASK_ID_LOWER.json.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" >&2
) || {
  echo "[sign-attestation-if-consumer] ERROR: git add/commit of attestation failed; aborting" >&2
  exit 2
}

# ── Step 7: self-verify before returning success ────────────────────────
# Never let the caller push a state we haven't confirmed passes the same
# verifier CI will run. Uses the plugin's consumer-runnable verifier
# (AISDLC-566), resolved the same self-location way as the signer above, so
# this works in a repo that has no `orchestrator/dist/` checked out.
NEW_HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
VERIFY_BASE_SHA="$MERGE_BASE"
if [ -z "$VERIFY_BASE_SHA" ]; then
  VERIFY_BASE_SHA=$(git merge-base "origin/main" HEAD 2>/dev/null || echo '')
fi

echo "[sign-attestation-if-consumer] self-verifying envelope (head=$NEW_HEAD_SHA base=$VERIFY_BASE_SHA)" >&2

VERIFY_OUTPUT=""
VERIFY_RC=0
if [ -n "${AI_SDLC_VERIFY_ATTESTATION_CMD:-}" ]; then
  read -r -a _AI_SDLC_VERIFY_CMD <<< "$AI_SDLC_VERIFY_ATTESTATION_CMD"
  VERIFY_OUTPUT=$(cd "$WT_ROOT" && "${_AI_SDLC_VERIFY_CMD[@]}" --head "$NEW_HEAD_SHA" --base "$VERIFY_BASE_SHA" 2>&1) || VERIFY_RC=$?
else
  if [ ! -f "$VERIFY_ATTESTATION_MJS" ]; then
    echo "[sign-attestation-if-consumer] ERROR: verifier not found at $VERIFY_ATTESTATION_MJS" >&2
    echo "[sign-attestation-if-consumer]        cannot confirm the envelope we just signed is valid; aborting." >&2
    exit 1
  fi
  VERIFY_OUTPUT=$(cd "$WT_ROOT" && node "$VERIFY_ATTESTATION_MJS" --head "$NEW_HEAD_SHA" --base "$VERIFY_BASE_SHA" 2>&1) || VERIFY_RC=$?
fi

echo "$VERIFY_OUTPUT" >&2

if [ "$VERIFY_RC" -ne 0 ] || ! printf '%s' "$VERIFY_OUTPUT" | grep -q '^status=valid'; then
  {
    echo ""
    echo "[sign-attestation-if-consumer] ERROR: the envelope we just signed and"
    echo "                   committed at $ATT_FILE FAILED self-verification."
    echo "                   DO NOT push this state — CI's verify-attestation"
    echo "                   gate will reject it too."
    echo ""
    echo "                   Verifier output is above. Common causes:"
    echo "                     - .ai-sdlc/trusted-reviewers.yaml missing this"
    echo "                       repo's reviewer public keys"
    echo "                     - verdict file at $VERDICT_FILE doesn't match"
    echo "                       the schema the signer expects"
    echo "                     - the signer's runtime resolved an untrusted or"
    echo "                       stale @ai-sdlc/orchestrator / @ai-sdlc/pipeline-cli"
    echo "                       install"
    echo ""
    echo "                   The chore commit already landed locally so you can"
    echo "                   inspect it; fix the root cause and re-run this"
    echo "                   script (idempotent) before pushing."
  } >&2
  exit 1
fi

echo "[sign-attestation-if-consumer] self-verify passed (status=valid) — safe to push" >&2
exit 0
