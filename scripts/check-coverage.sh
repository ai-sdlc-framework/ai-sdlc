#!/usr/bin/env bash
# Pre-push coverage gate: runs `pnpm test:coverage` for affected workspace
# packages and fails if any package's `coverage/coverage-summary.json` reports
# `lines.pct` below the 80% codecov patch target. Uses pnpm's native
# `--filter "...[origin/main]"` to skip unaffected packages on non-cross-cutting
# pushes. Mirrors the codecov gate so we catch regressions locally instead of
# after the PR is opened.
#
# Skip with `AI_SDLC_SKIP_COVERAGE_GATE=1 git push`. Use sparingly — the gate
# exists because PR #67 hit 79.84% silently.

set -euo pipefail

if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[coverage-gate] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

if [ "${AI_SDLC_SKIP_COVERAGE_GATE:-}" = "1" ]; then
  echo "[coverage-gate] skipped (AI_SDLC_SKIP_COVERAGE_GATE=1)"
  exit 0
fi

THRESHOLD="${AI_SDLC_COVERAGE_THRESHOLD:-80}"
# AI_SDLC_WORKSPACE_ROOT allows tests to override the workspace root so
# hermetic tests can point find/git at a scratch directory.
if [ -n "${AI_SDLC_WORKSPACE_ROOT:-}" ]; then
  ROOT="${AI_SDLC_WORKSPACE_ROOT}"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

# ── AC-1: docs-only short-circuit ────────────────────────────────────────────
# Derive push range from pre-push stdin (format: "<local-ref> <local-sha>
# <remote-ref> <remote-sha>"). If stdin is a tty (manual invocation), skip
# the docs-only check and proceed normally.
DOCS_ONLY="false"
if [ ! -t 0 ]; then
  # Read the first push record from stdin and extract local/remote SHAs.
  # Git pre-push hooks pass stdin in the format:
  #   "<local-ref> <local-sha> <remote-ref> <remote-sha>\n"
  # Multiple refs can appear (e.g. force-push with multiple branches), but
  # for a single-branch push there is exactly one line. We only need the
  # first record to determine the changeset.
  IFS=' ' read -r _LOCAL_REF LOCAL_SHA _REMOTE_REF REMOTE_SHA || true
  # Use the remote SHA as the diff base; fall back to origin/main when
  # the remote ref is all-zeros (new branch with no upstream yet).
  BASE_SHA="${REMOTE_SHA:-}"
  if [ -z "$BASE_SHA" ] || [ "$BASE_SHA" = "0000000000000000000000000000000000000000" ]; then
    BASE_SHA="origin/main"
  fi
  if [ -n "${LOCAL_SHA:-}" ] && [ "$LOCAL_SHA" != "0000000000000000000000000000000000000000" ]; then
    CHANGED_FILES="$(git -c core.quotePath=false diff --name-only "${BASE_SHA}" "${LOCAL_SHA}" 2>/dev/null || true)"
    if [ -n "$CHANGED_FILES" ]; then
      DOCS_ONLY="$(printf '%s\n' "$CHANGED_FILES" | node "${ROOT}/scripts/is-docs-only-changeset.mjs")"
    fi
  fi
fi

if [ "$DOCS_ONLY" = "true" ]; then
  echo "[coverage-gate] docs-only changeset — skipping"
  exit 0
fi

echo "[coverage-gate] running pnpm test:coverage (threshold: ${THRESHOLD}% lines)"
cd "$ROOT"

# ── AC-2/3: Build + test:coverage for affected packages only ─────────────────
# Use pnpm's native affected-package filter so a 5-line bash-script PR does
# not re-build and re-test the entire workspace. Cross-cutting changes (e.g.
# package.json, pnpm-workspace.yaml) will cause pnpm to include all packages.
#
# Build all affected workspace packages first so dist artifacts are present.
# Several packages (orchestrator, sdk-typescript, dogfood) import from
# workspace dependencies via their compiled dist/ exports. Without a prior
# build, vitest can't resolve those imports and the tests fail or time out.
# This was the root cause of AISDLC-212 (dogfood exports.test.ts timing out
# under concurrent pnpm -r when dist/ was missing).
echo "[coverage-gate] building affected packages before coverage run..."
if ! pnpm --filter "...[origin/main]" build > /tmp/ai-sdlc-build.log 2>&1; then
  echo "[coverage-gate] FAIL: pre-coverage build failed. Last 30 lines:"
  tail -30 /tmp/ai-sdlc-build.log
  exit 1
fi

# Run silently unless it fails — coverage output is verbose.
if ! pnpm --filter "...[origin/main]" test:coverage > /tmp/ai-sdlc-coverage.log 2>&1; then
  echo "[coverage-gate] FAIL: test:coverage exited non-zero. Last 60 lines:"
  tail -60 /tmp/ai-sdlc-coverage.log
  exit 1
fi

# ── AC-4: derive the set of packages pnpm actually built ─────────────────────
# Use `pnpm --filter "...[origin/main]" list --json --depth -1` to get the
# exact package list pnpm would touch. This avoids walking coverage files for
# packages that were not in scope (avoids false-positive failures from stale
# coverage/coverage-summary.json files left by prior full runs).
AFFECTED_PKGS_JSON="$(pnpm --filter "...[origin/main]" list --json --depth -1 2>/dev/null || echo '[]')"
# Extract package paths (the "path" field in each JSON object).
# Store paths in a temp file to avoid bash 3 mapfile incompatibility.
AFFECTED_PATHS_FILE="$(mktemp /tmp/ai-sdlc-affected-pkgs.XXXXXX)"
PKGS_JSON="$AFFECTED_PKGS_JSON" node -e "
  const pkgs = JSON.parse(process.env.PKGS_JSON);
  for (const pkg of pkgs) {
    if (pkg.path) process.stdout.write(pkg.path + '\n');
  }
" > "$AFFECTED_PATHS_FILE"

# Count lines so we know if the list is non-empty.
AFFECTED_COUNT="$(wc -l < "$AFFECTED_PATHS_FILE" | tr -d ' ')"

# Walk every package's coverage-summary.json. Each package's vitest writes one.
# Only check coverage for packages that pnpm's filter actually built.
FAILED=0
WALKED=0
while IFS= read -r summary; do
  # Resolve the package root (two levels up from coverage/coverage-summary.json).
  PKG_ROOT="$(cd "$(dirname "$(dirname "$summary")")" && pwd)"
  PKG="$(echo "$PKG_ROOT" | sed "s|^${ROOT}/||")"

  # If we have an affected set, skip packages not in it.
  if [ "$AFFECTED_COUNT" -gt 0 ] && ! grep -qxF "$PKG_ROOT" "$AFFECTED_PATHS_FILE"; then
    continue
  fi

  WALKED=$((WALKED + 1))
  PCT="$(node -e "
    const d = require('$summary');
    const pct = d.total && d.total.lines ? d.total.lines.pct : null;
    process.stdout.write(pct === null ? 'null' : String(pct));
  ")"
  if [ "$PCT" = "null" ]; then
    continue
  fi
  # Compare as floats via awk.
  BELOW="$(awk -v p="$PCT" -v t="$THRESHOLD" 'BEGIN{print (p<t)?1:0}')"
  if [ "$BELOW" = "1" ]; then
    echo "[coverage-gate] FAIL: ${PKG} lines coverage ${PCT}% < ${THRESHOLD}%"
    FAILED=1
  else
    echo "[coverage-gate] OK:   ${PKG} lines coverage ${PCT}%"
  fi
done < <(find "$ROOT" -path "*/coverage/coverage-summary.json" \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*")

rm -f "$AFFECTED_PATHS_FILE"

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "[coverage-gate] One or more packages below the ${THRESHOLD}% threshold."
  echo "[coverage-gate] Add tests, or skip with AI_SDLC_SKIP_COVERAGE_GATE=1 (not recommended)."
  exit 1
fi

echo "[coverage-gate] all checked packages above ${THRESHOLD}% lines coverage (${WALKED} walked)"
