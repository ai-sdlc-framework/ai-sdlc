#!/bin/bash
#
# AI-SDLC Permission Check Hook (PermissionRequest)
#
# Hard denies blocked actions at the permission layer.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/permission-check.js"

if [ ! -f "$SCRIPT" ]; then
  exit 0
fi

exec node "$SCRIPT"
