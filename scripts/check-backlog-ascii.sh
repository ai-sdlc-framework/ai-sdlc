#!/usr/bin/env bash
#
# AISDLC-92: Reject commits that introduce non-ASCII characters in backlog
# task filenames.
#
# Why this exists: Backlog.md derives task filenames from titles without
# sanitizing unicode. When a title contained `—` (em-dash) or `→`
# (rightwards-arrow), the resulting filename was UTF-8. The verifier's
# `git diff --name-only` (run with default `core.quotepath=true`)
# octal-escaped + double-quoted those paths, which broke the chore-commit
# allowlist regex (anchored on `^backlog`). The verifier was hardened in
# the same patch (`-c core.quotepath=false`); this script is the
# defense-in-depth layer that keeps unicode out of new filenames so we
# don't depend on every git consumer setting that flag correctly.
#
# Scope: only checks STAGED additions/renames (`A` + `R`) so existing
# legacy files in `backlog/completed/` (committed before this hook
# landed) don't block unrelated commits.
#
# Activation: invoked from `.husky/pre-commit`. Operator must wire it
# into the husky hook (the agent that authored AISDLC-92 was unable to
# edit `.husky/` directly under sandbox; the wiring is an operator
# follow-up). Wiring snippet:
#
#   ./scripts/check-backlog-ascii.sh
#
# Remove once upstream Backlog.md sanitizes slug derivation.
#
# Exit codes:
#   0 — no violations (or no staged backlog filenames)
#   1 — at least one staged add/rename touched a non-ASCII backlog filename

set -euo pipefail

# `-c core.quotepath=false` is required: without it, git emits non-ASCII
# paths octal-escaped + double-quoted (e.g. `"backlog/.../...\342\200\224..."`),
# and our non-ASCII detector would NEVER match — the offending bytes are
# themselves ASCII (`\342\200\224` are all in 0x00-0x7F). This is the
# same root cause AISDLC-92 fixed in `verify-attestation.mjs`.
#
# We use `awk '/[\200-\377]/'` rather than `grep -P` for portability:
# BSD grep (the default on macOS) doesn't support `-P` (PCRE), but awk
# is required by POSIX. `LC_ALL=C` keeps awk in single-byte mode so the
# bracket expression matches raw bytes, not multibyte codepoints.
unicode_backlog_paths=$(
  git -c core.quotepath=false diff --cached --name-only --diff-filter=AR -- \
    'backlog/tasks/*.md' 'backlog/completed/*.md' \
    | LC_ALL=C awk '/[\200-\377]/' || true
)

if [ -z "$unicode_backlog_paths" ]; then
  exit 0
fi

{
  echo ""
  echo "ERROR: backlog filenames must be ASCII-only (AISDLC-92)."
  echo ""
  echo "Offending paths:"
  echo "$unicode_backlog_paths" | sed 's/^/  - /'
  echo ""
  echo "Rename via 'git mv \"<offending>\" \"<ascii-equivalent>\"' before committing."
  echo "Backlog.md auto-derives filenames from task titles; either retitle the"
  echo "task (mcp__backlog__task_edit), or rename the file directly."
} >&2

exit 1
