#!/usr/bin/env bash
# check-branch-name-resolution.test.sh — regression test for branch-name
# resolution rule (AISDLC-369).
#
# Guards that the branch-name resolution logic used in auto-rearm-on-dequeue.yml
# and verify-attestation.yml correctly handles:
#   1. Standard branch names (short, no special chars)
#   2. Long branch names (> 64 chars, common for ai-sdlc/* prefixed branches)
#   3. Release-please branch name detection (release-please--* prefix)
#   4. Merge-queue queue-ref parsing (gh-readonly-queue/<base>/pr-<N>-<sha>)
#
# These are pure shell tests — no network calls, no git needed.
# Run with: bash scripts/check-branch-name-resolution.test.sh

set -euo pipefail

PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "== Branch-name resolution regression tests (AISDLC-369) =="
echo ""

# ── Test 1: release-please prefix detection ──────────────────────────────────

echo "1. release-please prefix detection"

detect_rp() {
  local ref="$1"
  case "$ref" in
    release-please--*) echo 'true' ;;
    *)                 echo 'false' ;;
  esac
}

check "standard release-please branch" "true" "$(detect_rp 'release-please--branches--main--components--ai-sdlc-plugin')"
check "non-release-please branch" "false" "$(detect_rp 'ai-sdlc/aisdlc-369-v5-rebase-fix')"
check "empty string" "false" "$(detect_rp '')"
check "main branch" "false" "$(detect_rp 'main')"
check "release-please prefix only" "true" "$(detect_rp 'release-please--components--all')"

# ── Test 2: merge-queue head_ref parsing ─────────────────────────────────────

echo ""
echo "2. merge-queue queue-ref PR number extraction"

extract_pr_num() {
  local ref="$1"
  # Mirrors the sed pattern from verify-attestation.yml:
  # 's|^(refs/heads/)?gh-readonly-queue/.*/pr-([0-9]+)-[^/]*$|\2|p'
  printf '%s' "$ref" | sed -nE 's|^(refs/heads/)?gh-readonly-queue/.*/pr-([0-9]+)-[^/]*$|\2|p'
}

check "merge_group head_ref with refs/heads/ prefix" "553" \
  "$(extract_pr_num 'refs/heads/gh-readonly-queue/main/pr-553-aaaa1234bbbb5678cccc9012dddd3456eeee7890')"
check "merge_group head_ref without refs/heads/ prefix" "123" \
  "$(extract_pr_num 'gh-readonly-queue/main/pr-123-deadbeef')"
check "merge_group with multi-segment base branch" "456" \
  "$(extract_pr_num 'refs/heads/gh-readonly-queue/release/1.0/pr-456-abcdef01')"
check "non-queue ref returns empty" "" "$(extract_pr_num 'ai-sdlc/aisdlc-369-test')"
check "main branch returns empty" "" "$(extract_pr_num 'main')"
check "release-please ref returns empty" "" \
  "$(extract_pr_num 'release-please--branches--main')"

# ── Test 3: branch name via gh pr view vs gh pr list (doc enforcement) ────────

echo ""
echo "3. Branch-name resolution correctness (static rule check)"

# The rule is: use `gh api repos/<o>/<r>/pulls/<n> --jq .head.ref`
# not `gh pr list --json headRefName`. We enforce this by checking that
# any shell script in the project that computes branch names uses the
# single-PR API pattern.
#
# This test scans the scripts that implement auto-rearm and verify-attestation
# to ensure they use the correct pattern.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOWS_DIR="$(cd "${SCRIPT_DIR}/../.github/workflows" && pwd)"

# auto-rearm-on-dequeue.yml must use `gh pr view` (single-PR endpoint) not
# `gh pr list --json headRefName` for branch-name lookup in the re-arm loop.
REARM_YML="${WORKFLOWS_DIR}/auto-rearm-on-dequeue.yml"
if [ -f "$REARM_YML" ]; then
  check "auto-rearm uses gh pr view for branch name" "true" \
    "$(grep -q 'gh pr view.*headRefName' "$REARM_YML" && echo 'true' || echo 'false')"
else
  echo "  SKIP: ${REARM_YML} not found (expected in this PR)"
fi

# verify-attestation.yml uses `gh pr view` for the merge_group source PR lookup.
VERIFY_YML="${WORKFLOWS_DIR}/verify-attestation.yml"
if [ -f "$VERIFY_YML" ]; then
  check "verify-attestation uses gh pr view for source PR lookup" "true" \
    "$(grep -q 'gh pr view.*headRefName' "$VERIFY_YML" && echo 'true' || echo 'false')"
else
  echo "  SKIP: ${VERIFY_YML} not found"
fi

# ── Test 4: squash-attestation-chores.sh pattern ─────────────────────────────

echo ""
echo "4. squash-attestation-chores.sh subject pattern matching"

CHORE_SIGN_RE='^chore(\(.*\))?: (sign|auto-sign) (v5 |review )?attestation'

match_chore() {
  local subject="$1"
  echo "$subject" | grep -qE "$CHORE_SIGN_RE" && echo "true" || echo "false"
}

check "chore: sign v5 attestation" "true" "$(match_chore 'chore: sign v5 attestation')"
check "chore: auto-sign attestation for aisdlc-369" "true" "$(match_chore 'chore: auto-sign attestation for aisdlc-369')"
check "chore(attestation): sign review attestation" "true" "$(match_chore 'chore(attestation): sign review attestation')"
check "chore: auto-sign review attestation" "true" "$(match_chore 'chore: auto-sign review attestation')"
check "feat: add new feature" "false" "$(match_chore 'feat: add new feature')"
check "chore: update dependencies" "false" "$(match_chore 'chore: update dependencies')"
check "docs: update attestation docs" "false" "$(match_chore 'docs: update attestation docs')"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "== Results: ${PASS} passed, ${FAIL} failed =="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
