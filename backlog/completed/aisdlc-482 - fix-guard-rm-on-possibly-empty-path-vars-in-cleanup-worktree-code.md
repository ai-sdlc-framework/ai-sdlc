---
id: AISDLC-482
title: >-
  fix: guard rm -rf "$VAR/$x" on possibly-empty path vars so autonomous runs
  aren't blocked by the rm-safety prompt
status: Done
assignee: []
created_date: '2026-05-30 20:30'
labels:
  - bug
  - autonomy
  - safety
  - cleanup
  - worktree
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
During autonomous/--dangerously-skip-permissions operation, Claude Code's built-in safety guard still interrupts with prompts like `Dangerous rm operation on possibly-empty variable path: "$WT/$p"` whenever a script constructs `rm -rf "$SOMEVAR/$x"` where `$SOMEVAR` could be empty (which would expand to `rm -rf /$x` — a root-relative path wipeout). This blocks unattended operation even when permissions are otherwise skipped.

The framework's own cleanup and worktree code emits such patterns. Known sites include `ai-sdlc-plugin/commands/cleanup.md`, `ai-sdlc-plugin/commands/execute-parallel-cleanup.md`, and any `.worktrees/` removal logic or sign/reconcile temp-dir cleanup that constructs paths via variable concatenation. Each such site must be hardened: either guard the variable for non-emptiness before the `rm`, use an absolute-path assertion, or — where the target is a worktree — prefer `git worktree remove` over raw `rm -rf`.

The fix must also prevent regressions: a shellcheck rule or hermetic test should fail when a new `rm -rf "$VAR/` pattern is added without a preceding non-empty guard, and the pattern must be documented in CONTRIBUTING or a scripts/ README note so future contributors follow it automatically.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] AC-1: Audit all `rm -rf`/`rm -f "$VAR/..."` sites in `ai-sdlc-plugin/` scripts and command bodies and `scripts/`; produce an enumerated list of every site found.
- [ ] AC-2: Each identified site guards the variable before the `rm` — for example `[ -n "$VAR" ] || { echo "refusing rm: VAR empty" >&2; exit 1; }` immediately before the `rm` line — so the command can never expand to a root-relative path even if the variable is unset or empty.
- [ ] AC-3: Where the path is a worktree under `.worktrees/`, the removal uses `git worktree remove --force` instead of raw `rm -rf`; fall back to guarded `rm -rf` only when `git worktree remove` is not applicable (e.g. temp dirs outside the worktree list).
- [ ] AC-4: A hermetic test (e.g. a `scripts/check-rm-guard.test.mjs` shellcheck-style scan or a grep-based assertion) fails CI when a new `rm -rf "$` pattern is introduced without a preceding non-empty guard on the same variable in the same script block.
- [ ] AC-5: The guard pattern is documented in `CONTRIBUTING.md` or a `scripts/README.md` note (whichever already exists) so future contributors know the rule before writing new cleanup scripts.
<!-- AC:END -->

## References

- ai-sdlc-plugin/commands/cleanup.md
- ai-sdlc-plugin/commands/execute-parallel-cleanup.md
- ai-sdlc-plugin/commands/execute-parallel.md
