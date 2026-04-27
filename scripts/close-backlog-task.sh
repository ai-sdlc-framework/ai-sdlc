#!/usr/bin/env bash
# Close a backlog task: flip status to Done in the frontmatter, then git-mv
# the file from backlog/tasks/ to backlog/completed/.
#
# Mirrors what `mcp__backlog__task_complete` does, but as a shell script so the
# GitHub Actions workflow can invoke it after a PR with `(AISDLC-N)` in its title
# merges. Stages the changes; the caller is responsible for committing/pushing.
#
# Usage: ./scripts/close-backlog-task.sh AISDLC-68 [--final-summary "..."]
#
# Exit codes:
#   0 — task moved successfully
#   1 — task ID malformed or task file not found
#   2 — task is already in backlog/completed/ (idempotent no-op)

set -euo pipefail

TASK_ID="${1:-}"
SUMMARY=""
shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --final-summary)
      SUMMARY="$2"
      shift 2
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TASK_ID" ]; then
  echo "Usage: $0 <task-id> [--final-summary \"...\"]" >&2
  exit 1
fi

# Match AISDLC-N or task-N (Backlog.md's own naming convention).
if ! [[ "$TASK_ID" =~ ^(AISDLC|TASK|task)-[0-9]+(\.[0-9]+)?$ ]]; then
  echo "Malformed task ID: $TASK_ID (expected AISDLC-N or task-N)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DIR="${REPO_ROOT}/backlog/tasks"
COMPLETED_DIR="${REPO_ROOT}/backlog/completed"

LOWER="$(echo "$TASK_ID" | tr '[:upper:]' '[:lower:]')"

# Glob-match: tasks include a slug suffix like `aisdlc-68 - Documentation-...md`.
shopt -s nullglob
TASK_FILES=( "${TASKS_DIR}/${LOWER}"* )
COMPLETED_FILES=( "${COMPLETED_DIR}/${LOWER}"* )

if [ "${#COMPLETED_FILES[@]}" -gt 0 ] && [ "${#TASK_FILES[@]}" -eq 0 ]; then
  echo "[close-backlog-task] ${TASK_ID} is already in backlog/completed/ — no-op"
  exit 2
fi

if [ "${#TASK_FILES[@]}" -eq 0 ]; then
  echo "[close-backlog-task] No task file matching ${LOWER}* in ${TASKS_DIR}" >&2
  exit 1
fi
if [ "${#TASK_FILES[@]}" -gt 1 ]; then
  echo "[close-backlog-task] Multiple files match ${LOWER}*: ${TASK_FILES[*]}" >&2
  exit 1
fi

SRC="${TASK_FILES[0]}"
FILENAME="$(basename "$SRC")"
DEST="${COMPLETED_DIR}/${FILENAME}"

mkdir -p "$COMPLETED_DIR"

# Flip status: Done in frontmatter.
# Match `status: <anything>` between two frontmatter `---` markers and replace.
# Use sed POSIX-portable form (BSD on macOS / GNU on Linux behave the same here).
TMP="$(mktemp)"
awk -v new_status="Done" '
  BEGIN { in_fm = 0; fm_count = 0 }
  /^---$/ {
    fm_count++
    if (fm_count == 1) in_fm = 1
    else if (fm_count == 2) in_fm = 0
    print
    next
  }
  in_fm && /^status:/ {
    print "status: " new_status
    next
  }
  { print }
' "$SRC" > "$TMP"
mv "$TMP" "$SRC"

# Append final-summary section if provided and not already present.
if [ -n "$SUMMARY" ] && ! grep -q "^## Final Summary" "$SRC"; then
  printf '\n## Final Summary\n\n%s\n' "$SUMMARY" >> "$SRC"
fi

git mv "$SRC" "$DEST"

echo "[close-backlog-task] Moved ${TASK_ID}: ${FILENAME}"
echo "[close-backlog-task] backlog/tasks/${FILENAME} → backlog/completed/${FILENAME}"
