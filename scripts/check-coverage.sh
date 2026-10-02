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

# ── AISDLC-681: resource safety ──────────────────────────────────────────────
# 1. Every pnpm run executes in its own process group via run-in-process-group.mjs
#    so a killed hook cannot orphan vitest workers (reparented to pid 1).
# 2. Hard wall-clock timeout (a timeout is a FAIL, never a pass).
# 3. Worker ceiling for the vitest run (explicit --maxWorkers wins over the
#    AI_SDLC_VITEST_MAX_WORKERS default read by the shared vitest preset).
# 4. Repo-wide lock under the MAIN checkout's .ai-sdlc/ so concurrent pushes
#    from sibling worktrees queue instead of running in parallel.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="${SCRIPT_DIR}/run-in-process-group.mjs"

is_posint() { case "${1:-}" in ''|*[!0-9]*|0|0[0-9]*) return 1 ;; *) return 0 ;; esac; }

TIMEOUT_SEC="${AI_SDLC_COVERAGE_TIMEOUT_SEC:-900}"
if ! is_posint "$TIMEOUT_SEC"; then
  echo "[coverage-gate] ignoring invalid AI_SDLC_COVERAGE_TIMEOUT_SEC='${TIMEOUT_SEC}'; using 900" >&2
  TIMEOUT_SEC=900
fi

NCPU="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
is_posint "$NCPU" || NCPU=2
DEFAULT_WORKERS=$((NCPU / 2))
[ "$DEFAULT_WORKERS" -gt 4 ] && DEFAULT_WORKERS=4
[ "$DEFAULT_WORKERS" -lt 1 ] && DEFAULT_WORKERS=1
MAX_WORKERS="${AI_SDLC_COVERAGE_MAX_WORKERS:-$DEFAULT_WORKERS}"
if ! is_posint "$MAX_WORKERS"; then
  echo "[coverage-gate] ignoring invalid AI_SDLC_COVERAGE_MAX_WORKERS='${MAX_WORKERS}'; using ${DEFAULT_WORKERS}" >&2
  MAX_WORKERS="$DEFAULT_WORKERS"
fi

# Lock root: the MAIN checkout's .ai-sdlc/ (git-common-dir's parent), not the
# worktree. AI_SDLC_COVERAGE_LOCK_DIR overrides it (hermetic tests).
if [ -n "${AI_SDLC_COVERAGE_LOCK_DIR:-}" ]; then
  LOCK_ROOT="$AI_SDLC_COVERAGE_LOCK_DIR"
else
  COMMON_DIR="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$COMMON_DIR" ] && [ -d "$COMMON_DIR" ]; then
    LOCK_ROOT="$(dirname "$COMMON_DIR")/.ai-sdlc/runtime"
  else
    LOCK_ROOT="${ROOT}/.ai-sdlc/runtime"
  fi
fi
LOCK_DIR="${LOCK_ROOT}/coverage-gate.lock"
LOCK_POLL_SEC="${AI_SDLC_COVERAGE_LOCK_POLL_SEC:-2}"
is_posint "$LOCK_POLL_SEC" || LOCK_POLL_SEC=2

RUNNER_PID=""
HAVE_LOCK=0
CLEANED=0
AFFECTED_PATHS_FILE=""

# Idempotent cleanup: stop the runner (which kills its process group), release
# our lock, remove temp files. Safe to call from EXIT and from signal traps.
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  if [ -n "$RUNNER_PID" ]; then
    kill -TERM "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
    RUNNER_PID=""
  fi
  if [ "$HAVE_LOCK" = "1" ]; then
    release_lock
  fi
  if [ -n "$AFFECTED_PATHS_FILE" ]; then
    rm -f "$AFFECTED_PATHS_FILE" 2>/dev/null || true
  fi
}

# The lock's owner file is DATA (pid/host/worktree/time) — never sourced or eval'd.
lock_owner_field() { # <field-index> ; prints the Nth tab-separated field of the owner file
  [ -f "${LOCK_DIR}/owner" ] && [ ! -L "${LOCK_DIR}/owner" ] || return 0
  IFS=$'\t' read -r _f1 _f2 _f3 _f4 < "${LOCK_DIR}/owner" 2>/dev/null || true
  case "$1" in 1) printf '%s' "${_f1:-}" ;; 2) printf '%s' "${_f2:-}" ;; 3) printf '%s' "${_f3:-}" ;; 4) printf '%s' "${_f4:-}" ;; esac
}

release_lock() {
  HAVE_LOCK=0
  # Only remove a lock we still own (a reclaimer may have replaced it).
  if [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] && [ "$(lock_owner_field 1)" = "$$" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  fi
}

lock_is_stale() {
  local owner_pid owner_host lock_mtime now age
  owner_pid="$(lock_owner_field 1)"
  owner_host="$(lock_owner_field 2)"
  now="$(date +%s)"
  lock_mtime="$(node -e 'try{process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000)))}catch{}' "$LOCK_DIR" 2>/dev/null || true)"
  if [ -n "$lock_mtime" ]; then
    age=$((now - lock_mtime))
    [ "$age" -gt "$TIMEOUT_SEC" ] && return 0
  fi
  # Holder on this host that is no longer running: reclaim immediately.
  if is_posint "$owner_pid" && [ "$owner_host" = "$(hostname 2>/dev/null || echo unknown)" ]; then
    kill -0 "$owner_pid" 2>/dev/null || return 0
  fi
  return 1
}

acquire_lock() {
  mkdir -p "$LOCK_ROOT"
  local waited=0 announced=-1
  while :; do
    if [ -L "$LOCK_DIR" ]; then
      echo "[coverage-gate] FAIL: lock path ${LOCK_DIR} is a symlink; refusing to use it" >&2
      return 1
    fi
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\t%s\t%s\t%s\n' "$$" "$(hostname 2>/dev/null || echo unknown)" "$ROOT" "$(date +%s)" > "${LOCK_DIR}/owner"
      HAVE_LOCK=1
      return 0
    fi
    if [ -d "$LOCK_DIR" ] && lock_is_stale; then
      echo "[coverage-gate] reclaiming stale lock (holder pid $(lock_owner_field 1))" >&2
      local trash="${LOCK_ROOT}/coverage-gate.lock.stale.$$.$(date +%s)"
      if mv "$LOCK_DIR" "$trash" 2>/dev/null; then
        rm -rf "$trash" 2>/dev/null || true
      fi
      continue
    fi
    if [ "$waited" -ge "$TIMEOUT_SEC" ]; then
      echo "[coverage-gate] FAIL: timed out after ${TIMEOUT_SEC}s waiting for the coverage-gate lock held by pid $(lock_owner_field 1) (${LOCK_DIR})" >&2
      return 1
    fi
    if [ $((waited / 30)) -ne "$announced" ]; then
      announced=$((waited / 30))
      echo "[coverage-gate] waiting for coverage-gate lock held by pid $(lock_owner_field 1) on $(lock_owner_field 2) (worktree $(lock_owner_field 3), since epoch $(lock_owner_field 4))" >&2
    fi
    sleep "$LOCK_POLL_SEC"
    waited=$((waited + LOCK_POLL_SEC))
  done
}

# Run a command in its own process group with the timeout; output goes to a log.
# Backgrounded + `wait` so bash can run the signal traps promptly.
run_grouped() { # <logfile> <cmd...> ; returns the command's status (124 = timeout)
  local log="$1"; shift
  node "$RUNNER" --timeout-sec "$TIMEOUT_SEC" --log "$log" -- "$@" &
  RUNNER_PID=$!
  local rc=0
  wait "$RUNNER_PID" || rc=$?
  RUNNER_PID=""
  return "$rc"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP

acquire_lock || exit 1

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
# AISDLC-390: include always-on foundation packages so dependents-of-changed
# can resolve their workspace imports against built dist/. See ci.yml comment
# above the "Build (affected + always-on foundations)" step for full rationale.
BUILD_RC=0
run_grouped /tmp/ai-sdlc-build.log \
  pnpm --filter "...[origin/main]" \
       --filter "@ai-sdlc/orchestrator" \
       --filter "@ai-sdlc/pipeline-cli" \
       --filter "@ai-sdlc/reference" \
       build || BUILD_RC=$?
if [ "$BUILD_RC" = "124" ]; then
  echo "[coverage-gate] FAIL: pre-coverage build TIMEOUT after ${TIMEOUT_SEC}s (AI_SDLC_COVERAGE_TIMEOUT_SEC); process group killed. Last 30 lines:"
  tail -30 /tmp/ai-sdlc-build.log
  exit 1
elif [ "$BUILD_RC" != "0" ]; then
  echo "[coverage-gate] FAIL: pre-coverage build failed. Last 30 lines:"
  tail -30 /tmp/ai-sdlc-build.log
  exit 1
fi

# Run silently unless it fails — coverage output is verbose.
COV_RC=0
run_grouped /tmp/ai-sdlc-coverage.log \
  pnpm --filter "...[origin/main]" test:coverage --maxWorkers="${MAX_WORKERS}" || COV_RC=$?
if [ "$COV_RC" = "124" ]; then
  echo "[coverage-gate] FAIL: test:coverage TIMEOUT after ${TIMEOUT_SEC}s (AI_SDLC_COVERAGE_TIMEOUT_SEC); process group killed. Last 60 lines:"
  tail -60 /tmp/ai-sdlc-coverage.log
  exit 1
elif [ "$COV_RC" != "0" ]; then
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
# AISDLC-395: pnpm's git-ref filter exits 0 with EMPTY stdout when no packages
# match (e.g. when running from a git worktree where the diff detection has
# trouble resolving origin/main). The `|| echo '[]'` only fires on non-zero
# exit; empty-stdout-with-exit-0 falls through and JSON.parse('') throws.
# Treat empty stdout the same as the explicit empty array.
if [ -z "$AFFECTED_PKGS_JSON" ]; then
  AFFECTED_PKGS_JSON='[]'
fi
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

[ -n "$AFFECTED_PATHS_FILE" ] || { echo "[coverage-gate] refusing rm: AFFECTED_PATHS_FILE empty" >&2; exit 1; }
rm -f "$AFFECTED_PATHS_FILE"

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "[coverage-gate] One or more packages below the ${THRESHOLD}% threshold."
  echo "[coverage-gate] Add tests, or skip with AI_SDLC_SKIP_COVERAGE_GATE=1 (not recommended)."
  exit 1
fi

echo "[coverage-gate] all checked packages above ${THRESHOLD}% lines coverage (${WALKED} walked)"
