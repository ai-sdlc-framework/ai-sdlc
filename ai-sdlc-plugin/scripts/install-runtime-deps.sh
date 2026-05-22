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

# Check if all runtime dependencies are already installed (idempotent).
PIPELINE_CLI_OK=0
MCP_SERVER_OK=0

if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs" ]; then
  PIPELINE_CLI_OK=1
fi

# AISDLC-385: @ai-sdlc/plugin-mcp-server is now a runtimeDependency (replaces
# the in-tree dist/bin.js that was previously committed to git). The MCP server
# binary is resolved at ${CLAUDE_PLUGIN_ROOT}/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js.
#
# Dogfood topology 2 (local checkout): when ${PLUGIN_DIR}/mcp-server/dist/bin.js
# exists (built by `pnpm --filter @ai-sdlc/plugin-mcp-server build`), it takes
# priority — the mcpServers config will resolve ${CLAUDE_PLUGIN_ROOT}/node_modules/...
# which doesn't exist in a plain monorepo checkout, causing Claude Code to fall
# back to the sibling path or requiring explicit CLAUDE_PLUGIN_ROOT override.
# For dogfood use, build the local dist first: `pnpm --filter @ai-sdlc/plugin-mcp-server build`.
if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js" ]; then
  MCP_SERVER_OK=1
fi

if [ "$PIPELINE_CLI_OK" = "1" ] && [ "$MCP_SERVER_OK" = "1" ]; then
  echo "install-runtime-deps.sh: all runtimeDependencies already installed in $PLUGIN_DIR" >&2
  exit 0
fi

echo "install-runtime-deps.sh: installing runtimeDependencies in $PLUGIN_DIR ..." >&2

# Run npm install in the plugin directory. --omit=dev keeps the install lean.
# --no-audit and --no-fund reduce noise in plugin-install contexts.
# --ignore-scripts (AISDLC-385 security review): mcp-server + pipeline-cli are
# pre-built bundle distributions — no install scripts needed. Without this
# flag, every transitive dep's preinstall/install/postinstall would execute
# under the operator's identity, giving any compromised dep RCE on plugin
# self-heal. Pre-built bundles have no compile step; this is safe.
npm install \
  --prefix "$PLUGIN_DIR" \
  --omit=dev \
  --no-audit \
  --no-fund \
  --ignore-scripts \
  --loglevel warn \
  2>&1

INSTALL_OK=1
if [ ! -f "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs" ]; then
  echo "install-runtime-deps.sh: npm install completed but @ai-sdlc/pipeline-cli not found — check plugin.json runtimeDependencies" >&2
  INSTALL_OK=0
fi
if [ ! -f "$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js" ]; then
  echo "install-runtime-deps.sh: npm install completed but @ai-sdlc/plugin-mcp-server not found — check plugin.json runtimeDependencies" >&2
  INSTALL_OK=0
fi

if [ "$INSTALL_OK" = "1" ]; then
  echo "install-runtime-deps.sh: runtimeDependencies installed successfully" >&2
  exit 0
else
  exit 1
fi
