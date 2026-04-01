#!/bin/bash
#
# AI-SDLC Deferred Coverage Check (asyncRewake Stop Hook)
#
# Runs test coverage in the background after the agent stops.
# If coverage drops below threshold, exits with code 2 to wake
# the model with the failure details.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/deferred-coverage-check.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
