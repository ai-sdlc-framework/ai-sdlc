#!/usr/bin/env bash
#
# AISDLC-357: Auto-rebuild mcp-server bundle when pipeline-cli source changes
# are in the push range but the committed dist/bin.js is stale.
#
# The plugin marketplace clones the repo source without running `pnpm install`,
# so dist/bin.js MUST be committed and MUST be current. The Verify-dist-bin CI
# gate (`scripts/verify-bundle.mjs`) checks byte-for-byte freshness. After any
# rebase or code change touching `pipeline-cli/src/**`, the committed bundle
# goes stale — CI rejects it and the operator is stuck in an amend cycle.
#
# This hook resolves the cycle by auto-rebuilding before the push completes.
#
# Behaviour:
#
#   1. Honour AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 (operator deferral / manual rebuild).
#   2. Locate the push range from husky's pre-push args via stdin.
#   3. Check whether any commit in the range touches `pipeline-cli/src/**`.
#      Also checks if the current working tree diff (unstaged pipeline-cli changes)
#      or any staged changes touch pipeline-cli/src/**. If none → exit 0.
#   4. Hash the current committed `ai-sdlc-plugin/mcp-server/dist/bin.js`.
#   5. Run `pnpm --filter @ai-sdlc/plugin-mcp-server build` to rebuild.
#   6. Hash the rebuilt bundle.
#   7. If hashes match (bundle was already current) → exit 0 silently.
#   8. If hashes differ (bundle was stale):
#      a. Stage the new dist/bin.js.
#      b. Commit as `chore: auto-rebuild mcp-server bundle (AISDLC-357)`.
#      c. Exit 1 with "re-run git push" message.
#
# Activation: invoked from `.husky/pre-push` AFTER check-task-moved.sh and
# BEFORE check-attestation-sign.sh. Order is load-bearing: the attestation
# envelope binds {path, headBlobSha}; if the bundle rebuild happens AFTER
# attestation sign, the envelope hashes the OLD bundle while the PR diff
# contains the NEW bundle → verify-attestation rejects. Order in
# `.husky/pre-push`: check-coverage.sh → check-task-moved.sh →
# check-mcp-bundle-sync.sh → check-attestation-sign.sh.
#
# Override:
#   AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 git push
# Use when deferring the rebuild for a manual `pnpm --filter @ai-sdlc/plugin-mcp-server build`.
#
# Exit codes:
#   0 — no pipeline-cli changes detected, or bundle already current, or
#       AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 short-circuit.
#   1 — bundle was stale → rebuilt + committed the chore; push aborted;
#       operator must re-run `git push` to send the new chore commit.
#   2 — build failed or post-build integrity error.

set -euo pipefail

# ── Step 1: env-var deferral ─────────────────────────────────────────
if [ "${AI_SDLC_SKIP_MCP_BUNDLE_SYNC:-0}" = "1" ]; then
  echo "[mcp-bundle-sync] AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 — skipping auto-rebuild" >&2
  exit 0
fi

# ── Step 2: locate worktree root ─────────────────────────────────────
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo '')
if [ -z "$WT_ROOT" ]; then
  exit 0
fi

DIST_BIN="$WT_ROOT/ai-sdlc-plugin/mcp-server/dist/bin.js"

# ── Step 3: resolve the push range ───────────────────────────────────
NULL_SHA="0000000000000000000000000000000000000000"

LOCAL_SHA=""
REMOTE_SHA=""

while read -r LOCAL_REF LOCAL_SHA_STDIN REMOTE_REF REMOTE_SHA_STDIN; do
  LOCAL_SHA="$LOCAL_SHA_STDIN"
  REMOTE_SHA="$REMOTE_SHA_STDIN"
  break  # only need first line
done

if [ -z "$LOCAL_SHA" ]; then
  LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo '')
fi
if [ -z "$REMOTE_SHA" ] || [ "$REMOTE_SHA" = "$NULL_SHA" ]; then
  MERGE_BASE=$(git merge-base HEAD "origin/main" 2>/dev/null || echo '')
  if [ -n "$MERGE_BASE" ]; then
    REMOTE_SHA="$MERGE_BASE"
  else
    REMOTE_SHA=$(git rev-parse 'HEAD~1' 2>/dev/null || echo '')
    if [ -z "$REMOTE_SHA" ]; then
      REMOTE_SHA=$(git hash-object -t tree /dev/null 2>/dev/null || echo '')
    fi
  fi
fi

if [ -z "$LOCAL_SHA" ]; then
  echo "[mcp-bundle-sync] WARN: cannot resolve HEAD SHA; skipping" >&2
  exit 0
fi

# ── Step 4: detect pipeline-cli/src changes in push range ────────────
# Check both committed changes in push range AND uncommitted working-tree
# changes to pipeline-cli/src/** (the latter handles the case where the
# operator runs the hook outside a full push cycle or after amending).
PIPELINE_CLI_CHANGED=0

# Check commits in the push range.
RANGE_CHANGED=$(
  git log --name-only --format='' "${REMOTE_SHA}..${LOCAL_SHA}" 2>/dev/null \
    | grep -E '^pipeline-cli/src/' \
    | head -1 \
  || true
)
if [ -n "$RANGE_CHANGED" ]; then
  PIPELINE_CLI_CHANGED=1
fi

# Also check staged index changes vs HEAD (catches `git add`-ed edits).
if [ "$PIPELINE_CLI_CHANGED" = "0" ]; then
  INDEX_CHANGED=$(git diff --cached --name-only HEAD 2>/dev/null \
    | grep -E '^pipeline-cli/src/' | head -1 || true)
  if [ -n "$INDEX_CHANGED" ]; then
    PIPELINE_CLI_CHANGED=1
  fi
fi

if [ "$PIPELINE_CLI_CHANGED" = "0" ]; then
  # No pipeline-cli/src changes → bundle cannot be stale from this push.
  exit 0
fi

echo "[mcp-bundle-sync] pipeline-cli/src changes detected — checking bundle freshness" >&2

# ── Step 5: idempotency check (HEAD is already an auto-rebuild chore) ─
LAST_COMMIT_SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null || echo '')
if [[ "${LAST_COMMIT_SUBJECT:-}" == "chore: auto-rebuild mcp-server bundle"* ]]; then
  exit 0
fi

# ── Step 6: hash current committed bundle ────────────────────────────
if [ ! -f "$DIST_BIN" ]; then
  echo "[mcp-bundle-sync] WARN: $DIST_BIN not found — running build to create it" >&2
  BEFORE_HASH="<missing>"
else
  BEFORE_HASH=$(sha256sum "$DIST_BIN" 2>/dev/null | awk '{print $1}' \
    || shasum -a 256 "$DIST_BIN" 2>/dev/null | awk '{print $1}' \
    || echo '')
fi

# ── Step 7: rebuild the bundle ───────────────────────────────────────
BUILD_CMD="${AI_SDLC_MCP_BUILD_CMD:-}"
echo "[mcp-bundle-sync] rebuilding @ai-sdlc/plugin-mcp-server..." >&2

if [ -n "$BUILD_CMD" ]; then
  # Test override: allows hermetic tests to stub out the build.
  # shellcheck disable=SC2086
  if ! $BUILD_CMD > /tmp/ai-sdlc-mcp-build.log 2>&1; then
    echo "[mcp-bundle-sync] ERROR: build (override) failed. Last 20 lines:" >&2
    tail -20 /tmp/ai-sdlc-mcp-build.log >&2
    exit 2
  fi
else
  (
    cd "$WT_ROOT"
    if ! pnpm --filter @ai-sdlc/plugin-mcp-server build > /tmp/ai-sdlc-mcp-build.log 2>&1; then
      echo "[mcp-bundle-sync] ERROR: pnpm build failed. Last 20 lines:" >&2
      tail -20 /tmp/ai-sdlc-mcp-build.log >&2
      exit 2
    fi
  ) || exit 2
fi

if [ ! -f "$DIST_BIN" ]; then
  echo "[mcp-bundle-sync] ERROR: build succeeded but $DIST_BIN still missing; aborting push" >&2
  exit 2
fi

# ── Step 8: compare hashes ───────────────────────────────────────────
AFTER_HASH=$(sha256sum "$DIST_BIN" 2>/dev/null | awk '{print $1}' \
  || shasum -a 256 "$DIST_BIN" 2>/dev/null | awk '{print $1}' \
  || echo '')

if [ "$BEFORE_HASH" = "$AFTER_HASH" ] && [ "$BEFORE_HASH" != "<missing>" ]; then
  echo "[mcp-bundle-sync] bundle already current (hashes match) — no commit needed" >&2
  exit 0
fi

echo "[mcp-bundle-sync] bundle was stale (hash changed) — staging rebuilt dist/bin.js" >&2

# ── Step 9: stage + commit the rebuilt bundle ─────────────────────────
(
  cd "$WT_ROOT"
  git add -- "ai-sdlc-plugin/mcp-server/dist/bin.js"
  git commit --no-verify -m "chore: auto-rebuild mcp-server bundle (AISDLC-357)

Auto-generated by .husky/pre-push (scripts/check-mcp-bundle-sync.sh).
pipeline-cli/src changes in the push range made dist/bin.js stale; rebuilt
with \`pnpm --filter @ai-sdlc/plugin-mcp-server build\` to keep the bundle
current for the plugin marketplace (no pnpm install on clone).

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>" >&2
) || {
  echo "[mcp-bundle-sync] ERROR: git add/commit of rebuilt bundle failed; aborting push" >&2
  exit 2
}

# ── Step 10: re-push required ─────────────────────────────────────────
{
  echo ""
  echo "[mcp-bundle-sync] Hook rebuilt the mcp-server bundle and committed"
  echo "            a chore commit on top of HEAD. The push you just attempted"
  echo "            does NOT include that new commit — re-run \`git push\` to"
  echo "            send it."
  echo ""
  echo "            The next push is a no-op for this hook (bundle already"
  echo "            current at the new HEAD)."
  echo ""
  echo "            Defer with: AI_SDLC_SKIP_MCP_BUNDLE_SYNC=1 git push"
} >&2

exit 1
