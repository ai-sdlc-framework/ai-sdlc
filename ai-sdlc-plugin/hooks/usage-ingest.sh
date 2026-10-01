#!/bin/bash
#
# AI-SDLC Usage Ingest Hook (Stop + SessionStart)
#
# Launches usage-ledger ingestion in the background and returns immediately.
# Must never delay or fail a session: every error path exits 0.
#

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
SCRIPT="$SCRIPT_DIR/usage-ingest.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

node "$SCRIPT" >/dev/null 2>&1 || true
exit 0
