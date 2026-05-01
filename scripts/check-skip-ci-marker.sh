#!/usr/bin/env bash
#
# AISDLC-88: Block pushes that contain CI-skip magic tokens in commit
# messages so a stray `[skip ci]` (or one of its synonyms) cannot
# silently disable GitHub Actions on the resulting PR.
#
# Why this exists: GitHub Actions parses commit messages for five literal
# magic tokens — `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`,
# and `[actions skip]` — and SUPPRESSES every workflow on commits that
# carry any of them. Half the AI-SDLC governance rails (verify-attestation,
# ai-sdlc-review) are workflow-driven, so a leaked token disables review
# attestation verification, the duplicate-review safety net, and the
# CI-side attestor's PR-status posting in one stroke.
#
# AISDLC-87's CI-side attestor uses `[skip ci]` ON PURPOSE in its chore
# commit (`chore(ci): sign review attestation [skip ci]`) to avoid the
# review-loop — that one commit is the documented exception, gated by
# author identity (`github-actions[bot]`) AND subject prefix
# (`chore(ci): sign review attestation`). Every other commit must be
# clean.
#
# Activation: invoked from `.husky/pre-push`. Operator must wire it
# into the husky hook (the agent that authors AISDLC-88 cannot edit
# `.husky/` directly under sandbox in the general case; this worktree
# is the exception). Wiring snippet:
#
#   ./scripts/check-skip-ci-marker.sh
#
# Override: `AI_SDLC_SKIP_MARKER_GATE=1 git push`. Use sparingly — the
# only legitimate use is intentional AISDLC-87-style bot-authored chore
# commits NOT yet caught by the bot-author exemption (e.g. a future
# CI-side mechanism that hasn't been added to the allowlist yet).
#
# Exit codes:
#   0 — every commit being pushed is clean (or only the documented
#       bot-authored chore-commit exception carried a token)
#   1 — at least one non-exempt commit body contains a magic token

set -euo pipefail

if [ "${AI_SDLC_SKIP_MARKER_GATE:-}" = "1" ]; then
  echo "[skip-ci-marker-gate] skipped (AI_SDLC_SKIP_MARKER_GATE=1)"
  exit 0
fi

# The five magic tokens GitHub Actions parses in commit messages.
# Source: https://docs.github.com/en/actions/managing-workflow-runs/skipping-workflow-runs
# We scan the LITERAL bracketed forms, case-insensitive (GitHub matches
# case-insensitively per the docs).
TOKENS_REGEX='\[skip ci\]|\[ci skip\]|\[no ci\]|\[skip actions\]|\[actions skip\]'

# Husky's pre-push hook reads `<local-ref> <local-sha> <remote-ref> <remote-sha>`
# tuples on stdin (one per ref being pushed). For each tuple we walk the
# commit range `remote-sha..local-sha` and inspect every commit body.
# When stdin is empty (e.g. ad-hoc invocation outside a real `git push`),
# fall back to scanning the last commit on HEAD so the script is testable
# in isolation.
ZERO_SHA='0000000000000000000000000000000000000000'

scan_commits() {
  local commits="$1"
  local found=0
  for sha in $commits; do
    [ -z "$sha" ] && continue
    # Author + subject + body. We match against the WHOLE commit message
    # (subject + body) because GitHub Actions does the same. Author is
    # used to apply the bot-exemption below.
    local author subject body full
    author=$(git log -1 --format='%an <%ae>' "$sha" 2>/dev/null || echo '')
    subject=$(git log -1 --format='%s' "$sha" 2>/dev/null || echo '')
    body=$(git log -1 --format='%B' "$sha" 2>/dev/null || echo '')
    full="$body"

    # Magic-token presence check.
    if ! echo "$full" | grep -Eqi "$TOKENS_REGEX"; then
      continue
    fi

    # Bot-author exemption (AISDLC-87 CI-side attestor):
    #   - Author is `github-actions[bot]` or its noreply email
    #   - Subject starts with `chore(ci): sign review attestation`
    # Both must hold; either alone is not enough.
    local is_bot_author=0
    case "$author" in
      *'github-actions[bot]'*|*'41898282+github-actions[bot]@users.noreply.github.com'*)
        is_bot_author=1
        ;;
    esac
    case "$subject" in
      'chore(ci): sign review attestation'*)
        if [ "$is_bot_author" = "1" ]; then
          # Documented exemption — quiet pass.
          continue
        fi
        ;;
    esac

    {
      echo ""
      echo "ERROR: commit $sha contains a CI-skip magic token (AISDLC-88)."
      echo ""
      echo "  Author:  $author"
      echo "  Subject: $subject"
      echo ""
      echo "  Offending tokens (one of):"
      echo "$full" | grep -Eoi "$TOKENS_REGEX" | sort -u | sed 's/^/    /'
      echo ""
      echo "  GitHub Actions parses these literal substrings and SUPPRESSES"
      echo "  every workflow on the commit. Half of the AI-SDLC governance"
      echo "  (verify-attestation, ai-sdlc-review) is workflow-driven — a"
      echo "  leaked token silently disables it."
      echo ""
      echo "  Fix: rewrite the commit body using the paren-quoted form, e.g."
      echo "       (skip ci marker) instead of [skip ci]. GitHub Actions matches"
      echo "       the literal substring '[skip ci]' (case-insensitive), so even"
      echo "       backtick-wrapping (\`[skip ci]\`) does NOT defeat the parser —"
      echo "       only the bracket-free form is safe. See AISDLC-88."
      echo ""
      echo "  Override (ONLY for documented CI-side bot commits not yet in"
      echo "  the exemption allowlist): AI_SDLC_SKIP_MARKER_GATE=1 git push"
    } >&2
    found=1
  done
  return $found
}

# Read pre-push tuples from stdin. If stdin is a TTY (no real push), fall
# back to scanning HEAD only.
fail=0
if [ -t 0 ]; then
  # Manual invocation — scan the most recent commit on HEAD.
  range=$(git rev-parse HEAD 2>/dev/null || echo '')
  if [ -n "$range" ]; then
    scan_commits "$range" || fail=1
  fi
else
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "${local_sha:-}" ] && continue
    # Branch deletion — local_sha is all zeros — nothing to scan.
    if [ "$local_sha" = "$ZERO_SHA" ]; then
      continue
    fi
    if [ "${remote_sha:-$ZERO_SHA}" = "$ZERO_SHA" ]; then
      # New branch — scan everything reachable from local_sha that's not
      # on any remote ref. This bounds the scan to commits introduced by
      # this push without rescanning the whole history.
      commits=$(git rev-list "$local_sha" --not --remotes 2>/dev/null || echo '')
    else
      commits=$(git rev-list "${remote_sha}..${local_sha}" 2>/dev/null || echo '')
    fi
    [ -z "$commits" ] && continue
    scan_commits "$commits" || fail=1
  done
fi

exit $fail
