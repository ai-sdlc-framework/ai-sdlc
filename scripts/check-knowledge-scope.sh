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

if node "$cli" check-scope --project-dir "$PWD"; then
  exit 0
fi

{
  echo ""
  echo "ERROR: protected knowledge must stay out of the repository (AISDLC-773)."
  echo "Move protected entries under the protected root (gitignored), or change the scope"
  echo "to internal/universal if it is not client or data-room material."
} >&2
exit 1
