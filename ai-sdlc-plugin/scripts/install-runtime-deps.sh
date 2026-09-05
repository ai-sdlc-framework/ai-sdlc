#!/usr/bin/env bash
# AISDLC-272 / AISDLC-441: Install runtime dependencies into the plugin cache directory.
#
# The Claude Code local marketplace installer copies plugin files to
# ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ but does NOT
# run `npm install` in that directory — so runtimeDependencies declared in
# plugin.json are never installed for local marketplace setups.
#
# AISDLC-441 root-cause fix:
#   - Pre-AISDLC-441 the script ran `npm install --prefix "$PLUGIN_DIR"` against
#     a directory that has no `package.json` (or has one with empty
#     `dependencies:`). npm silently exits 0 without installing anything,
#     leaving the MCP server entry point and pipeline-cli unreachable.
#   - Post-AISDLC-441 the script parses `runtimeDependencies` from
#     `plugin.json` (the actual source of truth declared in
#     ai-sdlc-plugin/plugin.json AISDLC-272) and explicitly invokes
#     `npm install <name>@<version> ...` per entry. This works regardless of
#     whether the cache dir has a package.json.
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

if ! command -v node >/dev/null 2>&1; then
  echo "install-runtime-deps.sh: 'node' not found on PATH — required to parse plugin.json runtimeDependencies" >&2
  exit 1
fi

# ── Parse runtimeDependencies from plugin.json ───────────────────────────────
#
# Moved ahead of the idempotence check (AISDLC-580) so the pins are available
# for the version-convergence check below — the pure file-existence idempotence
# check alone cannot tell a satisfying-but-stale install from a correct one.
#
# We extract the field via `node` rather than `jq` because `node` is already a
# hard dependency of the plugin (both bins run on Node) — making `jq` mandatory
# would surprise adopters whose container images don't ship it.
#
# Output format: one "name@version" pair per line, e.g.
#   @ai-sdlc/pipeline-cli@^0.10.0
#   @ai-sdlc/plugin-mcp-server@0.9.2
#
# Exits 1 with an actionable message when `runtimeDependencies` is missing or
# empty — pre-AISDLC-441 this was the silent-no-op failure mode.

# Capture parse output and any node-level errors separately so a malformed
# plugin.json surfaces clearly instead of getting eaten by the if-test.
PARSE_OUTPUT=$(node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  let raw;
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch (e) {
    process.stderr.write("install-runtime-deps.sh: cannot read " + path + ": " + e.message + "\n");
    process.exit(2);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    process.stderr.write("install-runtime-deps.sh: " + path + " is not valid JSON: " + e.message + "\n");
    process.exit(2);
  }
  const deps = json && json.runtimeDependencies;
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) {
    process.stderr.write("install-runtime-deps.sh: plugin.json has no runtimeDependencies object — nothing to install (this is the AISDLC-441 silent-no-op bug; declare runtimeDependencies in plugin.json)\n");
    process.exit(3);
  }
  const entries = Object.entries(deps);
  if (entries.length === 0) {
    process.stderr.write("install-runtime-deps.sh: plugin.json runtimeDependencies object is empty — nothing to install\n");
    process.exit(3);
  }
  for (const [name, version] of entries) {
    if (typeof name !== "string" || typeof version !== "string" || !name || !version) {
      process.stderr.write("install-runtime-deps.sh: invalid runtimeDependencies entry: " + JSON.stringify({ [name]: version }) + "\n");
      process.exit(3);
    }
    process.stdout.write(name + "@" + version + "\n");
  }
' "$PLUGIN_DIR/plugin.json") || {
  PARSE_EXIT=$?
  echo "install-runtime-deps.sh: failed to parse runtimeDependencies (node exit $PARSE_EXIT) — cannot self-heal" >&2
  exit 1
}

# Convert newline-separated list to a bash array.
RUNTIME_SPECS=()
while IFS= read -r line; do
  [ -n "$line" ] && RUNTIME_SPECS+=("$line")
done <<< "$PARSE_OUTPUT"

if [ "${#RUNTIME_SPECS[@]}" -eq 0 ]; then
  echo "install-runtime-deps.sh: parsed 0 runtimeDependencies — nothing to install" >&2
  exit 1
fi

# ── Idempotence check (early-exit when both deps are already present) ────────
#
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
PIPELINE_CLI_OK=0
MCP_SERVER_OK=0
ORCHESTRATOR_OK=0

if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs" ]; then
  PIPELINE_CLI_OK=1
fi
if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js" ]; then
  MCP_SERVER_OK=1
fi
# AISDLC-554: @ai-sdlc/orchestrator carries the attestation signing runtime.
# It MUST participate in the idempotence check — without this line an adopter
# whose plugin predates AISDLC-554 already has the other two packages, so the
# early-exit below fires and orchestrator is never installed, leaving the
# signer unresolvable and attestation silently unavailable. The probed file is
# the exact module sign-attestation.mjs imports, so a partial install fails the
# check rather than passing on the package directory alone.
if [ -f "$PLUGIN_DIR/node_modules/@ai-sdlc/orchestrator/dist/runtime/attestations.js" ]; then
  ORCHESTRATOR_OK=1
fi

# ── Version-convergence check (AISDLC-580) ───────────────────────────────────
#
# Bug: a prior file-existence-only idempotence check treats "the entry-point
# file exists" as "the install is correct" — but npm's own default install
# behavior is ALSO version-blind in this mode: `npm install pkg@^0.20.0`
# against a directory that already has ANY version satisfying `^0.20.0`
# installed is a no-op, even when a newer satisfying version has since been
# published. Combined, an adopter who bumps the plugin's runtimeDependencies
# pin (or who just wants the latest patch) can be silently stuck on a stale,
# already-fixed-upstream version forever — exactly the AISDLC-579 masking
# incident this task exists to close.
#
# Fix: delegate to check-stale-runtime-deps.mjs, which resolves the ACTUAL
# target version npm would install for `name@pin` via `npm view name@pin
# version` and compares it to the installed version. That script is the
# SINGLE SOURCE for this check — session-start.js's automatic self-heal gate
# and resolve-pipeline-cli.sh's `_deps_complete` gate call the exact same
# script, so a stale-but-present install is detected uniformly across every
# caller, not just this manual entry point (AISDLC-580 review follow-up).
#
# A mismatch means either (a) the installed version no longer satisfies the
# pin, or (b) it satisfies the pin but a newer satisfying version is now
# available — both cases force a clean reinstall of just that package's
# directory (never assume a partial delete is safe to skip; npm's local
# resolution treats "directory exists and satisfies range" as done, so
# removal is what actually forces convergence).
#
# Fails open: check-stale-runtime-deps.mjs itself fails open (no local
# package.json to compare against, or the registry is unreachable/`npm view`
# times out) — this keeps offline / already-converged runs exactly as fast
# and side-effect-free as before, and never blocks plugin usage on a flaky
# network.
#
# NOTE: unlike a network drop mid-`npm install` (which self-heals on the very
# next run since the removed package would simply appear missing again), the
# `rm -rf` below intentionally happens BEFORE the subsequent `npm install`
# call, not after a verified fetch. This is a known availability trade-off
# (a network drop between the `rm -rf` and the `npm install` succeeding would
# leave that one package briefly absent) — accepted because the failure mode
# is self-healing (the post-install verification step below will fail loud
# and the very next invocation retries the same rm+install), not silent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STALE_CHECK_SCRIPT="$SCRIPT_DIR/check-stale-runtime-deps.mjs"
if [ -f "$STALE_CHECK_SCRIPT" ]; then
  STALE_OUTPUT=$(node "$STALE_CHECK_SCRIPT" "$PLUGIN_DIR" 2>/dev/null) || STALE_OUTPUT=""
  while IFS=' ' read -r stale_name stale_installed stale_target stale_pin; do
    [ -z "$stale_name" ] && continue
    echo "install-runtime-deps.sh: upgrading $stale_name $stale_installed -> $stale_target to satisfy pin $stale_pin" >&2
    rm -rf "$PLUGIN_DIR/node_modules/$stale_name"
    case "$stale_name" in
      "@ai-sdlc/pipeline-cli") PIPELINE_CLI_OK=0 ;;
      "@ai-sdlc/plugin-mcp-server") MCP_SERVER_OK=0 ;;
      "@ai-sdlc/orchestrator") ORCHESTRATOR_OK=0 ;;
    esac
  done <<< "$STALE_OUTPUT"
fi

if [ "$PIPELINE_CLI_OK" = "1" ] && [ "$MCP_SERVER_OK" = "1" ] && [ "$ORCHESTRATOR_OK" = "1" ]; then
  echo "install-runtime-deps.sh: all runtimeDependencies already installed in $PLUGIN_DIR" >&2
  exit 0
fi

echo "install-runtime-deps.sh: installing ${#RUNTIME_SPECS[@]} runtimeDependencies in $PLUGIN_DIR ..." >&2
for spec in "${RUNTIME_SPECS[@]}"; do
  echo "install-runtime-deps.sh:   - $spec" >&2
done

# ── Run npm install with the explicit package specs ──────────────────────────
#
# --prefix         : install into PLUGIN_DIR/node_modules (not the cwd)
# --no-save        : don't try to write package.json (it may not exist)
# --omit=dev       : runtime deps only — keeps the install lean
# --no-audit       : reduce noise in plugin-install contexts
# --no-fund        : reduce noise
# --ignore-scripts : security (AISDLC-385) — mcp-server + pipeline-cli are
#                    pre-built bundles; no install scripts needed. Without
#                    this flag, every transitive dep's preinstall/install/
#                    postinstall would execute under the operator's identity,
#                    giving any compromised dep RCE on plugin self-heal.
# --loglevel warn  : show errors but suppress per-package info chatter
#
# We do NOT pass any specs as positional args when running against a
# directory that already has a package.json with valid dependencies — but in
# the AISDLC-441 case, the cache dir has no usable package.json, so we always
# pass explicit specs. This is the load-bearing fix.

npm install \
  --prefix "$PLUGIN_DIR" \
  --no-save \
  --omit=dev \
  --no-audit \
  --no-fund \
  --ignore-scripts \
  --loglevel warn \
  "${RUNTIME_SPECS[@]}" \
  2>&1

# ── Verify install succeeded ─────────────────────────────────────────────────
INSTALL_OK=1
MISSING=()
if [ ! -f "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs" ]; then
  MISSING+=("@ai-sdlc/pipeline-cli (expected $PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs)")
  INSTALL_OK=0
fi
if [ ! -f "$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js" ]; then
  MISSING+=("@ai-sdlc/plugin-mcp-server (expected $PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js)")
  INSTALL_OK=0
fi
# AISDLC-554: the sentinel written below lets session-start skip future
# installs, so orchestrator must be verified here too — otherwise a run that
# silently failed to install it still stamps "complete" and the signer stays
# unresolvable.
if [ ! -f "$PLUGIN_DIR/node_modules/@ai-sdlc/orchestrator/dist/runtime/attestations.js" ]; then
  MISSING+=("@ai-sdlc/orchestrator (expected $PLUGIN_DIR/node_modules/@ai-sdlc/orchestrator/dist/runtime/attestations.js)")
  INSTALL_OK=0
fi

if [ "$INSTALL_OK" = "1" ]; then
  # Write a sentinel so session-start can skip the install on subsequent loads
  # without re-running npm. The sentinel is removed if anyone manually deletes
  # node_modules, naturally re-triggering install.
  mkdir -p "$PLUGIN_DIR/node_modules"
  printf '%s\n' "installed by ai-sdlc-plugin install-runtime-deps.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$PLUGIN_DIR/node_modules/.ai-sdlc-installed"
  echo "install-runtime-deps.sh: runtimeDependencies installed successfully (${#RUNTIME_SPECS[@]} packages)" >&2
  exit 0
else
  echo "install-runtime-deps.sh: npm install completed but the following expected files are missing:" >&2
  for m in "${MISSING[@]}"; do
    echo "install-runtime-deps.sh:   - $m" >&2
  done
  echo "install-runtime-deps.sh: check network access (npm registry reachable?) + npm registry config" >&2
  exit 1
fi
