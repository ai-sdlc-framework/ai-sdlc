#!/usr/bin/env bash
# AISDLC-662.1: PR coverage that survives a PR being behind main.
#
# The CI coverage job runs on the pull_request MERGE ref (HEAD = merge commit,
# HEAD^1 = the base tip that merge was computed against, HEAD^2 = the PR head).
# `vitest --changed <HEAD^1>` therefore selects exactly the tests affected by the
# PR's own changes, however far main has moved since the merge ref was built.
#
# The previous step fetched `origin main` with --depth=1 and ran
# `--changed origin/main`; for a PR behind main that diffs against the CURRENT
# tip, selects zero test files, exits 0 ("No test files found"), and the
# `|| pnpm test:coverage` fallback never ran, so the patch-coverage gate saw no
# coverage data. This script fixes the base and also falls back to the full run
# when the changed-only run selects no tests although source files changed.
#
# Never loosens the gate: the 80% patch-coverage check runs unchanged afterwards.
set -uo pipefail

full() {
  echo "[pr-coverage] $1; running full coverage"
  exec pnpm test:coverage
}

base="$(git rev-parse --verify --quiet HEAD^1 || true)"
[ -n "$base" ] || full "no HEAD^1 (not a merge ref)"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

pnpm -r exec -- vitest run --coverage --changed "$base" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] || full "changed-only run failed (exit $rc)"

changed_src="$(git diff --name-only "$base" HEAD | grep -E '\.(ts|tsx|mjs|js)$' | grep -Ev '\.(test|spec)\.' | grep -c . || true)"
ran="$(grep -c 'Test Files' "$log" || true)"
if [ "$changed_src" -gt 0 ] && [ "$ran" -eq 0 ]; then
  full "changed-only run selected no tests although $changed_src source file(s) changed"
fi
echo "[pr-coverage] changed-only run vs $base OK (${changed_src} source file(s), ${ran} test summary line(s))"
