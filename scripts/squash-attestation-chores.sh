#!/usr/bin/env bash
# squash-attestation-chores.sh — squash stacked chore-sign commits (AISDLC-369).
#
# When an operator re-signs multiple times (rebase + sign + push + dequeued +
# sign again + push), stacked "chore: sign v5 attestation" commits accumulate
# on the branch. This clutters the history and makes `git log --oneline`
# noisy. This helper squashes consecutive chore-sign commits at the top of the
# branch into a single commit, keeping one clean signing record.
#
# Invoked:
#   a) Manually: bash scripts/squash-attestation-chores.sh
#   b) From .husky/pre-push (defensively, idempotent)
#
# Algorithm:
#   1. Walk HEAD backwards (up to MAX_DEPTH commits).
#   2. Collect the longest run of consecutive "chore: sign" commits at HEAD.
#   3. If the run has >= 2 commits: reset --soft to the commit before the run,
#      then recommit with the message of the most-recent chore commit.
#   4. If 0 or 1 consecutive chore commits at HEAD: no-op (exit 0).
#
# The squash is ONLY applied when ALL stacked commits match the chore-sign
# subject pattern — we never squash across a non-chore commit boundary.
# This prevents accidentally collapsing real dev work.
#
# Exit codes:
#   0 = no-op (nothing to squash) OR squash succeeded
#   1 = git error during squash

set -euo pipefail

# Subject pattern for chore-sign commits.
CHORE_SIGN_RE='^chore(\(.*\))?: (sign|auto-sign) (v5 |review )?attestation'

# Maximum depth to inspect (prevents O(N) log scan on large branches).
MAX_DEPTH=${AI_SDLC_SQUASH_MAX_DEPTH:-20}

# Collect the commit subjects for the top MAX_DEPTH commits.
SUBJECTS=$(git log --format='%s' -n "$MAX_DEPTH" HEAD 2>/dev/null || echo "")

if [ -z "$SUBJECTS" ]; then
  echo "[squash-attestation-chores] no commits found; skipping"
  exit 0
fi

# Count consecutive chore-sign commits at HEAD (topmost first).
COUNT=0
while IFS= read -r subject; do
  if echo "$subject" | grep -qE "$CHORE_SIGN_RE"; then
    COUNT=$((COUNT + 1))
  else
    break
  fi
done <<< "$SUBJECTS"

if [ "$COUNT" -lt 2 ]; then
  # 0 or 1 chore-sign commit at HEAD — nothing to squash.
  exit 0
fi

echo "[squash-attestation-chores] found $COUNT consecutive chore-sign commits at HEAD — squashing to 1"

# The message we'll use for the squashed commit: the topmost (most-recent) one.
SQUASH_MSG=$(git log --format='%s' -1 HEAD)

# Reset soft to the commit BEFORE the run (HEAD~COUNT).
if ! git reset --soft "HEAD~${COUNT}"; then
  echo "[squash-attestation-chores] ERROR: git reset --soft HEAD~${COUNT} failed" >&2
  exit 1
fi

# Recommit with the saved message.
if ! git commit -q -m "${SQUASH_MSG}"; then
  echo "[squash-attestation-chores] ERROR: git commit failed after reset" >&2
  exit 1
fi

echo "[squash-attestation-chores] squashed $COUNT chore-sign commits into 1: '${SQUASH_MSG}'"
exit 0
