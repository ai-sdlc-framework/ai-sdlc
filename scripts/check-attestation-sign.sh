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
#      (per AISDLC-81). Sentinel absent → no task context: nothing can be
#      signed, but an existing envelope for the current patch id is still
#      verified (step 4); with no envelope either → exit 0 (chore PRs, ad-hoc
#      commits, docs-only PRs all push without an attestation).
#   3. Locate the verdict file at `<worktree>/.ai-sdlc/verdicts/<task-id>.json`.
#      Verdict file absent AND no envelope for the current patch id → exit 0
#      (reviewers haven't run yet; the verdict file is the explicit "we're
#      ready to attest" handoff from /ai-sdlc execute). Note: docs-only PRs are
#      handled entirely by CI (AISDLC-214) per RFC-0042 Phase 3. The hook does
#      NOT synthesize verdicts for docs-only changesets — it exits 0 as a
#      no-op, same as any other case where there is nothing to attest.
#      AISDLC-694: the no-verdict exit now happens AFTER the envelope check
#      (step 4) because a push that already carries an envelope must have that
#      envelope verified even when no verdict file is present.
#   4. Idempotency + verification (AISDLC-694): if an envelope for the current
#      patch id already exists, run `scripts/verify-attestation.mjs` — the SAME
#      verifier CI runs — against local HEAD and the merge base with
#      origin/main (PR_HEAD_SHA / PR_BASE_SHA). The hook contains NO
#      acceptance rules of its own; it only consumes the verifier's
#      `status=` / `reason=` output.
#        - status=valid → exit 0 (already signed; no fixup).
#        - not valid + verdict file present → re-sign through steps 5-7
#          (only the rejected envelope for the current patch id is replaced),
#          then verify the re-signed result; exit through the normal
#          "re-run git push" flow. The message names the verifier's reason.
#        - not valid + no verdict file → exit 2 with the verifier's reason and
#          the instruction to re-run the review. Nothing is signed and no
#          commit is created.
#        - verifier inputs not built (module not found / orchestrator dist
#          missing) → exit 2 with the build instruction. Never skipped
#          silently. A verifier exit code 2 (missing env) is a hook bug and
#          also fails loudly.
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
#   AI_SDLC_VERIFY_ATTESTATION_CMD="<command>" — (AISDLC-694, TEST HOOK, not a
#   skip variable) replaces `node scripts/verify-attestation.mjs` so tests can
#   stub the verifier without building the orchestrator. Same safety contract
#   as the signer override: it is refused unless AI_SDLC_ALLOW_SIGNER_OVERRIDE=1
#   is also set, because a substitute verifier that prints `status=valid`
#   would defeat the check. The command receives PR_HEAD_SHA / PR_BASE_SHA in
#   its environment and must print `status=<...>` and `reason=<...>` lines.
#   AI_SDLC_PATCH_ID_EXCLUSIONS_CMD="<command>" — overrides the
#   `print-patch-id-exclusions` invocation (AISDLC-618) so tests can stub the
#   exclusion-pathspec source without needing the orchestrator built. The
#   override must print one pathspec per line to stdout.
#
# Exit codes:
#   0 — nothing to sign (no sentinel, no verdict, or already attested with an
#       envelope the verifier accepts), or AI_SDLC_SKIP_ATTESTATION_SIGN=1
#       short-circuit.
#   1 — signed + committed an attestation; push aborted; operator must
#       re-run `git push` to send the new chore commit.
#   2 — signer invocation itself failed (refuses to abort the push silently),
#       OR (AISDLC-694) the existing envelope was rejected by the verifier and
#       cannot be re-signed (no verdict file), OR the verifier could not run.

set -euo pipefail

if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[attestation-sign] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

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
TASK_ID=""
if [ -f "$SENTINEL" ]; then
  TASK_ID=$(tr -d '[:space:]' < "$SENTINEL")
  if [ -z "$TASK_ID" ]; then
    echo "[attestation-sign] WARN: $SENTINEL is empty; no task ID to bind" >&2
  fi
fi
# AISDLC-734: a worktree without the sentinel used to skip signing with no way
# to say which task to sign for. Honour AI_SDLC_ACTIVE_TASK_ID (the same env
# fallback the PreToolUse hook and the MCP server use) when the sentinel gives
# no task.
if [ -z "$TASK_ID" ] && [ -n "${AI_SDLC_ACTIVE_TASK_ID:-}" ]; then
  TASK_ID=$(printf '%s' "$AI_SDLC_ACTIVE_TASK_ID" | tr -d '[:space:]')
  if [ -n "$TASK_ID" ]; then
    echo "[attestation-sign] no usable $SENTINEL; using AI_SDLC_ACTIVE_TASK_ID=$TASK_ID" >&2
  fi
fi
# Shown wherever the hook skips because no task is known.
NO_TASK_HINT="to sign, run: echo <TASK-ID> > $SENTINEL (or export AI_SDLC_ACTIVE_TASK_ID=<TASK-ID>) and push again"
# AISDLC-694: an absent or empty sentinel is NO LONGER an immediate exit. With no
# task context there is nothing to sign (no verdict file can be located), but a
# push that already carries an envelope for the current patch id must still have
# that envelope verified, and a rejected one fails the push (Step 4). With no
# envelope either, Step 4 exits 0: chore commits, ad-hoc fixes, docs-only PRs and
# manual pushes outside /ai-sdlc execute all push without an attestation, and the
# verifier reports "missing" in CI for any downstream PR that needs one.

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
if [ -n "$TASK_ID" ]; then
  for candidate in "$VERDICT_DIR/$TASK_ID_LOWER.json" "$VERDICT_DIR/$TASK_ID.json"; do
    if [ -f "$candidate" ]; then
      VERDICT_FILE="$candidate"
      break
    fi
  done
fi

# AISDLC-694: an absent verdict file is NO LONGER an immediate exit here. The
# "no verdict → no attestation needed" no-op still applies, but only when there
# is also no envelope for the current patch id (decided in Step 4 below, once
# the envelope path is known). A push that already carries an envelope the
# verifier rejects must fail rather than slip through silently.

# ── Step 4: idempotency check + stale-envelope detection ─────────────
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
if [ -z "$HEAD_SHA" ]; then
  echo "[attestation-sign] WARN: cannot resolve HEAD; skipping" >&2
  exit 0
fi

# RFC-0042 Phase 3 (AISDLC-383.6): schema version determines the envelope filename.
#   v5 → .ai-sdlc/attestations/<sha>.dsse.json
#   v6 → .ai-sdlc/attestations/<sha>.v6.dsse.json
# Read the schema version early so idempotency + signer + post-sign checks all agree.
#
# CUTOVER STATUS: v6 is the DEFAULT post-AISDLC-409 (2026-05-23). The
# prerequisite (transcript leaves emitted by /ai-sdlc execute Step 7c and the
# orchestrator-tick reconciliation step) is in place. The polarity here MUST
# mirror sign-attestation.mjs's defaultSchema logic so the hook and the signer
# agree — otherwise the hook would force a v5 envelope on the canonical
# /ai-sdlc execute path even though the signer's default is v6, which would
# silently regress the AISDLC-380 forgery defense (security finding on the
# AISDLC-409 PR review).
#
# Operator opt-outs (in precedence order):
#   - AI_SDLC_SCHEMA_VERSION=v5 explicit pin
#   - AI_SDLC_V5_LEGACY=1
#   - Legacy: AI_SDLC_V6_CUTOVER_ACTIVE=0 (operators who pinned the old env
#     to 0 keep that behavior; any other value of that env now defaults to v6)
if [ "${AI_SDLC_V5_LEGACY:-0}" = "1" ] || [ "${AI_SDLC_V6_CUTOVER_ACTIVE:-1}" = "0" ]; then
  SCHEMA_VERSION="${AI_SDLC_SCHEMA_VERSION:-v5}"
else
  SCHEMA_VERSION="${AI_SDLC_SCHEMA_VERSION:-v6}"
fi

# AISDLC-398: compute content-addressed patch-id for the idempotency check.
# The primary envelope filename is now <patch-id>.dsse.json (or .v6.dsse.json)
# so we check that file first. If patch-id computation fails we fall back to
# the per-SHA filename (pre-AISDLC-398 behaviour).
#
# AISDLC-618: exclusion pathspecs are resolved from the SAME single source of
# truth the TypeScript signer/verifier use — `PATCH_ID_EXCLUSIONS` in
# pipeline-cli/src/attestation/patch-id.ts, surfaced via
# `cli-attestation print-patch-id-exclusions`. AISDLC-610 added
# `backlog/tasks/` + `backlog/completed/` to that array (and AISDLC-616 added
# `.ai-sdlc/reviews/`) but this hook's hardcoded three-entry list was never
# updated in lockstep, so every task-move PR (i.e. every `/ai-sdlc execute`
# PR) computed a DIFFERENT patch-id here than the signer did — the signer
# would write envelope B, this hook would look for envelope A, not find it,
# and hard-abort the push. Shelling out to the compiled CLI when it's
# available eliminates the possibility of the two lists drifting again;
# PATCH_ID_EXCLUSIONS_FALLBACK below is ONLY used when the CLI can't be
# invoked (fresh worktree with no `pnpm build` yet, hermetic test repo with
# no pipeline-cli/ present at all) and is asserted to match
# PATCH_ID_EXCLUSIONS by `check-attestation-sign.test.mjs`'s lockstep test —
# so even the fallback path cannot silently drift.
PATCH_ID_EXCLUSIONS_FALLBACK=(
  ':!.ai-sdlc/attestations/'
  ':!.ai-sdlc/transcript-leaves/'
  ':!.ai-sdlc/transcript-leaves.jsonl'
  ':!backlog/tasks/'
  ':!backlog/completed/'
  ':!.ai-sdlc/reviews/'
)

PATCH_ID_EXCLUSIONS=()
CLI_ATTESTATION_BIN="$WT_ROOT/pipeline-cli/bin/cli-attestation.mjs"
if [ -n "${AI_SDLC_PATCH_ID_EXCLUSIONS_CMD:-}" ]; then
  # TEST-ONLY override (never set by any production caller): lets
  # check-attestation-sign.test.mjs stub the exclusions source without
  # requiring the orchestrator to be built or pipeline-cli/ to be present at
  # all. Env-gated (empty/unset is the default, no-op path) so there is no
  # security regression — the `eval` below only ever runs a value this same
  # process's own environment explicitly set.
  CLI_CMD="$AI_SDLC_PATCH_ID_EXCLUSIONS_CMD"
  while IFS= read -r line; do
    [ -n "$line" ] && PATCH_ID_EXCLUSIONS+=("$line")
  done < <(eval "$CLI_CMD" 2>/dev/null || true)
elif [ -f "$CLI_ATTESTATION_BIN" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && PATCH_ID_EXCLUSIONS+=("$line")
  done < <(node "$CLI_ATTESTATION_BIN" print-patch-id-exclusions --repo-root "$WT_ROOT" 2>/dev/null || true)
fi
if [ ${#PATCH_ID_EXCLUSIONS[@]} -eq 0 ]; then
  PATCH_ID_EXCLUSIONS=("${PATCH_ID_EXCLUSIONS_FALLBACK[@]}")
fi

MERGE_BASE=$(git merge-base "origin/main" HEAD 2>/dev/null || echo '')
PATCH_ID=""
if [ -n "$MERGE_BASE" ] && [ ${#MERGE_BASE} -eq 40 ]; then
  # Compute patch-id: pipe diff-tree output through git patch-id --stable.
  # AISDLC-422 / AISDLC-475 (AC#6) / AISDLC-610 / AISDLC-616 / AISDLC-618:
  # keep the exclusion list IDENTICAL to PATCH_ID_EXCLUSIONS in
  # pipeline-cli/src/attestation/patch-id.ts AND to
  # ATTESTATION_PATH_EXCLUSIONS in scripts/verify-attestation.mjs. Asymmetric
  # exclusion makes this bash hook compute a different patch-id than the
  # TypeScript signer, which is the failure mode AISDLC-422/618 fix.
  DIFF_OUTPUT=$(git diff-tree --no-color -p "${MERGE_BASE}..HEAD" -- "${PATCH_ID_EXCLUSIONS[@]}" 2>/dev/null || echo '')
  if [ -n "$DIFF_OUTPUT" ]; then
    PATCH_ID_LINE=$(printf '%s' "$DIFF_OUTPUT" | git patch-id --stable 2>/dev/null | head -1 || echo '')
    # Output format: "<patch-id> <commit-sha>"
    PATCH_ID=$(printf '%s' "$PATCH_ID_LINE" | cut -c1-40 2>/dev/null || echo '')
    # Validate it looks like a 40-char hex string
    if ! printf '%s' "$PATCH_ID" | grep -qE '^[0-9a-f]{40}$'; then
      PATCH_ID=""
    fi
  fi
fi

if [ "$SCHEMA_VERSION" = "v6" ]; then
  # Primary (content-addressed, AISDLC-398)
  if [ -n "$PATCH_ID" ]; then
    ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$PATCH_ID.v6.dsse.json"
  else
    ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.v6.dsse.json"
  fi
  # Legacy per-SHA filename — used ONLY for the pre-patch-id fallback idempotency
  # check (when PATCH_ID is empty). AISDLC-475 Fix B: when PATCH_ID is available,
  # we check ONLY the patch-id file and do NOT fall back to the per-SHA file.
  # The per-SHA bridge is no longer written by the signer (AISDLC-475), so
  # checking it when a patch-id is available would cause a false "not signed"
  # result after the chore-commit moves HEAD past the signed SHA — which is
  # exactly the re-sign loop this fix is designed to eliminate.
  if [ -z "$PATCH_ID" ]; then
    ATT_FILE_LEGACY="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.v6.dsse.json"
  else
    ATT_FILE_LEGACY=""
  fi
else
  # Primary (content-addressed, AISDLC-398)
  if [ -n "$PATCH_ID" ]; then
    ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$PATCH_ID.dsse.json"
  else
    ATT_FILE="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.dsse.json"
  fi
  # Legacy per-SHA filename — same AISDLC-475 Fix B logic for v5 schema.
  if [ -z "$PATCH_ID" ]; then
    ATT_FILE_LEGACY="$WT_ROOT/.ai-sdlc/attestations/$HEAD_SHA.dsse.json"
  else
    ATT_FILE_LEGACY=""
  fi
fi

# Idempotency check: if the primary (patch-id) envelope already exists, nothing
# to do. When PATCH_ID is available, we check ONLY the patch-id file (AISDLC-475
# Fix B). When PATCH_ID is absent (pre-AISDLC-398 or patch-id computation failed),
# we fall back to the per-SHA file (ATT_FILE_LEGACY is set in that case only).
#
# This closes the re-sign loop: after a chore-commit moves HEAD past the signed
# dev commit, HEAD_SHA changes but PATCH_ID stays the same. The patch-id file
# already exists → idempotent skip. Without this change, the hook would fall
# through to the per-SHA check (ATT_FILE_LEGACY = <new-chore-SHA>.v6.dsse.json),
# find it missing, and re-sign unconditionally — looping forever.
#
# AISDLC-694: an envelope merely EXISTING is not proof it is acceptable. After a
# history rewrite its subject commit can be missing from the pushed history, and
# CI would reject it. So when an envelope exists we run the SAME verifier CI runs
# (scripts/verify-attestation.mjs) and act only on what it reports. The hook
# holds no acceptance rules of its own.

# run_attestation_verifier <head-sha> <base-sha>
# Sets VERIFY_STATUS / VERIFY_REASON. Exits the whole hook (code 2) when the
# verifier cannot run or crashes; returns normally only when it emitted a
# `status=` line.
VERIFY_STATUS=""
VERIFY_REASON=""
run_attestation_verifier() {
  local v_head="$1" v_base="$2"
  local v_out v_err v_rc=0
  local -a v_cmd
  v_cmd=()
  VERIFY_STATUS=""
  VERIFY_REASON=""

  if [ -z "$v_base" ] || [ -z "$v_head" ]; then
    echo "[attestation-sign] ERROR: an attestation envelope exists but the merge base against origin/main" >&2
    echo "[attestation-sign]   could not be resolved, so it cannot be verified. Run: git fetch origin main" >&2
    exit 2
  fi

  if [ -n "${AI_SDLC_VERIFY_ATTESTATION_CMD:-}" ]; then
    if [ "${AI_SDLC_ALLOW_SIGNER_OVERRIDE:-0}" != "1" ]; then
      echo "[attestation-sign] ERROR: AI_SDLC_VERIFY_ATTESTATION_CMD is set but" >&2
      echo "[attestation-sign]   AI_SDLC_ALLOW_SIGNER_OVERRIDE=1 is not. Refusing to run a" >&2
      echo "[attestation-sign]   substitute verifier. This override exists for tests only." >&2
      exit 2
    fi
    read -r -a v_cmd <<< "$AI_SDLC_VERIFY_ATTESTATION_CMD"
    if [ ${#v_cmd[@]} -eq 0 ]; then
      echo "[attestation-sign] ERROR: AI_SDLC_VERIFY_ATTESTATION_CMD is set but empty" >&2
      exit 2
    fi
  else
    if [ ! -f "$WT_ROOT/scripts/verify-attestation.mjs" ] || [ ! -f "$WT_ROOT/orchestrator/dist/runtime/attestations.js" ]; then
      echo "[attestation-sign] ERROR: an attestation envelope exists but the verifier inputs are not built" >&2
      echo "[attestation-sign]   (orchestrator/dist/runtime/attestations.js is missing)." >&2
      echo "[attestation-sign]   Run: pnpm --filter @ai-sdlc/orchestrator build" >&2
      exit 2
    fi
    v_cmd=(node "$WT_ROOT/scripts/verify-attestation.mjs")
  fi

  v_out=$(mktemp)
  v_err=$(mktemp)
  # GITHUB_OUTPUT is dropped so a hook run inside CI never writes into the
  # surrounding job's step outputs.
  ( cd "$WT_ROOT" && env -u GITHUB_OUTPUT PR_HEAD_SHA="$v_head" PR_BASE_SHA="$v_base" "${v_cmd[@]}" ) \
    >"$v_out" 2>"$v_err" || v_rc=$?
  local v_stdout v_stderr
  v_stdout=$(cat "$v_out")
  v_stderr=$(cat "$v_err")
  [ -n "$v_out" ] && rm -f "$v_out"
  [ -n "$v_err" ] && rm -f "$v_err"

  if printf '%s' "$v_stderr" | grep -qE 'ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND'; then
    echo "[attestation-sign] ERROR: an attestation envelope exists but the verifier inputs are not built:" >&2
    printf '%s\n' "$v_stderr" | head -3 >&2
    echo "[attestation-sign]   Run: pnpm --filter @ai-sdlc/orchestrator build" >&2
    exit 2
  fi
  if [ "$v_rc" -eq 2 ]; then
    echo "[attestation-sign] ERROR: verifier exited 2 (PR_HEAD_SHA / PR_BASE_SHA missing) — this is a hook bug:" >&2
    printf '%s\n' "$v_stderr" >&2
    exit 2
  fi
  if [ "$v_rc" -ne 0 ]; then
    echo "[attestation-sign] ERROR: verifier crashed (exit $v_rc):" >&2
    printf '%s\n' "$v_stderr" >&2
    exit 2
  fi
  VERIFY_STATUS=$(printf '%s\n' "$v_stdout" | sed -n 's/^status=//p' | head -1)
  VERIFY_REASON=$(printf '%s\n' "$v_stdout" | sed -n 's/^reason=//p' | head -1)
  if [ -z "$VERIFY_STATUS" ]; then
    echo "[attestation-sign] ERROR: verifier produced no status= line:" >&2
    printf '%s\n' "$v_stdout" "$v_stderr" >&2
    exit 2
  fi
}

ENVELOPE_PRESENT=0
REJECTED_ENVELOPE=""
if [ -f "$ATT_FILE" ]; then
  ENVELOPE_PRESENT=1
  REJECTED_ENVELOPE="$ATT_FILE"
elif [ -n "$ATT_FILE_LEGACY" ] && [ -f "$ATT_FILE_LEGACY" ]; then
  ENVELOPE_PRESENT=1
  REJECTED_ENVELOPE="$ATT_FILE_LEGACY"
fi

RESIGN=0
VERIFY_REJECTION_REASON=""
if [ "$ENVELOPE_PRESENT" = "1" ]; then
  # Same base the patch id above was computed against (MERGE_BASE).
  run_attestation_verifier "$HEAD_SHA" "$MERGE_BASE"
  if [ "$VERIFY_STATUS" = "valid" ]; then
    # Already signed for this content and the verifier accepts it. Either the
    # previous push aborted (this script set exit 1, operator re-pushed, chore
    # commit is on HEAD with the envelope present), or the operator pre-signed.
    exit 0
  fi
  VERIFY_REJECTION_REASON="status=$VERIFY_STATUS: $VERIFY_REASON"
  if [ -z "$VERDICT_FILE" ]; then
    echo "[attestation-sign] ERROR: the attestation envelope for this change was rejected by" >&2
    echo "[attestation-sign]   scripts/verify-attestation.mjs ($VERIFY_REJECTION_REASON)" >&2
    if [ -z "$TASK_ID" ]; then
      echo "[attestation-sign]   and there is no active task ($SENTINEL is absent or empty and" >&2
      echo "[attestation-sign]   AI_SDLC_ACTIVE_TASK_ID is unset), so it cannot be re-signed." >&2
      echo "[attestation-sign]   Re-run the review, then $NO_TASK_HINT." >&2
    else
      echo "[attestation-sign]   and there is no reviewer verdict file at $VERDICT_DIR/$TASK_ID_LOWER.json," >&2
      echo "[attestation-sign]   so it cannot be re-signed. Re-run the review for $TASK_ID, then push again." >&2
    fi
    exit 2
  fi
  RESIGN=1
  echo "[attestation-sign] existing envelope rejected by the verifier ($VERIFY_REJECTION_REASON) — re-signing" >&2
else
  if [ -z "$VERDICT_FILE" ]; then
    # No envelope and no verdict file — reviewers haven't run yet (or this is a
    # docs-only PR, chore commit, or ad-hoc push). Docs-only PRs are handled
    # entirely by CI (AISDLC-214 short-circuits verify-attestation.yml with a
    # direct `ai-sdlc/attestation: success` status) per RFC-0042 Phase 3. No
    # verdict synthesis is performed here — exit 0 as a no-op.
    if [ -z "$TASK_ID" ]; then
      echo "[attestation-sign] no active task and no envelope for this change — skipping (no attestation needed; $NO_TASK_HINT)" >&2
    else
      echo "[attestation-sign] no verdicts file at $VERDICT_DIR/$TASK_ID_LOWER.json — skipping (no attestation needed)" >&2
    fi
    exit 0
  fi
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
# AISDLC-694: skipped on the re-sign path. That sweep deletes every PR-added
# envelope whose basename is not HEAD/HEAD~1, which would remove envelopes other
# than the one the verifier just rejected. The re-sign path replaces exactly
# one envelope (Step 5).
if [ "$RESIGN" != "1" ] && [ -n "$HEAD_PARENT_SHA" ]; then
  PR_ADDED_ENVELOPES=$(git diff --name-only --diff-filter=A "origin/main..HEAD" -- ".ai-sdlc/attestations/" 2>/dev/null || echo '')
  for ENVELOPE_PATH in $PR_ADDED_ENVELOPES; do
    # Extract the SHA from the filename (strip directory prefix and .dsse.json suffix).
    # RFC-0042 Phase 3: v6 files end in .v6.dsse.json; strip both suffixes to get SHA.
    ENVELOPE_FILE="${ENVELOPE_PATH##*/}"        # basename
    ENVELOPE_SHA="${ENVELOPE_FILE%.v6.dsse.json}"  # strip v6 suffix first
    if [ "$ENVELOPE_SHA" = "$ENVELOPE_FILE" ]; then
      # Not a .v6.dsse.json file — try stripping plain .dsse.json suffix.
      ENVELOPE_SHA="${ENVELOPE_FILE%.dsse.json}"
    fi
    # Only remove if it's neither the current HEAD SHA nor the parent SHA.
    #
    # AISDLC-543 AC#3: the v6 signer writes ONLY patch-id-named envelopes
    # (AISDLC-475 Fix B). When a patch-id is available, a PR-added
    # `<sha>.v6.dsse.json` that is not that patch-id is a stale head-sha-named
    # envelope (PR #912: named for a head the automation's own squash then
    # rewrote) and hard-fails the verifier's filename check, so it is removed
    # even when its name equals HEAD / HEAD~1.
    STALE_HEAD_NAMED=0
    if [ "$SCHEMA_VERSION" = "v6" ] && [ -n "$PATCH_ID" ] \
       && [ "$ENVELOPE_FILE" != "$ENVELOPE_SHA" ] \
       && [ "${ENVELOPE_FILE}" = "${ENVELOPE_SHA}.v6.dsse.json" ] \
       && [ "$ENVELOPE_SHA" != "$PATCH_ID" ]; then
      STALE_HEAD_NAMED=1
    fi
    if { [ "$ENVELOPE_SHA" != "$HEAD_SHA" ] && [ "$ENVELOPE_SHA" != "$HEAD_PARENT_SHA" ]; } || [ "$STALE_HEAD_NAMED" = "1" ]; then
      STALE_ABS="$WT_ROOT/$ENVELOPE_PATH"
      [ -n "$STALE_ABS" ] || { echo "[attestation-sign] refusing rm: STALE_ABS empty" >&2; continue; }
      if [ -f "$STALE_ABS" ]; then
        # AISDLC-739: a committed envelope is restored from HEAD, never deleted
        # from the working copy (that leaves a spurious tracked deletion).
        if [ "$STALE_HEAD_NAMED" != "1" ] && git cat-file -e "HEAD:$ENVELOPE_PATH" 2>/dev/null; then
          git checkout HEAD -- "$ENVELOPE_PATH" 2>/dev/null || true
          echo "[attestation-sign] restored committed envelope (rebase cycle): $ENVELOPE_PATH" >&2
        else
          rm -f "$STALE_ABS"
          echo "[attestation-sign] removed stale envelope (rebase cycle): $ENVELOPE_PATH" >&2
        fi
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
# AISDLC-694: not applied on the re-sign path — there HEAD is typically the
# (now stale) auto-sign chore commit itself, and the verifier has already
# decided the envelope on it is not acceptable.
if [ "$RESIGN" != "1" ] && [[ "${LAST_COMMIT_SUBJECT:-}" == "chore: auto-sign attestation for "* ]]; then
  # HEAD is an auto-sign chore commit from a previous run of this hook.
  # The corresponding envelope was committed AS this commit, so it lives
  # at the PARENT's HEAD-sha — not at the chore commit's own SHA. Skipping
  # here is correct: signing again would just produce a redundant envelope.
  exit 0
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
# AISDLC-555: array, not a string. An unquoted $HARNESS_ARGS expansion is
# word-split by the shell; an array preserves argument boundaries exactly.
HARNESS_ARGS=()
if [ -n "${CODEX_VERSION:-}" ]; then
  # Strip the "codex@" prefix to extract the version number.
  CODEX_VERSION_NUM="${CODEX_VERSION#codex@}"
  HARNESS_ARGS=(--harness-name codex --harness-version "$CODEX_VERSION_NUM")
  echo "[attestation-sign] Codex harness detected: name=codex version=$CODEX_VERSION_NUM" >&2
fi

echo "[attestation-sign] Auto-signing attestation for $TASK_ID against HEAD $HEAD_SHA (schema: $SCHEMA_VERSION)" >&2

if [ -n "${AI_SDLC_SIGN_ATTESTATION_CMD:-}" ] && [ "${AI_SDLC_ALLOW_SIGNER_OVERRIDE:-0}" != "1" ]; then
  # AISDLC-555 round-3 security review. This override replaces the signer at
  # `git push` time on a machine where ~/.ai-sdlc/signing-key.pem exists, and
  # it is expanded UNQUOTED, so anything able to set env before a push — a
  # repo-committed direnv `.envrc`, an npm script or Makefile target wrapping
  # `git push`, a CI job env, an IDE run configuration — gets arbitrary command
  # execution in that context. AISDLC-133 already recorded the need for a
  # test-mode sentinel; shipping this script to adopter repos is what makes it
  # urgent, since the blast radius stops being this one monorepo.
  #
  # Refuse rather than silently ignore: a stale export that quietly stopped
  # taking effect would be its own debugging trap.
  echo "[attestation-sign] ERROR: AI_SDLC_SIGN_ATTESTATION_CMD is set but" >&2
  echo "[attestation-sign]   AI_SDLC_ALLOW_SIGNER_OVERRIDE=1 is not. Refusing to run a" >&2
  echo "[attestation-sign]   substitute signer. This override exists for tests only." >&2
  echo "[attestation-sign]   If you did not set it, something in your environment did —" >&2
  echo "[attestation-sign]   check direnv, npm scripts, and CI env before re-running." >&2
  exit 2
fi

# AISDLC-694: on the re-sign path, move ONLY the envelope the verifier just
# rejected (REJECTED_ENVELOPE, the file for the current patch id) out of the way
# so the signer writes a fresh one, and put it back if signing fails so a failed
# re-sign never leaves the tree without the envelope it started with. No other
# envelope is touched.
REJECTED_BACKUP=""
REJECTED_BACKUP_DIR=""
restore_rejected_envelope() {
  if [ -n "$REJECTED_BACKUP" ] && [ -f "$REJECTED_BACKUP" ] && [ -n "$REJECTED_ENVELOPE" ]; then
    mv -f "$REJECTED_BACKUP" "$REJECTED_ENVELOPE"
  fi
  if [ -n "$REJECTED_BACKUP_DIR" ] && [ -d "$REJECTED_BACKUP_DIR" ]; then
    rmdir "$REJECTED_BACKUP_DIR" 2>/dev/null || true
  fi
}
if [ "$RESIGN" = "1" ] && [ -n "$REJECTED_ENVELOPE" ] && [ -f "$REJECTED_ENVELOPE" ]; then
  REJECTED_BACKUP_DIR=$(mktemp -d)
  REJECTED_BACKUP="$REJECTED_BACKUP_DIR/rejected-envelope"
  mv -f "$REJECTED_ENVELOPE" "$REJECTED_BACKUP"
fi

if [ -n "${AI_SDLC_SIGN_ATTESTATION_CMD:-}" ]; then
  # Test override (gated above). Callers pass multi-word commands such as
  # "node /tmp/stub.mjs", so the string must be split into argv SOMEWHERE --
  # but do it explicitly into an array rather than by leaving the expansion
  # unquoted. `read -r -a` splits once, on IFS, under our control; every later
  # expansion is quoted, so nothing is re-split or glob-expanded.
  read -r -a _AI_SDLC_SIGN_CMD <<< "$AI_SDLC_SIGN_ATTESTATION_CMD"
  if [ ${#_AI_SDLC_SIGN_CMD[@]} -eq 0 ]; then
    echo "[attestation-sign] ERROR: AI_SDLC_SIGN_ATTESTATION_CMD is set but empty" >&2
    restore_rejected_envelope
    exit 2
  fi
  if ! "${_AI_SDLC_SIGN_CMD[@]}" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE" \
      --schema-version "$SCHEMA_VERSION" \
      ${HARNESS_ARGS[@]+"${HARNESS_ARGS[@]}"}; then
    echo "[attestation-sign] ERROR: signer invocation (override) failed; aborting push" >&2
    restore_rejected_envelope
    exit 2
  fi
else
  if ! node "$WT_ROOT/ai-sdlc-plugin/scripts/sign-attestation.mjs" \
      --review-verdicts "$VERDICT_FILE" \
      --iteration-count "$ITERATION_COUNT" \
      --harness-note "$HARNESS_NOTE" \
      --schema-version "$SCHEMA_VERSION" \
      ${HARNESS_ARGS[@]+"${HARNESS_ARGS[@]}"}; then
    echo "[attestation-sign] ERROR: sign-attestation.mjs failed; aborting push" >&2
    echo "[attestation-sign]        (run \`pnpm --filter @ai-sdlc/orchestrator build\` if dist is missing)" >&2
    restore_rejected_envelope
    exit 2
  fi
fi

# Confirm the signer wrote what we expected before we try to commit it.
# AISDLC-398: check primary (patch-id) file; fall back to legacy (SHA) file.
if [ ! -f "$ATT_FILE" ] && { [ -z "$ATT_FILE_LEGACY" ] || [ ! -f "$ATT_FILE_LEGACY" ]; }; then
  echo "[attestation-sign] ERROR: signer did not produce $ATT_FILE; aborting push" >&2
  restore_rejected_envelope
  exit 2
fi
# Signing succeeded: the rejected envelope's backup is no longer needed.
if [ -n "$REJECTED_BACKUP" ] && [ -f "$REJECTED_BACKUP" ]; then
  rm -f "$REJECTED_BACKUP"
fi
if [ -n "$REJECTED_BACKUP_DIR" ] && [ -d "$REJECTED_BACKUP_DIR" ]; then
  rmdir "$REJECTED_BACKUP_DIR" 2>/dev/null || true
fi

# ── Step 6: stage + commit the chore ─────────────────────────────────
# We commit ONLY the new attestation file(s), not the whole `.ai-sdlc/` tree,
# so concurrent uncommitted edits in the worktree don't get swept in.
# `--no-verify` here skips re-entering pre-commit (lint-staged has nothing
# to do with a generated JSON envelope). It does NOT skip the next pre-push
# invocation — the operator's re-`git push` will trigger pre-push again,
# at which point the idempotent check at Step 4 sees the file and exits 0.
#
# AISDLC-475 Fix B: the signer no longer writes the per-SHA bridge
# (<headSha>.v6.dsse.json) when a patch-id is available. Stage only the
# primary (patch-id) file. ATT_FILE_LEGACY is set to "" when PATCH_ID is
# available, so the legacy stage block below is a no-op in that case.
#
# AISDLC-471: also stage the per-patch-id transcript-leaves directory so the
# per-patch-id leaves file travels with the envelope. Without this, CI checks
# out the branch tree, finds the envelope but not the leaves file, falls back
# to the legacy shared .ai-sdlc/transcript-leaves.jsonl (which has leaves from
# OTHER PRs), computes the wrong Merkle root, and fails with
# "v6: rootSignature did not match any trusted reviewer pubkey".
# The `[ -d ]` guard around the `git add` below (Step 6) is MANDATORY, not
# merely defensive: this script runs under `set -euo pipefail`, and `git add`
# on a non-existent path exits 128 (fatal: pathspec did not match), which would
# abort the push. The guard ensures we only `git add` the directory when it
# actually exists; callers that have not emitted per-patch-id leaves simply
# skip the stage and commit only the envelope.
(
  cd "$WT_ROOT"
  # Always stage the primary file (patch-id or SHA, whichever was produced)
  if [ -f "$ATT_FILE" ]; then
    git add -- "$ATT_FILE"
  fi
  # Also stage the legacy file if it was written and differs from primary
  if [ -n "$ATT_FILE_LEGACY" ] && [ -f "$ATT_FILE_LEGACY" ] && [ "$ATT_FILE_LEGACY" != "$ATT_FILE" ]; then
    git add -- "$ATT_FILE_LEGACY"
  fi
  # AISDLC-471: stage per-patch-id transcript-leaves alongside the envelope.
  # The `[ -d ]` guard is REQUIRED: under `set -euo pipefail`, running
  # `git add .ai-sdlc/transcript-leaves/` when the directory does not exist
  # exits 128 (`fatal: pathspec '...' did not match any files`) and aborts the
  # push. The guard makes the stage conditional on the directory existing, so
  # callers that have not yet emitted per-patch-id leaves are backward-compat:
  # they skip this stage and still just commit the envelope.
  if [ -d "$WT_ROOT/.ai-sdlc/transcript-leaves" ]; then
    git add -- "$WT_ROOT/.ai-sdlc/transcript-leaves/"
  fi
  git commit --no-verify -m "chore: auto-sign attestation for $TASK_ID (AISDLC-133)

Auto-generated by .husky/pre-push (scripts/check-attestation-sign.sh).
Reviewers' verdicts at .ai-sdlc/verdicts/$TASK_ID_LOWER.json.
AISDLC-398: primary filename content-addressed via git patch-id.
AISDLC-471: per-patch-id transcript-leaves committed alongside envelope.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" >&2
) || {
  echo "[attestation-sign] ERROR: git add/commit of attestation failed; aborting push" >&2
  exit 2
}

# AISDLC-694: after a re-sign, run the same verifier against the NEW HEAD. If it
# still rejects the fresh envelope, fail now instead of handing the operator a
# push that CI will reject (and instead of re-signing on every later push).
if [ "$RESIGN" = "1" ]; then
  RESIGNED_HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
  run_attestation_verifier "$RESIGNED_HEAD_SHA" "$MERGE_BASE"
  if [ "$VERIFY_STATUS" != "valid" ]; then
    echo "[attestation-sign] ERROR: the re-signed envelope is still rejected by" >&2
    echo "[attestation-sign]   scripts/verify-attestation.mjs (status=$VERIFY_STATUS: $VERIFY_REASON)." >&2
    echo "[attestation-sign]   A re-sign chore commit was added at $RESIGNED_HEAD_SHA; aborting push." >&2
    exit 2
  fi
fi

# ── Step 7: re-push required (or orchestrator mode) ──────────────────
# When AI_SDLC_INTERNAL_NO_EXIT_1=1 is set, the pre-push-fixups.sh
# orchestrator (AISDLC-386) is managing the exit-1 cycle itself. It invokes
# all mechanical fixup sub-hooks in one pass and emits a single consolidated
# "re-run git push" message after all of them have run. In that mode the
# sub-hook must exit 0 after doing its work so the orchestrator can continue
# to the next sub-hook. Standalone invocations retain exit-1 for backward compat.
if [ "${AI_SDLC_INTERNAL_NO_EXIT_1:-0}" = "1" ]; then
  if [ "$RESIGN" = "1" ]; then
    echo "[attestation-sign] Re-signed: the previous envelope was rejected by the verifier ($VERIFY_REJECTION_REASON)." >&2
  fi
  echo "[attestation-sign] fixup done (orchestrator mode — suppressing exit-1)" >&2
  exit 0
fi

if [ "$RESIGN" = "1" ]; then
  echo "[attestation-sign] Re-signed: the previous envelope was rejected by the verifier ($VERIFY_REJECTION_REASON)." >&2
fi

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
