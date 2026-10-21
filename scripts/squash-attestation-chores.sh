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
#   5. (AISDLC-820) If an envelope changed in the run has a subject that is an
#      ancestor of HEAD, no-op: squashing could orphan it and loop the push.
#
# The squash is ONLY applied when ALL stacked commits match the chore-sign
# subject pattern — we never squash across a non-chore commit boundary.
# This prevents accidentally collapsing real dev work.
#
# Exit codes:
#   0 = no-op (nothing to squash) OR squash succeeded
#   1 = git error during squash

set -euo pipefail

# ── AISDLC-383.5: master bypass (emergency only) ────────────────────
if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[squash-attestation-chores] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

# Subject pattern for chore-sign commits.
CHORE_SIGN_RE='^(chore(\(.*\))?: (sign|auto-sign) (v5 |review )?attestation|chore: commit pending transcript leaves)'

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

# AISDLC-820: never rewrite a run whose envelope still binds to a commit that is
# an ancestor of HEAD. Squashing would rewrite the commits the envelope's subject
# may name, orphaning it; the signer would then re-sign and stack a new chore, and
# the next push would squash again (a loop that never converges on a rebased
# branch). Only an envelope whose subject is already orphaned (or absent) is
# squashed, because the signer must replace it anyway.
RUN_ENVELOPES=$(git diff --name-only "HEAD~${COUNT}" HEAD -- .ai-sdlc/attestations/ 2>/dev/null | grep -E '\.dsse\.json$' || true)
for ENV_PATH in $RUN_ENVELOPES; do
  SUBJECT_SHA=$(git show "HEAD:${ENV_PATH}" 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try {
        const e = JSON.parse(d);
        const s = e && e.subject && e.subject.digest && e.subject.digest.sha1;
        if (typeof s === "string") process.stdout.write(s);
      } catch {}
    });
  ' 2>/dev/null || true)
  if [ -n "$SUBJECT_SHA" ] && git merge-base --is-ancestor "$SUBJECT_SHA" HEAD 2>/dev/null; then
    echo "[squash-attestation-chores] envelope ${ENV_PATH##*/} still binds to ${SUBJECT_SHA:0:7} (an ancestor of HEAD) — leaving $COUNT chore-sign commits alone"
    exit 0
  fi
done

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
