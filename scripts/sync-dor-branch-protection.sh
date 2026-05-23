#!/usr/bin/env bash
#
# scripts/sync-dor-branch-protection.sh — AISDLC-379 helper.
#
# Adds `Evaluate backlog tasks changed by PR` (the DoR ingress check) to the
# required-status-checks list on `main`. Reproducible so branch protection
# can be re-applied after a recreate.
#
# Usage:
#   scripts/sync-dor-branch-protection.sh [--repo <owner/repo>] [--dry-run]
#
# Defaults to `ai-sdlc-framework/ai-sdlc`. Requires `gh` authenticated as a
# user with admin permission on the target repo.
#
# Why this lives as a script (not a one-shot `gh api` invocation in the PR
# body): branch protection is a moving target — the AISDLC-388 cutover
# changed which contexts are required, and the next change will too.
# Centralising the canonical list here means future cutovers update one
# file instead of grepping commit history for the last `gh api` snippet
# someone pasted. The list itself is defined inline at the top of the
# script so a `git blame` reveals when each context was added.
#
# The script is intentionally idempotent: re-running it sets the same
# contexts (PATCH replaces the full list, not appends). If you want to
# REMOVE a context, delete its line from REQUIRED_CONTEXTS below and
# re-run.

set -euo pipefail

REPO="ai-sdlc-framework/ai-sdlc"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[sync-dor-branch-protection] unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Canonical required-status-checks list for `main`.
#
# Keep ordered: a contributor scanning the file should be able to read it
# top-down and reason about why each one is required.
#
#   1. Backlog Drift                          — references resolve (AISDLC-125)
#   2. ai-sdlc/pr-ready                       — single rollup (AISDLC-388)
#   3. ai-sdlc/attestation                    — attestation envelope present
#   4. Evaluate backlog tasks changed by PR   — DoR ingress gate (AISDLC-379, this PR)
REQUIRED_CONTEXTS=(
  "Backlog Drift"
  "ai-sdlc/pr-ready"
  "ai-sdlc/attestation"
  "Evaluate backlog tasks changed by PR"
)

ARGS=(api -X PATCH "repos/${REPO}/branches/main/protection/required_status_checks"
      -F "strict=true")
for ctx in "${REQUIRED_CONTEXTS[@]}"; do
  ARGS+=(-F "contexts[]=${ctx}")
done

if [[ $DRY_RUN -eq 1 ]]; then
  printf '[sync-dor-branch-protection] dry-run — would invoke:\n  gh'
  for a in "${ARGS[@]}"; do printf ' %q' "$a"; done
  printf '\n'
  exit 0
fi

echo "[sync-dor-branch-protection] patching branch protection on ${REPO}/main"
echo "[sync-dor-branch-protection] required contexts:"
for ctx in "${REQUIRED_CONTEXTS[@]}"; do
  echo "  - ${ctx}"
done

gh "${ARGS[@]}" >/dev/null
echo "[sync-dor-branch-protection] done."
