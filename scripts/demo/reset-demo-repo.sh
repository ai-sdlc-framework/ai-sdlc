#!/usr/bin/env bash
# Return the demo repo to its start state (AISDLC-772): rebuild it with the
# seed script, which is deterministic. Stop the hierarchy first
# (cli-hierarchy down) so no session holds the old directory.
set -euo pipefail
exec "$(dirname "$0")/seed-demo-repo.sh" "$@"
