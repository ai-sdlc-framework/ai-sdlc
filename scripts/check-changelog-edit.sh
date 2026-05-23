#!/usr/bin/env bash
# check-changelog-edit.sh — WARN when a regular feature branch has CHANGELOG.md
# changes in the push range. CHANGELOG.md is managed exclusively by release-please;
# manual edits generate rebase conflicts on every parallel PR that lands.
#
# The script reads the push range from stdin (the format git passes to pre-push
# hooks: "<local-ref> <local-sha> <remote-ref> <remote-sha>") and diffs
# each commit range against HEAD to detect CHANGELOG.md touches.
#
# Behaviour:
#   - On a release-please branch (branch name starts with
#     "release-please--branches--") → exits 0 silently (those edits are fine).
#   - On any other branch where CHANGELOG.md appears in `git diff --name-only
#     <remote-sha>..HEAD` → prints a WARN message to stderr and exits 0.
#     (This is a warning, not a block — the operator may knowingly edit it.)
#   - When no CHANGELOG.md changes are found → exits 0 silently.
#
# Wire this into .husky/pre-push BEFORE the attestation-sign step.
# Skip with: AI_SDLC_SKIP_CHANGELOG_CHECK=1
#
# AISDLC-401

set -euo pipefail

if [ "${AI_SDLC_BYPASS_ALL_GATES:-}" = "1" ]; then
  echo "[check-changelog-edit] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

if [ "${AI_SDLC_SKIP_CHANGELOG_CHECK:-}" = "1" ]; then
  echo "[check-changelog-edit] AI_SDLC_SKIP_CHANGELOG_CHECK=1 — skipping" >&2
  exit 0
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

# Release-please branch — edits are expected and correct.
if [[ "$CURRENT_BRANCH" == release-please--branches--* ]]; then
  exit 0
fi

# Read push range from stdin (git pre-push format).
PUSH_STDIN="$(cat || true)"

FOUND_CHANGELOG=0

while IFS=' ' read -r _local_ref local_sha _remote_ref remote_sha; do
  # Skip delete-branch pushes (local_sha is all zeros).
  if [[ "$local_sha" == "0000000000000000000000000000000000000000" ]]; then
    continue
  fi

  # When pushing a brand-new branch (remote_sha is all zeros), diff against
  # the merge-base with origin/main as the base.
  if [[ "$remote_sha" == "0000000000000000000000000000000000000000" ]]; then
    base_sha="$(git merge-base HEAD origin/main 2>/dev/null || true)"
    if [ -z "$base_sha" ]; then
      continue
    fi
  else
    base_sha="$remote_sha"
  fi

  # Check if any CHANGELOG.md file appears in the range.
  if git diff --name-only "$base_sha".."$local_sha" 2>/dev/null | grep -q "CHANGELOG\.md"; then
    FOUND_CHANGELOG=1
    break
  fi
done <<< "$PUSH_STDIN"

if [ "$FOUND_CHANGELOG" = "1" ]; then
  cat >&2 <<'WARN'
[check-changelog-edit] WARNING: This branch modifies CHANGELOG.md.
  CHANGELOG.md is maintained automatically by release-please.
  Manual edits to CHANGELOG.md on feature branches cause rebase conflicts
  when parallel PRs land (AISDLC-401 / AISDLC-400 root cause).

  Recommended action:
    - Remove the CHANGELOG.md changes from this branch.
    - release-please will capture the conventional-commit entries from your
      commit messages and add them to CHANGELOG.md in the rolling release PR.
    - See docs/operations/release-flow.md for the full release flow.

  To suppress this warning for a deliberate edit:
    AI_SDLC_SKIP_CHANGELOG_CHECK=1 git push
WARN
fi

exit 0
