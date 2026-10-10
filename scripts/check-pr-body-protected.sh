#!/usr/bin/env bash
#
# AISDLC-773 / RFC-0053 OQ-1: refuse a PR body that cites a protected knowledge
# entry id or the protected root path. Protected ids are read from the entries
# in the local protected root (gitignored, so absent in CI -> only the path
# check applies there).
#
# Usage: check-pr-body-protected.sh <body-file> [protected-root]
#   Default protected root: .ai-sdlc/knowledge-protected
#   <body-file> may be '-' for stdin.
#
# Exit codes:
#   0 — body does not cite protected knowledge
#   1 — body cites a protected entry id or the protected root path
#   2 — usage error

set -euo pipefail

body_file="${1:-}"
protected_root="${2:-.ai-sdlc/knowledge-protected}"
protected_root="${protected_root%/}"

if [ -z "$body_file" ]; then
  echo "usage: check-pr-body-protected.sh <body-file|-> [protected-root]" >&2
  exit 2
fi

body=$(cat "$body_file")
hits=""

if printf '%s' "$body" | grep -qF -- "${protected_root}/"; then
  hits="${hits}  - path ${protected_root}/"$'\n'
fi

if [ -d "$protected_root" ]; then
  while IFS= read -r f; do
    id=$(awk '
      NR == 1 && $0 != "---" { exit }
      NR > 1 && $0 == "---" { exit }
      /^id:/ { sub(/^id:[[:space:]]*/, ""); gsub(/^["'\'']|["'\'']$/, ""); print; exit }
    ' "$f")
    [ -n "$id" ] || continue
    esc=$(printf '%s' "$id" | sed 's/[][\.*^$+?(){}|]/\\&/g')
    if printf '%s' "$body" | grep -qE -- "(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])"; then
      hits="${hits}  - entry id ${id}"$'\n'
    fi
  done < <(find "$protected_root" -type f -name '*.md' | LC_ALL=C sort)
fi

if [ -z "$hits" ]; then
  exit 0
fi

{
  echo ""
  echo "ERROR: PR body cites protected knowledge (AISDLC-773)."
  echo ""
  printf '%s' "$hits"
  echo ""
  echo "Protected entries never enter a PR body. Remove the citation."
} >&2

exit 1
