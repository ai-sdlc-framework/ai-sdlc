#!/usr/bin/env bash
# AISDLC-1370: first /ai-sdlc execute call. Usage: execute-next-step.sh <task-arg>
# Resolves the pipeline CLI and runs `next-step --fresh`. Bash 3.2 safe.
set -u
ARGUMENTS="${1:-}"
here=$(cd "$(dirname "$0")" && pwd)
# AISDLC-1024: a task labelled pipeline-hotfix runs on the last canary-green build, not HEAD.
if [ -z "${AI_SDLC_PIPELINE_REF:-}" ] && [ -f "$here/hotfix-pipeline-ref.mjs" ]; then
  AI_SDLC_PIPELINE_REF=$(node "$here/hotfix-pipeline-ref.mjs" "$ARGUMENTS" 2>/dev/null || true)
  if [ -n "$AI_SDLC_PIPELINE_REF" ]; then export AI_SDLC_PIPELINE_REF; else unset AI_SDLC_PIPELINE_REF; fi
fi
PIPELINE_CLI_BIN=$(bash "$here/choose-pipeline-cli-bin.sh") || exit 1
STATE="${TMPDIR:-/tmp}/ai-sdlc-next-step/$(printf '%s' "$ARGUMENTS" | tr -c 'A-Za-z0-9.-' '_').json"
exec node "$PIPELINE_CLI_BIN/ai-sdlc-pipeline.mjs" next-step --task "$ARGUMENTS" --state "$STATE" --fresh
