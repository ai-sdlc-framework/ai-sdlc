#!/usr/bin/env bash
# AISDLC-1370: choose the pipeline-cli bin directory for /ai-sdlc execute.
#
# Prints the directory (no trailing newline). Exits 1 when no install is found.
#   1. PIPELINE_CLI_BIN already set (operator override) -> printed unchanged.
#   2. resolve-pipeline-cli.sh next to this script -> its result.
#   3. resolver not shipped (upgrade in place) -> "$(pwd)/pipeline-cli/bin".
# Written for bash 3.2 (macOS /bin/bash).
set -u
if [ -n "${PIPELINE_CLI_BIN:-}" ]; then
  printf '%s' "$PIPELINE_CLI_BIN"
  exit 0
fi
here=$(cd "$(dirname "$0")" && pwd)
if [ -f "$here/resolve-pipeline-cli.sh" ]; then
  bash "$here/resolve-pipeline-cli.sh" || {
    echo "ERROR: @ai-sdlc/pipeline-cli not found; export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin" >&2
    exit 1
  }
else
  printf '%s' "$(pwd)/pipeline-cli/bin"
fi
