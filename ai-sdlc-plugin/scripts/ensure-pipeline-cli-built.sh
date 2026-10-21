#!/usr/bin/env bash
# AISDLC-1001: the one "ensure built" helper for the pipeline-cli workspace.
#
#   ensure-pipeline-cli-built.sh <repo-root>
#
# Exit 0 when <repo-root>/pipeline-cli/dist exists and no source file is newer than
# its newest output (nothing is run), or after a successful
# `pnpm --filter @ai-sdlc/pipeline-cli build`. Exit 1 with the build output on
# stderr when the build fails. Exit 2 when <repo-root> has no pipeline-cli/src
# (a consumer repo: nothing to build, the caller keeps its own fallback).
# Used by resolve-pipeline-cli.sh, scripts/check-followups.mjs and worktree setup.
set -uo pipefail

ROOT="${1:-}"
CLI="$ROOT/pipeline-cli"
[ -n "$ROOT" ] && [ -d "$CLI/src" ] || exit 2

_fresh() {
  local newest
  [ -d "$CLI/dist" ] || return 1
  newest="$(find "$CLI/dist" -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1 || true)"
  [ -n "$newest" ] || return 1
  [ -z "$(find "$CLI/src" "$CLI/package.json" -type f \( -name '*.ts' -o -name package.json \) ! -name '*.test.ts' -newer "$newest" -print -quit 2>/dev/null)" ]
}

_fresh && exit 0

echo "ensure-pipeline-cli-built.sh: pipeline-cli build in $CLI is missing or older than its sources; running: pnpm --filter @ai-sdlc/pipeline-cli build" >&2
TMO=""
command -v timeout >/dev/null 2>&1 && TMO="timeout 600"
OUT="$(cd "$ROOT" && $TMO pnpm --filter @ai-sdlc/pipeline-cli build 2>&1)"
STATUS=$?
[ "$STATUS" -eq 0 ] && exit 0
echo "ensure-pipeline-cli-built.sh: ERROR — pipeline-cli build failed in $ROOT: $(printf '%s' "$OUT" | tail -5 | tr '\n' ' ')" >&2
exit 1
