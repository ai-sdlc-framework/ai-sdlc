#!/usr/bin/env bash
# sync-branch-protection.sh — idempotent script to apply branch protection rules
# for the no-queue direct-merge model (AISDLC-400).
#
# What this does:
#   - Sets required status checks on `main` to: [ai-sdlc/pr-ready]
#   - Enforces strict mode (branch must be up to date before merging)
#   - Removes the "Require merge queue" setting (by not including it in the PATCH)
#
# Note: this script only manages required_status_checks. Other branch protection
# settings (require PR reviews, dismiss stale reviews, require signed commits,
# etc.) are NOT touched — they stay as-is.
#
# Note on merge method settings: the repo-level "Allow only squash merges" toggle
# is in Settings → General → Pull requests and requires a separate API call to
# PATCH /repos/{owner}/{repo}. This script focuses on branch protection because
# that's what gates merge (required checks). For the repo-level settings, use
# the GitHub UI or see the comment at the bottom of this script.
#
# Usage:
#   bash scripts/sync-branch-protection.sh
#   bash scripts/sync-branch-protection.sh --dry-run
#
# Requirements:
#   - `gh` CLI authenticated with admin scope on the repo
#   - `jq` installed
#
# Idempotency: safe to re-run — PATCH is idempotent on the required_status_checks
# endpoint (always overwrites to exactly the specified list).
#
# Rollback: to re-enable the merge queue, go to
#   Settings → Branches → Edit rule for `main` → enable "Require merge queue"
# No code revert needed. See docs/operations/merge-without-queue.md.

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────────
BRANCH="main"
REQUIRED_CONTEXTS=(
  "ai-sdlc/pr-ready"
)
STRICT=true  # require branch to be up-to-date before merging

# ── Parse args ──────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: bash scripts/sync-branch-protection.sh [--dry-run]"
      echo ""
      echo "Applies branch protection required-status-checks for the no-queue"
      echo "direct-merge model (AISDLC-400). Idempotent — safe to re-run."
      echo ""
      echo "  --dry-run   Print the API call that would be made, but don't execute it."
      exit 0
      ;;
  esac
done

# ── Resolve repo ─────────────────────────────────────────────────────────────
if ! REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null); then
  echo "ERROR: could not resolve repo from 'gh repo view'. Are you in the right directory?" >&2
  echo "       Run: gh auth status" >&2
  exit 1
fi
echo "[sync-branch-protection] repo: $REPO  branch: $BRANCH"

# ── Admin permission check ────────────────────────────────────────────────────
VIEWER_PERMISSION=$(gh api "repos/${REPO}" --jq '.permissions.admin' 2>/dev/null || echo "false")
if [ "$VIEWER_PERMISSION" != "true" ]; then
  echo "ERROR: you do not have admin permission on $REPO." >&2
  echo "       Branch protection changes require admin scope." >&2
  echo "       If you're using a fine-grained PAT, ensure it has 'administration: write'." >&2
  exit 1
fi
echo "[sync-branch-protection] admin permission: confirmed"

# ── Build contexts JSON array ────────────────────────────────────────────────
CONTEXTS_JSON=$(printf '%s\n' "${REQUIRED_CONTEXTS[@]}" | jq -R . | jq -sc .)
echo "[sync-branch-protection] required contexts: ${REQUIRED_CONTEXTS[*]}"
echo "[sync-branch-protection] strict mode: $STRICT"

# ── Dry run ──────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "true" ]; then
  echo ""
  echo "[sync-branch-protection] DRY RUN — would execute:"
  echo "  gh api -X PATCH \"repos/${REPO}/branches/${BRANCH}/protection/required_status_checks\" \\"
  echo "    --input <(jq -n --argjson ctx '${CONTEXTS_JSON}' --argjson strict '${STRICT}' \\"
  echo "      '{strict: \$strict, contexts: \$ctx}')"
  echo ""
  echo "[sync-branch-protection] Equivalent UI action:"
  echo "  Settings → Branches → Edit rule for '${BRANCH}'"
  echo "  → Required status checks: ${REQUIRED_CONTEXTS[*]}"
  echo "  → Require branches to be up to date before merging: ${STRICT}"
  echo "  → Require merge queue: DISABLED"
  exit 0
fi

# ── Apply ────────────────────────────────────────────────────────────────────
echo "[sync-branch-protection] applying required_status_checks PATCH..."
RESULT=$(gh api \
  -X PATCH \
  "repos/${REPO}/branches/${BRANCH}/protection/required_status_checks" \
  --input <(jq -n \
    --argjson ctx "${CONTEXTS_JSON}" \
    --argjson strict "${STRICT}" \
    '{strict: $strict, contexts: $ctx}') \
  2>&1) || {
  echo "ERROR: PATCH failed:" >&2
  echo "$RESULT" >&2
  exit 1
}

echo "[sync-branch-protection] SUCCESS — required_status_checks updated:"
echo "$RESULT" | jq '{strict: .strict, contexts: .contexts}' 2>/dev/null || echo "$RESULT"

# ── Post-apply reminder ───────────────────────────────────────────────────────
echo ""
echo "┌──────────────────────────────────────────────────────────────────────────┐"
echo "│  OPERATOR ACTION REQUIRED — repo-level merge settings (UI only)         │"
echo "│                                                                          │"
echo "│  Settings → General → Pull requests:                                    │"
echo "│    ☑ Allow squash merging          (set as default)                     │"
echo "│    ☐ Allow merge commits           (DISABLE)                             │"
echo "│    ☐ Allow rebase merging          (DISABLE)                             │"
echo "│                                                                          │"
echo "│  Settings → Branches → Edit rule for 'main':                            │"
echo "│    ☐ Require merge queue           (DISABLE if currently enabled)        │"
echo "│                                                                          │"
echo "│  These settings cannot be applied via required_status_checks API.       │"
echo "│  See docs/operations/merge-without-queue.md for the full runbook.       │"
echo "└──────────────────────────────────────────────────────────────────────────┘"
