#!/usr/bin/env bash
# AISDLC-272: Install runtime dependencies into the plugin cache directory.
#
# The Claude Code local marketplace installer copies plugin files to
# ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ but does NOT
# run `npm install` in that directory — so runtimeDependencies declared in
# plugin.json are never installed for local marketplace setups.
#
# This script runs `npm install --omit=dev` in the plugin cache directory to
# materialise the declared runtimeDependencies. It is invoked automatically
# by session-start.js when @ai-sdlc/pipeline-cli is detected as missing.
#
# Usage:
#   bash scripts/install-runtime-deps.sh            # from within CLAUDE_PLUGIN_ROOT
#   bash scripts/install-runtime-deps.sh /path/to/plugin-dir
#
# Environment:
#   CLAUDE_PLUGIN_ROOT — set by Claude Code; used when no explicit arg given.
#
# Exits 0 on success, 1 on failure. Prints a one-line status to stderr.

set -euo pipefail

PLUGIN_DIR="${1:-${CLAUDE_PLUGIN_ROOT:-}}"

if [ -z "$PLUGIN_DIR" ]; then
  echo "install-runtime-deps.sh: CLAUDE_PLUGIN_ROOT is unset and no argument given — cannot determine plugin directory" >&2
  exit 1
fi

if [ ! -f "$PLUGIN_DIR/plugin.json" ]; then
  echo "install-runtime-deps.sh: $PLUGIN_DIR/plugin.json not found — not a valid plugin directory" >&2
  exit 1
fi

# Check if @ai-sdlc/pipeline-cli is already installed (idempotent).
if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs" ]; then
  echo "install-runtime-deps.sh: @ai-sdlc/pipeline-cli already installed in $PLUGIN_DIR" >&2
  exit 0
fi

echo "install-runtime-deps.sh: installing runtimeDependencies in $PLUGIN_DIR ..." >&2

# Run npm install in the plugin directory. --omit=dev keeps the install lean.
# --no-audit and --no-fund reduce noise in plugin-install contexts.
npm install \
  --prefix "$PLUGIN_DIR" \
  --omit=dev \
  --no-audit \
  --no-fund \
  --loglevel warn \
  2>&1

if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs" ]; then
  echo "install-runtime-deps.sh: @ai-sdlc/pipeline-cli installed successfully" >&2
  exit 0
else
  echo "install-runtime-deps.sh: npm install completed but @ai-sdlc/pipeline-cli not found — check plugin.json runtimeDependencies" >&2
  exit 1
fi
