#!/usr/bin/env bash
#
# AISDLC-119: Strict backlog-drift gate for pre-commit.
#
# Why this exists: `.husky/pre-commit` previously ran
# `npx backlog-drift hook-run`, which is *advisory* — it warns but never
# exits non-zero. Result: 223 drift issues accumulated across 152 tasks
# despite the hook running on every commit. This script replaces that
# advisory call with a strict per-task `backlog-drift check --task <id>`
# loop over only the staged-backlog-task slice of the diff, so a commit
# that introduces a dangling reference, invalid dependency ID, or orphan
# `(new)` placeholder fails immediately with an actionable fix command.
#
# Scope: STAGED additions/modifications under `backlog/tasks/*.md` only
# (filter `AM` — Added or Modified). Renames into the backlog/completed/
# archive go through `task_complete` and are excluded from drift gating
# here; the full-backlog CI step in `.github/workflows/ci.yml` is the
# net for repository-wide drift introduced by merges.
#
# Performance budget (AC #4): < 500ms for the typical 1-task commit.
# A single `backlog-drift check --task <id>` invocation is ~250ms cold
# under npx, so the typical 1-task path is ~300-400ms end to end.
# Multi-task commits scale linearly; that is intentional — the operator
# is staging more drift surface, so spending more time validating it is
# correct, and the wall-clock cost is dominated by the one process
# spawn per task rather than the check itself.
#
# Escape hatches (AC #5):
#   - `git commit --no-verify` — skips the entire `.husky/pre-commit`
#     pipeline (existing git behavior; the gate doesn't fight it).
#   - `AI_SDLC_SKIP_DRIFT_GATE=1 git commit ...` — short-circuits this
#     script with exit 0 while leaving lint-staged + typecheck +
#     ASCII-name checks active. Use only for emergencies (e.g. a known
#     drift-fix commit, or a refactor that intentionally breaks refs
#     mid-PR with the cleanup in a follow-up commit).
#
# Activation: invoked from `.husky/pre-commit`. The operator must wire
# it into the husky hook (the agent that authored AISDLC-119 was unable
# to edit `.husky/` directly under sandbox; this matches the precedent
# set by AISDLC-92's check-backlog-ascii.sh). Wiring snippet — replace
# the legacy `npx backlog-drift hook-run` call with:
#
#   ./scripts/check-backlog-drift.sh
#
# Exit codes:
#   0 — no staged backlog tasks, all staged tasks clean, or env var
#       short-circuit triggered.
#   1 — at least one staged task has drift errors. The script prints
#       the offending task IDs + the auto-fix command per failing task.

set -euo pipefail

# Escape-hatch short-circuit. Honored before any git work so a stuck
# operator can always commit.
if [ "${AI_SDLC_SKIP_DRIFT_GATE:-}" = "1" ]; then
  echo "[backlog-drift] AI_SDLC_SKIP_DRIFT_GATE=1 — skipping strict drift gate." >&2
  exit 0
fi

# Collect newly-added or modified backlog tasks in the staging area.
# `--diff-filter=AM` keeps Added + Modified, drops Renames (the archive
# move from tasks/ → completed/ is a Rename and the source-side path
# would otherwise look "deleted" to the per-task check). `-z` would be
# safer for unicode but AISDLC-92's check-backlog-ascii.sh already
# guarantees ASCII-only filenames in this directory, so newline-split
# is fine here.
staged_tasks=$(
  git diff --cached --name-only --diff-filter=AM -- 'backlog/tasks/*.md' || true
)

if [ -z "$staged_tasks" ]; then
  exit 0
fi

# Extract the task ID from each filename. Backlog.md filenames have the
# shape `<id-lowercase> - <slugified-title>.md` (e.g.
# `aisdlc-119 - Tighten-...-advisory.md`). We slice everything before
# the first ` - ` and uppercase the id prefix so it matches the form
# `backlog-drift check --task <id>` expects (AISDLC-119, not aisdlc-119).
task_ids=()
while IFS= read -r path; do
  base=$(basename "$path" .md)
  id_lower="${base%% - *}"
  # Uppercase via tr (portable across bash 3 / 4 / 5 + macOS BSD utils).
  id=$(printf '%s' "$id_lower" | tr '[:lower:]' '[:upper:]')
  task_ids+=("$id")
done <<< "$staged_tasks"

# Run `backlog-drift check --task <id>` per staged task and aggregate
# exit codes. We deliberately invoke once per task rather than batching
# because the CLI's `--task <id>` flag is the only documented per-task
# scope; running `check` with no flag scans the whole repo (slow, and
# would surface unrelated drift the operator isn't responsible for in
# this commit).
failures=()
for id in "${task_ids[@]}"; do
  # Single invocation: capture combined stdout+stderr AND the exit code.
  # We deliberately don't use `set -e` here — the `|| status=$?` pattern
  # keeps `set -e` from aborting the loop on the expected failing case.
  # No `--no-install`: a fresh worktree without the global `backlog-drift`
  # CLI must still be able to commit; `npx` will fetch on demand.
  output=$(npx backlog-drift check --task "$id" 2>&1) && status=0 || status=$?
  if [ "$status" -ne 0 ]; then
    failures+=("$id")
    echo "" >&2
    echo "[backlog-drift] $id has drift errors:" >&2
    echo "$output" | sed 's/^/  /' >&2
    echo "" >&2
    echo "  Run \`npx backlog-drift fix --task $id\` to auto-fix." >&2
  fi
done

if [ ${#failures[@]} -eq 0 ]; then
  exit 0
fi

{
  echo ""
  echo "[backlog-drift] Commit blocked: ${#failures[@]} staged task(s) have drift errors."
  echo ""
  echo "Fix options:"
  for id in "${failures[@]}"; do
    echo "  - npx backlog-drift fix --task $id   # auto-fix $id"
  done
  echo ""
  echo "Escape hatches (use sparingly):"
  echo "  - AI_SDLC_SKIP_DRIFT_GATE=1 git commit ...   # skip just this gate"
  echo "  - git commit --no-verify                     # skip every pre-commit hook"
  echo ""
} >&2

exit 1
