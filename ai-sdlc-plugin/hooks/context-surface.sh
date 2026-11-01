#!/bin/bash
#
# AI-SDLC RFC-0053 context surfacing hook. Usage: context-surface.sh <moment>
# Fail-open: always exits 0.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/context-surface.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

node "$SCRIPT" "$@" || true
exit 0
