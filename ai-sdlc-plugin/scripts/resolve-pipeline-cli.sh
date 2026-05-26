#!/usr/bin/env bash
# AISDLC-272: Resolve the pipeline-cli bin directory across all install topologies.
#
# Outputs the resolved PIPELINE_CLI_BIN path to stdout (no trailing newline).
# Exits 0 on success, 1 when no usable install is found.
#
# Resolution order (first match wins):
#
#   1. CLAUDE_PLUGIN_DIR set + node_modules/@ai-sdlc/pipeline-cli/bin exists
#      → Standard marketplace install with bundled deps. Use it.
#
#   2. CLAUDE_PLUGIN_DIR set + node_modules missing
#      → Broken/incomplete install. Try to self-heal via install-runtime-deps.sh,
#        then retry. If self-heal fails, fall through.
#
#   3. CLAUDE_PLUGIN_ROOT set (always injected by Claude Code) + node_modules exists
#      → Use CLAUDE_PLUGIN_ROOT as the install dir (same directory, different var).
#
#   4. Plugin cache probe: ~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/
#      → Walk all marketplace caches, find the highest installed version that has
#        node_modules/@ai-sdlc/pipeline-cli/bin. Use it.
#
#   5. Monorepo dogfood fallback: $(pwd)/pipeline-cli/bin
#      → Works when run from within the ai-sdlc monorepo. Fails in adopter projects.
#
#   6. Nothing found → print actionable error to stderr, exit 1.
#
# Usage (called from execute.md path-resolution preamble):
#
#   PIPELINE_CLI_BIN=$(bash "$PLUGIN_SCRIPTS_DIR/resolve-pipeline-cli.sh") || exit 1
#
# Environment variables read:
#   CLAUDE_PLUGIN_DIR  — set by Claude Code harness for marketplace installs
#   CLAUDE_PLUGIN_ROOT — always set by Claude Code harness (same dir as CLAUDE_PLUGIN_DIR
#                         in most contexts, but guaranteed to exist)
#
# The script is idempotent and safe to call multiple times.

set -euo pipefail

PIPELINE_CLI_REL="node_modules/@ai-sdlc/pipeline-cli/bin"

# Helper: check if a candidate bin dir is usable (has at least one cli-*.mjs).
_is_usable() {
  local candidate="$1"
  [ -d "$candidate" ] && ls "$candidate"/cli-*.mjs &>/dev/null 2>&1
}

# AISDLC-385: also check for plugin-mcp-server bundle. Self-heal should
# trigger if EITHER dep is missing (not just pipeline-cli). Otherwise an
# upgrade where pipeline-cli is already installed but mcp-server is not
# (e.g. operator ran `pnpm clean` then resumed without `npm install`)
# leaves the MCP server silently unreachable at Claude Code startup.
_mcp_usable() {
  local plugin_dir="$1"
  [ -f "$plugin_dir/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js" ]
}

# Combined self-heal trigger: returns 0 (needs heal) if pipeline-cli OR
# mcp-server is missing in the plugin dir.
_deps_complete() {
  local plugin_dir="$1"
  _is_usable "$plugin_dir/$PIPELINE_CLI_REL" && _mcp_usable "$plugin_dir"
}

# ── Topology 1: CLAUDE_PLUGIN_DIR set + deps bundled ────────────────────────
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  CANDIDATE="$CLAUDE_PLUGIN_DIR/$PIPELINE_CLI_REL"
  # AISDLC-385: fast-path requires BOTH pipeline-cli AND mcp-server present.
  if _deps_complete "$CLAUDE_PLUGIN_DIR"; then
    printf '%s' "$CANDIDATE"
    exit 0
  fi

  # ── Topology 2: CLAUDE_PLUGIN_DIR set + deps missing (broken install) ─────
  # Attempt self-heal: run install-runtime-deps.sh if it ships with the plugin.
  # AISDLC-385: triggers when EITHER pipeline-cli OR mcp-server is missing.
  SELF_HEAL_SCRIPT="$CLAUDE_PLUGIN_DIR/scripts/install-runtime-deps.sh"
  if [ -f "$SELF_HEAL_SCRIPT" ]; then
    MISSING="pipeline-cli"
    _is_usable "$CANDIDATE" && MISSING="plugin-mcp-server"
    echo "resolve-pipeline-cli.sh: @ai-sdlc/$MISSING missing in $CLAUDE_PLUGIN_DIR — attempting self-heal..." >&2
    if bash "$SELF_HEAL_SCRIPT" "$CLAUDE_PLUGIN_DIR" >&2; then
      if _deps_complete "$CLAUDE_PLUGIN_DIR"; then
        echo "resolve-pipeline-cli.sh: self-heal succeeded" >&2
        printf '%s' "$CANDIDATE"
        exit 0
      fi
    fi
    echo "resolve-pipeline-cli.sh: self-heal did not produce a complete install — continuing fallback chain" >&2
  fi
fi

# ── Topology 3: CLAUDE_PLUGIN_ROOT set (always injected by Claude Code) ─────
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  CANDIDATE="$CLAUDE_PLUGIN_ROOT/$PIPELINE_CLI_REL"
  # AISDLC-385: fast-path requires BOTH pipeline-cli AND mcp-server present.
  if _deps_complete "$CLAUDE_PLUGIN_ROOT"; then
    printf '%s' "$CANDIDATE"
    exit 0
  fi

  # CLAUDE_PLUGIN_ROOT is set but deps are missing — try self-heal here too.
  # AISDLC-385: triggers when EITHER pipeline-cli OR mcp-server is missing.
  SELF_HEAL_SCRIPT="$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh"
  if [ -f "$SELF_HEAL_SCRIPT" ]; then
    MISSING="pipeline-cli"
    _is_usable "$CANDIDATE" && MISSING="plugin-mcp-server"
    echo "resolve-pipeline-cli.sh: @ai-sdlc/$MISSING missing in $CLAUDE_PLUGIN_ROOT — attempting self-heal..." >&2
    if bash "$SELF_HEAL_SCRIPT" "$CLAUDE_PLUGIN_ROOT" >&2; then
      if _deps_complete "$CLAUDE_PLUGIN_ROOT"; then
        echo "resolve-pipeline-cli.sh: self-heal (CLAUDE_PLUGIN_ROOT) succeeded" >&2
        printf '%s' "$CANDIDATE"
        exit 0
      fi
    fi
  fi
fi

# ── Topology 4: Plugin cache probe ──────────────────────────────────────────
# Walk ~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/
CACHE_ROOT="${HOME}/.claude/plugins/cache"
if [ -d "$CACHE_ROOT" ]; then
  # Collect all candidates; sort by version (highest first via sort -rV).
  BEST_CANDIDATE=""
  BEST_VERSION=""
  for marketplace_dir in "$CACHE_ROOT"/*/; do
    [ -d "$marketplace_dir" ] || continue
    PLUGIN_VERSIONS_DIR="${marketplace_dir}ai-sdlc"
    [ -d "$PLUGIN_VERSIONS_DIR" ] || continue
    for version_dir in "$PLUGIN_VERSIONS_DIR"/*/; do
      [ -d "$version_dir" ] || continue
      CANDIDATE="${version_dir%/}/$PIPELINE_CLI_REL"
      VERSION="$(basename "$version_dir")"
      if _is_usable "$CANDIDATE"; then
        # Compare versions: keep the highest.
        if [ -z "$BEST_VERSION" ] || \
           printf '%s\n%s\n' "$BEST_VERSION" "$VERSION" | sort -rV | head -1 | grep -q "^$VERSION$"; then
          BEST_CANDIDATE="$CANDIDATE"
          BEST_VERSION="$VERSION"
        fi
      fi
    done
  done

  if [ -n "$BEST_CANDIDATE" ]; then
    echo "resolve-pipeline-cli.sh: using plugin cache at version $BEST_VERSION" >&2
    printf '%s' "$BEST_CANDIDATE"
    exit 0
  fi
fi

# ── Topology 5: Monorepo dogfood fallback ───────────────────────────────────
DOGFOOD_BIN="$(pwd)/pipeline-cli/bin"
if _is_usable "$DOGFOOD_BIN"; then
  printf '%s' "$DOGFOOD_BIN"
  exit 0
fi

# ── Nothing found (all topologies exhausted) ────────────────────────────────
#
# AISDLC-441: surface ROOT CAUSE when we can detect it instead of just
# listing topologies. Common pre-AISDLC-441 silent failure modes:
#   (a) plugin.json missing — wrong CLAUDE_PLUGIN_ROOT
#   (b) plugin.json present but no runtimeDependencies object — broken plugin
#       package (was the AISDLC-441 root cause)
#   (c) plugin.json + runtimeDependencies present, network unreachable —
#       install ran but couldn't fetch
#
# When the self-heal script ran above but didn't produce the deps, that's
# usually (b) or (c). Run a diagnostic pass to tell the operator which.
ROOT_CAUSE=""
DIAG_DIR="${CLAUDE_PLUGIN_DIR:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -n "$DIAG_DIR" ] && [ -d "$DIAG_DIR" ]; then
  if [ ! -f "$DIAG_DIR/plugin.json" ]; then
    ROOT_CAUSE="Root cause: $DIAG_DIR/plugin.json is missing — \$CLAUDE_PLUGIN_DIR / \$CLAUDE_PLUGIN_ROOT does not point at a valid plugin install."
  elif command -v node >/dev/null 2>&1; then
    DIAG=$(node -e '
      const fs = require("node:fs");
      try {
        const json = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
        const deps = json && json.runtimeDependencies;
        if (!deps || typeof deps !== "object" || Array.isArray(deps) || Object.keys(deps).length === 0) {
          process.stdout.write("NO_RUNTIME_DEPS");
        } else {
          process.stdout.write("HAS_RUNTIME_DEPS:" + Object.keys(deps).length);
        }
      } catch (e) {
        process.stdout.write("PARSE_ERROR:" + e.message);
      }
    ' "$DIAG_DIR/plugin.json" 2>/dev/null || echo "NODE_FAILED")
    case "$DIAG" in
      NO_RUNTIME_DEPS)
        ROOT_CAUSE="Root cause: $DIAG_DIR/plugin.json has no runtimeDependencies object — the install script cannot self-heal because there is nothing to install. The plugin package is broken; report this to the plugin author."
        ;;
      HAS_RUNTIME_DEPS:*)
        ROOT_CAUSE="Root cause: plugin.json declares runtimeDependencies (${DIAG#HAS_RUNTIME_DEPS:}) but \`npm install\` did not produce the expected files. Most likely: network unreachable, npm registry misconfigured, or the published package version doesn't exist. Run \`bash \"$DIAG_DIR/scripts/install-runtime-deps.sh\" \"$DIAG_DIR\"\` manually to see the npm error output."
        ;;
      PARSE_ERROR:*)
        ROOT_CAUSE="Root cause: $DIAG_DIR/plugin.json is not valid JSON — ${DIAG#PARSE_ERROR:}"
        ;;
    esac
  fi
fi

{
  echo "resolve-pipeline-cli.sh: ERROR — @ai-sdlc/pipeline-cli binary not found."
  echo ""
  if [ -n "$ROOT_CAUSE" ]; then
    echo "$ROOT_CAUSE"
    echo ""
  fi
  cat <<'EOF'
Tried all install topologies:
  1. $CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin  (marketplace install)
  2. $CLAUDE_PLUGIN_ROOT/node_modules/@ai-sdlc/pipeline-cli/bin (plugin root)
  3. ~/.claude/plugins/cache/*/ai-sdlc/*/node_modules/@ai-sdlc/pipeline-cli/bin (cache probe, read-only)
  4. $(pwd)/pipeline-cli/bin  (dogfood monorepo)

Fix options (choose one):
  A. Re-install the plugin via your marketplace:
       /claude plugin install ai-sdlc
       Then restart Claude Code.

  B. From your plugin install root, run:
       bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh" "$CLAUDE_PLUGIN_ROOT"
     (Self-heal is operator-initiated only; the resolver no longer auto-execs
      install-runtime-deps.sh from the user-writable plugin cache, since that
      would run any script an attacker could plant under ~/.claude/plugins/cache/.)

  C. If running from the ai-sdlc monorepo, cd to the repo root before invoking /ai-sdlc execute.

  D. Override by exporting: export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin

See: ai-sdlc-plugin/README.md "Install topologies + path resolution"
EOF
} >&2
exit 1
