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
# AISDLC-380 fix: track whether this verdict was synthesized for a docs-only PR.
# When set to 1, Step 4d skips sub-attestation verification because docs-only
# PRs have no reviewer fan-out by design.
DOCS_ONLY_SYNTHESIZED=0
for candidate in "$VERDICT_DIR/$TASK_ID_LOWER.json" "$VERDICT_DIR/$TASK_ID.json"; do
  if [ -f "$candidate" ]; then
    VERDICT_FILE="$candidate"
    break
  fi
done

if [ -z "$VERDICT_FILE" ]; then
  # ── Step 3b: docs-only auto-approve (AISDLC-215) ─────────────────
  # Docs-only PRs never get reviewer fan-out (no real code to review),
  # so no verdict file is ever written. Rather than requiring a manual
  # sign for every docs-only PR, detect the case here and synthesize
  # auto-approved verdicts inline (transient — gitignored via
  # `.ai-sdlc/verdicts/`).
  #
  # The predicate is the canonical `scripts/is-docs-only-changeset.mjs`
  # (AISDLC-206) so the definition stays in one place and stays in sync
  # with the `paths-ignore` lists in verify-attestation.yml and
  # ai-sdlc-review.yml.
  # CRITICAL: only use origin/main as the diff base. The HEAD~1 fallback would
  # misclassify multi-commit branches where a tip docs commit follows code commits
  # (only the tip would be inspected → false-positive docs-only → false-positive
  # auto-sign of unverified code). If origin/main is unreachable (offline session,
  # shallow clone, network partition), fail-CLOSED — skip auto-sign and require
  # manual sign. Aligns the predicate's diff range with sign-attestation.mjs's
  # own origin/main dependency.
  CHANGED_FILES=$(git diff --name-only "origin/main...HEAD" 2>/dev/null || echo '__UNAVAILABLE__')
  if [ "$CHANGED_FILES" = "__UNAVAILABLE__" ]; then
    echo "[attestation-sign] no verdicts file and origin/main unreachable — skipping (manual sign required)" >&2
    exit 0
  fi
  if [ -z "$CHANGED_FILES" ]; then
    # Empty diff (no changes vs origin/main) — nothing to attest, nothing to sign.
    echo "[attestation-sign] no verdicts file and changeset is empty — skipping" >&2
    exit 0
  fi

  # Resolve the path to is-docs-only-changeset.mjs relative to this script.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  DOCS_ONLY_SCRIPT="$SCRIPT_DIR/is-docs-only-changeset.mjs"

  if [ ! -f "$DOCS_ONLY_SCRIPT" ]; then
    echo "[attestation-sign] no verdicts file and $DOCS_ONLY_SCRIPT not found — skipping" >&2
    exit 0
  fi

  ALL_DOCS=$(printf '%s\n' "$CHANGED_FILES" | node "$DOCS_ONLY_SCRIPT" 2>/dev/null || echo 'false')

  if [ "$ALL_DOCS" = "true" ]; then
    echo "[attestation-sign] docs-only changeset detected — synthesizing auto-approved verdicts for $TASK_ID" >&2
    mkdir -p "$VERDICT_DIR"
    VERDICT_FILE="$VERDICT_DIR/$TASK_ID_LOWER.json"
    # Mark as synthesized so Step 4d skips sub-attestation verification.
    # Docs-only PRs have no reviewer fan-out by design (AISDLC-215),
    # so there are no signed sub-attestations to verify.
    DOCS_ONLY_SYNTHESIZED=1
    cat > "$VERDICT_FILE" <<'VERDICTS_EOF'
[
  {"agentId":"code-reviewer","harness":"claude-code","approved":true,"findings":{"critical":0,"major":0,"minor":0,"suggestion":0},"summary":"Docs-only PR — auto-approved by check-attestation-sign.sh (AISDLC-215)"},
  {"agentId":"test-reviewer","harness":"claude-code","approved":true,"findings":{"critical":0,"major":0,"minor":0,"suggestion":0},"summary":"Docs-only PR — no code to test."},
  {"agentId":"security-reviewer","harness":"claude-code","approved":true,"findings":{"critical":0,"major":0,"minor":0,"suggestion":0},"summary":"Docs-only PR — no attack surface."}
]
VERDICTS_EOF
  else
    # No verdicts file + not docs-only — skip auto-sign as before.
    # The verifier's fallback comment will handle it on the PR side.
    echo "[attestation-sign] no verdicts file at $VERDICT_DIR/$TASK_ID_LOWER.json and changeset is not docs-only — skipping" >&2
    exit 0
  fi
fi

# ── Step 4: idempotency check + stale-envelope detection ─────────────
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

# ── Step 4c: stale-envelope detection (AISDLC-274) ───────────────────
#
# After a queue rebase the branch's parent SHA shifts. The envelope written
# in the previous iteration was named after the old dev-commit SHA, so
# `<old-sha>.dsse.json` still exists on disk but that SHA is no longer
# the commit immediately before HEAD. The idempotency check above correctly
# falls through (the NEW head SHA has no envelope), but we must also
# remove the stale envelope BEFORE signing so the PR diff doesn't accumulate
# orphan files.
#
# Predicate: get HEAD~1 SHA (the last code-commit before HEAD, or HEAD
# itself when there's only one commit). Any `.dsse.json` file in
# `.ai-sdlc/attestations/` whose basename (without `.dsse.json`) is NOT
# equal to HEAD~1 SHA (and NOT equal to HEAD_SHA — the new envelope we're
# about to write) is stale from a previous rebase+sign cycle. Remove it.
#
# We enumerate via `git diff --name-only --diff-filter=A origin/main..HEAD`
# (same filter as the signer uses) so we only consider files ADDED by the
# PR, not pre-existing attestations from merged work.
HEAD_PARENT_SHA=$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD 2>/dev/null || echo '')
if [ -n "$HEAD_PARENT_SHA" ]; then
  PR_ADDED_ENVELOPES=$(git diff --name-only --diff-filter=A "origin/main..HEAD" -- ".ai-sdlc/attestations/" 2>/dev/null || echo '')
  for ENVELOPE_PATH in $PR_ADDED_ENVELOPES; do
    # Extract the SHA from the filename (strip directory prefix and .dsse.json suffix).
    ENVELOPE_FILE="${ENVELOPE_PATH##*/}"        # basename
    ENVELOPE_SHA="${ENVELOPE_FILE%.dsse.json}"  # strip suffix
    # Only remove if it's neither the current HEAD SHA nor the parent SHA.
    if [ "$ENVELOPE_SHA" != "$HEAD_SHA" ] && [ "$ENVELOPE_SHA" != "$HEAD_PARENT_SHA" ]; then
      STALE_ABS="$WT_ROOT/$ENVELOPE_PATH"
      if [ -f "$STALE_ABS" ]; then
        rm -f "$STALE_ABS"
        echo "[attestation-sign] removed stale envelope (rebase cycle): $ENVELOPE_PATH" >&2
      fi
    fi
  done
fi

# ── Step 4b: upstream auto-sign chore detection (AISDLC-135) ─────────
# When this hook signs + commits an envelope (Step 6 below), exit 1 aborts
# the push. The operator (or `/ai-sdlc execute` Step 11 push loop) then
# re-runs `git push`. Normally the second push hits the envelope-exists
# idempotency check above and short-circuits cleanly.
#
# But there's a window where it doesn't: if the operator amends, rebases,
# or otherwise rewrites HEAD between the two pushes such that the
# attestation file moves but the chore-commit subject line stays in place,
# the envelope-at-HEAD check misses and the hook re-fires — signing a
# second envelope on top, adding another chore commit, and looping forever
# until the operator escapes with AI_SDLC_SKIP_ATTESTATION_SIGN=1.
#
# Reproduction: PR #168 cycled twice on AISDLC-115.6 before the operator
# broke the loop manually.
#
# Defense: if HEAD's commit subject line is itself the auto-sign chore
# we just produced, treat it as a "second push of the same cycle" and
# fall through with exit 0. The next dev commit on top will not match
# this prefix and the hook will fire normally.
LAST_COMMIT_SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null || echo '')
if [[ "${LAST_COMMIT_SUBJECT:-}" == "chore: auto-sign attestation for "* ]]; then
  # HEAD is an auto-sign chore commit from a previous run of this hook.
  # The corresponding envelope was committed AS this commit, so it lives
  # at the PARENT's HEAD-sha — not at the chore commit's own SHA. Skipping
  # here is correct: signing again would just produce a redundant envelope.
  exit 0
fi

# ── Step 4d: verify reviewer sub-attestations (AISDLC-380) ──────────
#
# Before invoking the signer, verify that the verdict file contains signed
# sub-attestations from each reviewer — NOT plain fabricated JSON.
#
# The 2026-05-20 incident (AISDLC-377.1): a dev subagent wrote a verdict
# file with `approved: true` for all 3 reviewers but no cryptographic proof
# that the reviewers actually ran. The hook signed it, CI accepted it, and
# 3 real majors shipped to main.
#
# Defense: `scripts/verify-reviewer-sub-attestations.mjs` checks each
# sub-attestation's signature against `.ai-sdlc/trusted-reviewers.yaml`.
# The verifier exits:
#   0 → all sub-attestations verified (or AI_SDLC_LEGACY_VERDICTS=1 legacy mode)
#   1 → verification failed; hook refuses to sign
#   2 → internal error
#
# Test override: AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD can inject a stub.
#
# Skip when: DOCS_ONLY_SYNTHESIZED=1 (verdict was just synthesized by Step 3b
# for a docs-only PR — there are no reviewer sub-attestations to verify because
# docs-only PRs have no reviewer fan-out by design, AISDLC-215).
TRUSTED_REVIEWERS_YAML="$WT_ROOT/.ai-sdlc/trusted-reviewers.yaml"
VERIFY_SUB_ATT_SCRIPT="$WT_ROOT/scripts/verify-reviewer-sub-attestations.mjs"

if [ "${DOCS_ONLY_SYNTHESIZED:-0}" = "1" ]; then
  echo "[attestation-sign] docs-only synthesized verdict — skipping sub-attestation verification (no reviewer fan-out)" >&2
elif [ -n "${AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD:-}" ]; then
  # Test override: use the stub verifier directly, bypassing file-existence checks.
  # This lets tests exercise the hook's signing + commit logic without needing
  # real verifier/registry files in the test repo. Production code never sets this.
  echo "[attestation-sign] Verifying reviewer sub-attestations for $TASK_ID (using test override)" >&2
  VERIFY_EXIT=0
  # shellcheck disable=SC2086
  $AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD \
    --verdict-file "$VERDICT_FILE" \
    --task-id "$TASK_ID" \
    --trusted-reviewers "$TRUSTED_REVIEWERS_YAML" || VERIFY_EXIT=$?
  if [ "$VERIFY_EXIT" -eq 1 ]; then
    echo "[attestation-sign] ERROR: sub-attestation verification failed — refusing to sign" >&2
    exit 2
  elif [ "$VERIFY_EXIT" -ne 0 ]; then
    echo "[attestation-sign] ERROR: sub-attestation verifier exited with unexpected code $VERIFY_EXIT" >&2
    exit 2
  fi
elif [ ! -f "$VERIFY_SUB_ATT_SCRIPT" ]; then
  # AISDLC-380 fix #3: fail-CLOSED when verifier missing — a dev could remove
  # the script to disable the gate. Scripts dir is not in blockedPaths but this
  # fail-CLOSED posture removes the bypass value.
  echo "[attestation-sign] ERROR: $VERIFY_SUB_ATT_SCRIPT not found — refusing to sign (sub-attestation gate unavailable)" >&2
  echo "[attestation-sign]        Restore the file or set AI_SDLC_SKIP_ATTESTATION_SIGN=1 to defer." >&2
  exit 2
elif [ ! -f "$TRUSTED_REVIEWERS_YAML" ]; then
  # AISDLC-380 fix #3: fail-CLOSED when registry missing.
  echo "[attestation-sign] ERROR: $TRUSTED_REVIEWERS_YAML not found — refusing to sign (trusted-reviewers registry missing)" >&2
  echo "[attestation-sign]        Create the registry file or set AI_SDLC_SKIP_ATTESTATION_SIGN=1 to defer." >&2
  exit 2
else
  echo "[attestation-sign] Verifying reviewer sub-attestations for $TASK_ID" >&2
  VERIFY_EXIT=0
  node "$VERIFY_SUB_ATT_SCRIPT" \
    --verdict-file "$VERDICT_FILE" \
    --task-id "$TASK_ID" \
    --trusted-reviewers "$TRUSTED_REVIEWERS_YAML" || VERIFY_EXIT=$?
  if [ "$VERIFY_EXIT" -eq 1 ]; then
    echo "[attestation-sign] ERROR: sub-attestation verification failed — refusing to sign" >&2
    echo "[attestation-sign]        Re-run reviewer subagents to produce signed sub-attestations." >&2
    echo "[attestation-sign]        Emergency legacy escape: AI_SDLC_LEGACY_VERDICTS=1 git push" >&2
    exit 2
  elif [ "$VERIFY_EXIT" -ne 0 ]; then
    echo "[attestation-sign] ERROR: sub-attestation verifier exited with unexpected code $VERIFY_EXIT" >&2
    exit 2
  fi
fi

# ── Step 5: invoke the signer ────────────────────────────────────────
# The default signer is the same script `/ai-sdlc execute` Step 10 used to
# call directly. Tests inject a stub via AI_SDLC_SIGN_ATTESTATION_CMD so
# they don't need the orchestrator built.
ITERATION_COUNT="${AI_SDLC_ITERATION_COUNT:-1}"
HARNESS_NOTE="${AI_SDLC_HARNESS_NOTE:-}"

# ── AISDLC-250: Codex harness identification ──────────────────────────
# When `CODEX_VERSION` is set (operator pre-exports
# `export CODEX_VERSION="codex@$(codex --version)"`), pass
# `--harness-name codex --harness-version <version>` to the signer so
# the attestation envelope carries the harness field automatically.
# Format: "codex@X.Y.Z" → harness-name=codex, harness-version=X.Y.Z.
# When unset, no extra args are passed (back-compat: harness field absent).
HARNESS_ARGS=""
if [ -n "${CODEX_VERSION:-}" ]; then
  # Strip the "codex@" prefix to extract the version number.
  CODEX_VERSION_NUM="${CODEX_VERSION#codex@}"
  HARNESS_ARGS="--harness-name codex --harness-version $CODEX_VERSION_NUM"
  echo "[attestation-sign] Codex harness detected: name=codex version=$CODEX_VERSION_NUM" >&2
fi

echo "[attestation-sign] Auto-signing attestation for $TASK_ID against HEAD $HEAD_SHA" >&2

if [ -n "${AI_SDLC_SIGN_ATTESTATION_CMD:-}" ]; then
  # Test override: split on whitespace via word splitting (intentional —
  # callers can pass multi-word commands like "node /tmp/fake-signer.mjs").
  # shellcheck disable=SC2086
  if ! $AI_SDLC_SIGN_ATTESTATION_CMD \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE" \
      $HARNESS_ARGS; then
    echo "[attestation-sign] ERROR: signer invocation (override) failed; aborting push" >&2
    exit 2
  fi
else
  # shellcheck disable=SC2086
  if ! node "$WT_ROOT/ai-sdlc-plugin/scripts/sign-attestation.mjs" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE" \
      $HARNESS_ARGS; then
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
