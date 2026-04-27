#!/usr/bin/env bash
# Pre-push coverage gate: runs `pnpm test:coverage` across the workspace and
# fails if any package's `coverage/coverage-summary.json` reports `lines.pct`
# below the 80% codecov patch target. Mirrors the codecov gate so we catch
# regressions locally instead of after the PR is opened.
#
# Skip with `AI_SDLC_SKIP_COVERAGE_GATE=1 git push`. Use sparingly — the gate
# exists because PR #67 hit 79.84% silently.

set -euo pipefail

if [ "${AI_SDLC_SKIP_COVERAGE_GATE:-}" = "1" ]; then
  echo "[coverage-gate] skipped (AI_SDLC_SKIP_COVERAGE_GATE=1)"
  exit 0
fi

THRESHOLD="${AI_SDLC_COVERAGE_THRESHOLD:-80}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[coverage-gate] running pnpm test:coverage (threshold: ${THRESHOLD}% lines)"
cd "$ROOT"

# Run silently unless it fails — coverage output is verbose.
if ! pnpm -r test:coverage > /tmp/ai-sdlc-coverage.log 2>&1; then
  echo "[coverage-gate] FAIL: test:coverage exited non-zero. Last 60 lines:"
  tail -60 /tmp/ai-sdlc-coverage.log
  exit 1
fi

# Walk every package's coverage-summary.json. Each package's vitest writes one.
FAILED=0
while IFS= read -r summary; do
  PKG="$(dirname "$(dirname "$summary")" | sed "s|^${ROOT}/||")"
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

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "[coverage-gate] One or more packages below the ${THRESHOLD}% threshold."
  echo "[coverage-gate] Add tests, or skip with AI_SDLC_SKIP_COVERAGE_GATE=1 (not recommended)."
  exit 1
fi

echo "[coverage-gate] all packages above ${THRESHOLD}% lines coverage"
