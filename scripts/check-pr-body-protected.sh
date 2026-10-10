#!/usr/bin/env bash
#
# AISDLC-773 / RFC-0053 OQ-1: refuse a PR body that cites a protected knowledge
# entry id or the protected root path. Delegates to `cli-context check-pr-body`
# so ids are extracted by the real parser and the configured protected root
# (.ai-sdlc/context.yaml) is honoured.
#
# Usage: check-pr-body-protected.sh <body-file|->
#
# Exit codes: 0 clean, 1 cites protected knowledge, 2 usage error

set -euo pipefail

body_file="${1:-}"
if [ -z "$body_file" ]; then
  echo "usage: check-pr-body-protected.sh <body-file|->" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli="$here/../pipeline-cli/bin/cli-context.mjs"
dist="$here/../pipeline-cli/dist/cli/context.js"

if [ ! -f "$dist" ]; then
  if [ -n "${CI:-}" ]; then
    echo "ERROR: pipeline-cli is not built; cannot check the PR body (run pnpm build)." >&2
    exit 1
  fi
  echo "[check-pr-body-protected] pipeline-cli/dist not built; skipping." >&2
  exit 0
fi

if [ "$body_file" = "-" ]; then
  node "$cli" check-pr-body --project-dir "$PWD"
else
  node "$cli" check-pr-body --project-dir "$PWD" --body-file "$body_file"
fi
