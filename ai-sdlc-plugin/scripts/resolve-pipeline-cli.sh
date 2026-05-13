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

# ── Topology 1: CLAUDE_PLUGIN_DIR set + deps bundled ────────────────────────
if [ -n "${CLAUDE_PLUGIN_DIR:-}" ]; then
  CANDIDATE="$CLAUDE_PLUGIN_DIR/$PIPELINE_CLI_REL"
  if _is_usable "$CANDIDATE"; then
    printf '%s' "$CANDIDATE"
    exit 0
  fi

  # ── Topology 2: CLAUDE_PLUGIN_DIR set + deps missing (broken install) ─────
  # Attempt self-heal: run install-runtime-deps.sh if it ships with the plugin.
  SELF_HEAL_SCRIPT="$CLAUDE_PLUGIN_DIR/scripts/install-runtime-deps.sh"
  if [ -f "$SELF_HEAL_SCRIPT" ]; then
    echo "resolve-pipeline-cli.sh: @ai-sdlc/pipeline-cli missing in $CLAUDE_PLUGIN_DIR — attempting self-heal..." >&2
    if bash "$SELF_HEAL_SCRIPT" "$CLAUDE_PLUGIN_DIR" >&2; then
      CANDIDATE="$CLAUDE_PLUGIN_DIR/$PIPELINE_CLI_REL"
      if _is_usable "$CANDIDATE"; then
        echo "resolve-pipeline-cli.sh: self-heal succeeded" >&2
        printf '%s' "$CANDIDATE"
        exit 0
      fi
    fi
    echo "resolve-pipeline-cli.sh: self-heal did not produce a usable install — continuing fallback chain" >&2
  fi
fi

# ── Topology 3: CLAUDE_PLUGIN_ROOT set (always injected by Claude Code) ─────
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  CANDIDATE="$CLAUDE_PLUGIN_ROOT/$PIPELINE_CLI_REL"
  if _is_usable "$CANDIDATE"; then
    printf '%s' "$CANDIDATE"
    exit 0
  fi

  # CLAUDE_PLUGIN_ROOT is set but deps are missing — try self-heal here too.
  SELF_HEAL_SCRIPT="$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh"
  if [ -f "$SELF_HEAL_SCRIPT" ]; then
    echo "resolve-pipeline-cli.sh: @ai-sdlc/pipeline-cli missing in $CLAUDE_PLUGIN_ROOT — attempting self-heal..." >&2
    if bash "$SELF_HEAL_SCRIPT" "$CLAUDE_PLUGIN_ROOT" >&2; then
      CANDIDATE="$CLAUDE_PLUGIN_ROOT/$PIPELINE_CLI_REL"
      if _is_usable "$CANDIDATE"; then
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

  # Cache dirs exist but no @ai-sdlc/pipeline-cli found — try self-heal on the
  # newest version dir (so adopters who just installed get auto-repaired).
  NEWEST_DIR=""
  for marketplace_dir in "$CACHE_ROOT"/*/; do
    [ -d "$marketplace_dir" ] || continue
    PLUGIN_VERSIONS_DIR="${marketplace_dir}ai-sdlc"
    [ -d "$PLUGIN_VERSIONS_DIR" ] || continue
    for version_dir in "$PLUGIN_VERSIONS_DIR"/*/; do
      [ -d "$version_dir" ] || continue
      SELF_HEAL_SCRIPT="${version_dir%/}/scripts/install-runtime-deps.sh"
      if [ -f "$SELF_HEAL_SCRIPT" ]; then
        VERSION="$(basename "$version_dir")"
        # Pick newest among heal-capable dirs.
        if [ -z "$NEWEST_DIR" ] || \
           printf '%s\n%s\n' "$(basename "$NEWEST_DIR")" "$VERSION" | sort -rV | head -1 | grep -q "^$VERSION$"; then
          NEWEST_DIR="${version_dir%/}"
        fi
      fi
    done
  done

  if [ -n "$NEWEST_DIR" ]; then
    SELF_HEAL_SCRIPT="$NEWEST_DIR/scripts/install-runtime-deps.sh"
    echo "resolve-pipeline-cli.sh: trying self-heal in cache at $NEWEST_DIR ..." >&2
    if bash "$SELF_HEAL_SCRIPT" "$NEWEST_DIR" >&2; then
      CANDIDATE="$NEWEST_DIR/$PIPELINE_CLI_REL"
      if _is_usable "$CANDIDATE"; then
        echo "resolve-pipeline-cli.sh: self-heal (cache) succeeded" >&2
        printf '%s' "$CANDIDATE"
        exit 0
      fi
    fi
  fi
fi

# ── Topology 5: Monorepo dogfood fallback ───────────────────────────────────
DOGFOOD_BIN="$(pwd)/pipeline-cli/bin"
if _is_usable "$DOGFOOD_BIN"; then
  printf '%s' "$DOGFOOD_BIN"
  exit 0
fi

# ── Topology 6: Nothing found ────────────────────────────────────────────────
cat >&2 <<'EOF'
resolve-pipeline-cli.sh: ERROR — @ai-sdlc/pipeline-cli binary not found.

Tried all install topologies:
  1. $CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin  (marketplace install)
  2. $CLAUDE_PLUGIN_ROOT/node_modules/@ai-sdlc/pipeline-cli/bin (plugin root)
  3. ~/.claude/plugins/cache/*/ai-sdlc/*/node_modules/@ai-sdlc/pipeline-cli/bin (cache probe)
  4. $(pwd)/pipeline-cli/bin  (dogfood monorepo)

Fix options (choose one):
  A. Re-install the plugin via your marketplace:
       /claude plugin install ai-sdlc
       Then restart Claude Code.

  B. If using the local marketplace, run:
       bash ~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/<version>/scripts/install-runtime-deps.sh

  C. If running from the ai-sdlc monorepo, cd to the repo root before invoking /ai-sdlc execute.

  D. Override by exporting: export PIPELINE_CLI_BIN=/path/to/pipeline-cli/bin

See: ai-sdlc-plugin/README.md "Install topologies + path resolution"
EOF
exit 1
