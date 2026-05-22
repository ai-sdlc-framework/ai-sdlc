#!/usr/bin/env bash
# Drop codecov/patch from required branch-protection status checks on main.
#
# Background (AISDLC-372): codecov/patch is a third-party SaaS required check
# that adds 5-15 min latency per PR and occasionally deadlocks PRs entirely when
# no LCOV data is produced (pure-docs or workflow-only changesets). The local
# pre-push gate (scripts/check-coverage.sh, 80% lines threshold) is faster,
# runs entirely on our infrastructure, and blocks pushes before a PR is even
# opened — making it the authoritative coverage gate.
#
# This script preserves the other three required contexts and removes
# codecov/patch from the list. Codecov remains configured in CI
# (codecov/codecov-action@v5) for informational PR comments and the
# codecov.io dashboard, but no longer gates merges.
#
# Requires: gh CLI authenticated with a token that has admin:repo scope on
# ai-sdlc-framework/ai-sdlc (standard GITHUB_TOKEN in CI does not have admin
# scope; operator must run this locally after the PR merges).
#
# Usage:
#   bash scripts/apply-codecov-drop.sh
#
# Dry-run (prints the command without executing):
#   DRY_RUN=1 bash scripts/apply-codecov-drop.sh
#
# Verify the result:
#   gh api repos/ai-sdlc-framework/ai-sdlc/branches/main/protection/required_status_checks

set -euo pipefail

REPO="ai-sdlc-framework/ai-sdlc"
BRANCH="main"

CMD=(
  gh api -X PATCH
  "repos/${REPO}/branches/${BRANCH}/protection/required_status_checks"
  -F "contexts[]=Backlog Drift"
  -F "contexts[]=ai-sdlc/pr-ready"
  -F "strict=true"
)

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "[apply-codecov-drop] DRY RUN — would execute:"
  echo "  ${CMD[*]}"
  echo ""
  echo "[apply-codecov-drop] Resulting required contexts:"
  echo "  - Backlog Drift"
  echo "  - ai-sdlc/pr-ready"
  echo "  (codecov/patch removed; ai-sdlc/attestation NOT required per AISDLC-388 — conditional contributor to ai-sdlc/pr-ready)"
  exit 0
fi

echo "[apply-codecov-drop] Patching required_status_checks on ${REPO}/${BRANCH}..."
echo "[apply-codecov-drop] New contexts: Backlog Drift, ai-sdlc/pr-ready"
echo "[apply-codecov-drop] Dropped: codecov/patch (ai-sdlc/attestation also non-required per AISDLC-388)"
echo ""

"${CMD[@]}"

echo ""
echo "[apply-codecov-drop] Done. Verify with:"
echo "  gh api repos/${REPO}/branches/${BRANCH}/protection/required_status_checks | jq '.contexts'"
