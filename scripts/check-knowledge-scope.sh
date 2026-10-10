#!/usr/bin/env bash
#
# AISDLC-773 / RFC-0053 OQ-1: a `protected` knowledge entry must never sit in
# the tracked root, and the protected root must be git-ignored and untracked.
#
# Delegates to the real TypeScript parser (`cli-context check-scope`), which
# resolves `knowledge.trackedRoot` / `knowledge.protectedRoot` from
# .ai-sdlc/context.yaml. A line-regex here would miss flow-mapping/JSON
# frontmatter, CRLF, BOM and trailing-comment forms.
#
# With `--push-stdin` (the pre-push hook) it reads git's push lines (`<local-ref> <local-sha> <remote-ref> <remote-sha>` per line)
# and also scans EVERY commit being pushed, so a protected entry added in one commit and
# removed in a later one cannot slip past a HEAD/index-only check. Without the flag
# (e.g. `pnpm knowledge:check`) only the working tree and index are checked.
#
# Exit codes:
#   0 — no violations (or CLI not built outside CI: skipped with a message)
#   1 — violation, or CLI not built in CI (CI env set)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="$here/../pipeline-cli/bin/cli-context.mjs"
dist="$here/../pipeline-cli/dist/cli/context.js"

if [ ! -f "$dist" ]; then
  if [ -n "${CI:-}" ]; then
    echo "ERROR: pipeline-cli is not built; cannot run the knowledge scope check (run pnpm build)." >&2
    exit 1
  fi
  echo "[check-knowledge-scope] pipeline-cli/dist not built; skipping (CI runs this check)." >&2
  exit 0
fi

NULL_SHA="0000000000000000000000000000000000000000"
fail=0

run_check() {
  node "$cli" check-scope --project-dir "$PWD" "$@" || fail=1
}

if [ "${1:-}" = "--push-stdin" ]; then
  # One scan per pushed ref, so one ref's old remote tip never hides another ref's commits.
  scanned=0
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    [ "$local_sha" = "$NULL_SHA" ] && continue # deleting a ref pushes no commits
    revs=(--rev "$local_sha")
    if [ -n "${remote_sha:-}" ] && [ "$remote_sha" != "$NULL_SHA" ] \
      && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
      revs+=(--rev "^$remote_sha")
    elif base="$(git merge-base "$local_sha" origin/main 2>/dev/null)" && [ -n "$base" ]; then
      # New branch (or a remote tip we do not have): everything since main.
      revs+=(--rev "^$base")
    fi
    # No base at all: scan the whole history reachable from the pushed sha (fails closed).
    run_check "${revs[@]}"
    scanned=1
  done
  [ "$scanned" = "1" ] || run_check
else
  run_check
fi

if [ "$fail" = "0" ]; then
  exit 0
fi

{
  echo ""
  echo "ERROR: protected knowledge must stay out of the repository (AISDLC-773)."
  echo "Move protected entries under the protected root (gitignored), or change the scope"
  echo "to internal/universal if it is not client or data-room material."
} >&2
exit 1
