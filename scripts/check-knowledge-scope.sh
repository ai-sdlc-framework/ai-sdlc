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
# With git's pre-push stdin (`<local-ref> <local-sha> <remote-ref> <remote-sha>` per line)
# it also scans EVERY commit being pushed, so a protected entry added in one commit and
# removed in a later one cannot slip past a HEAD/index-only check. Without stdin (a
# terminal, e.g. `pnpm knowledge:check`) only the working tree and index are checked.
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
rev_args=()
if [ ! -t 0 ]; then
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    [ "$local_sha" = "$NULL_SHA" ] && continue # deleting a ref pushes no commits
    rev_args+=(--rev "$local_sha")
    if [ -n "${remote_sha:-}" ] && [ "$remote_sha" != "$NULL_SHA" ] \
      && git cat-file -e "${remote_sha}^{commit}" 2>/dev/null; then
      rev_args+=(--rev "^$remote_sha")
    elif base="$(git merge-base "$local_sha" origin/main 2>/dev/null)" && [ -n "$base" ]; then
      # New branch (or a remote tip we do not have): everything since main.
      rev_args+=(--rev "^$base")
    fi
    # No base at all: scan the whole history reachable from the pushed sha (fails closed).
  done
fi

if node "$cli" check-scope --project-dir "$PWD" ${rev_args[@]+"${rev_args[@]}"}; then
  exit 0
fi

{
  echo ""
  echo "ERROR: protected knowledge must stay out of the repository (AISDLC-773)."
  echo "Move protected entries under the protected root (gitignored), or change the scope"
  echo "to internal/universal if it is not client or data-room material."
} >&2
exit 1
