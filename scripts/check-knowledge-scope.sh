#!/usr/bin/env bash
#
# AISDLC-773 / RFC-0053 OQ-1: a `protected` knowledge entry must never sit in
# the tracked root, and the protected root must never be tracked by git.
#
# Usage: check-knowledge-scope.sh [tracked-root] [protected-root]
#   Defaults: .ai-sdlc/knowledge  .ai-sdlc/knowledge-protected
#   (override per adopter via `knowledge.trackedRoot` / `knowledge.protectedRoot`
#   in .ai-sdlc/context.yaml; pass the resolved values as arguments).
#
# Exit codes:
#   0 — no violations (or tracked root absent)
#   1 — a protected entry is in the tracked root, or protected-root files are tracked

set -euo pipefail

tracked_root="${1:-.ai-sdlc/knowledge}"
protected_root="${2:-.ai-sdlc/knowledge-protected}"
tracked_root="${tracked_root%/}"
protected_root="${protected_root%/}"

violations=""

if [ -d "$tracked_root" ]; then
  while IFS= read -r f; do
    # Only the first frontmatter block is inspected.
    if awk '
      NR == 1 && $0 != "---" { exit 1 }
      NR > 1 && $0 == "---" { exit 1 }
      NR > 1 && /^scope:[[:space:]]*["'\'']?protected["'\'']?[[:space:]]*$/ { found = 1; exit 0 }
      END { exit (found ? 0 : 1) }
    ' "$f"; then
      violations="${violations}  - ${f} (scope: protected in tracked root)"$'\n'
    fi
  done < <(find "$tracked_root" -type f -name '*.md' | LC_ALL=C sort)
fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  tracked_protected=$(git ls-files -- "$protected_root" || true)
  if [ -n "$tracked_protected" ]; then
    while IFS= read -r f; do
      violations="${violations}  - ${f} (file under protected root is tracked by git)"$'\n'
    done <<<"$tracked_protected"
  fi
fi

if [ -z "$violations" ]; then
  exit 0
fi

{
  echo ""
  echo "ERROR: protected knowledge must stay out of the repository (AISDLC-773)."
  echo ""
  echo "Offending paths:"
  printf '%s' "$violations"
  echo ""
  echo "Move the entry under ${protected_root}/ (gitignored) or change its scope to"
  echo "internal/universal if it is not client or data-room material."
} >&2

exit 1
