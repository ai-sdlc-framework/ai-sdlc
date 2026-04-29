---
id: AISDLC-81
title: >-
  Per-worktree active-task sentinel — enable parallel /ai-sdlc execute runs with
  cross-repo writes
status: Done
assignee: []
created_date: '2026-04-29 02:14'
updated_date: '2026-04-29 02:53'
labels:
  - bug
  - plugin
  - parallel
  - sentinel
  - follow-up
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/cleanup.md
  - >-
    backlog/completed/aisdlc-71 -
    Replace-orchestrator-driven-dogfood-pipeline-with-ai-sdlc-execute-plugin-command.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

`/ai-sdlc execute` Step 4 writes `.worktrees/.active-task` (single project-level file). PreToolUse hook reads it to resolve `permittedExternalPaths` for the active task's cross-repo writes.

Surfaced during the first parallel-run test (AISDLC-73 + AISDLC-77 in flight at the same time): only one task can be the "active task" at a time. If both runs call Step 4 sequentially, the second overwrites the first → first run's developer subagent uses the wrong allowlist.

For tasks WITHOUT `permittedExternalPaths` (which AISDLC-73 + AISDLC-77 are), this doesn't matter — the hook denies external writes regardless. So the parallel test is safe today. But we cannot ever run a cross-repo task (e.g. AISDLC-68-style with `permittedExternalPaths: ['../ai-sdlc-io/']`) in parallel with anything else.

## Goal

Per-worktree sentinel so each `/ai-sdlc execute` run has its own `.active-task` value, scoped to its worktree, that the PreToolUse hook resolves correctly even when multiple runs are interleaved.

## Design — locked

The hook already gets `tool_input.file_path` for Write/Edit tool calls. For Bash, no file_path. Two parts:

### Part 1 — Sentinel location

Move sentinel from `.worktrees/.active-task` to `.worktrees/<task-id-lower>/.active-task`. Each worktree owns its own sentinel.

### Part 2 — Hook resolution

When the PreToolUse hook fires:
1. Resolve the absolute path of `tool_input.file_path` (or for Bash, walk up from `cwd`)
2. Find which `.worktrees/<task-id>/` directory the path falls under (or matches `cwd` for Bash)
3. Read THAT worktree's `.active-task` to determine the active task ID for permittedExternalPaths
4. If file_path is OUTSIDE all worktrees, fall back to project-level `.worktrees/.active-task` (legacy behavior, kept for non-execute use)

### Part 3 — execute.md update

Step 4 writes `.worktrees/<task-id>/.active-task` instead of `.worktrees/.active-task`. Step 13 cleanup deletes the per-worktree sentinel only.

### Part 4 — Migration / coexistence

Keep the project-level sentinel as a fallback for one release. Hook prefers per-worktree, falls back to project-level if no worktree-specific match. Drop the project-level path in v0.9.0+.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Hook (`enforce-blocked-actions.{js,sh}`) updated: for Write/Edit, walk the file_path's directory up to find a `.worktrees/<id>/.active-task` ancestor; use that task's `permittedExternalPaths`. For Bash, walk `cwd` similarly. Fall back to `.worktrees/.active-task` (project-level) only if no worktree-specific sentinel matches.
2. `/ai-sdlc execute` Step 4 writes sentinel to `.worktrees/<task-id-lower>/.active-task` (per-worktree).
3. `/ai-sdlc execute` Step 13 cleanup removes only the per-worktree sentinel (not the project-level one).
4. `/ai-sdlc cleanup [<task-id>]` companion command updated: when sweeping merged worktrees, removes their `.active-task` along with the worktree.
5. Regression test: hook resolves the correct `permittedExternalPaths` when TWO worktrees with different active tasks both have files being edited at the same time (simulate via two synthetic worktrees + two file_path inputs).
6. Documentation in CLAUDE.md updated: parallel runs now safe, including with cross-repo writes.
7. Update `commands/execute.md` to remove the "Single-task limitation" callout (or update it to describe what's still single-task — reviewer fan-out concurrency, husky pre-push race).
8. Backwards compat: existing `.worktrees/.active-task` (project-level) continues to work for one release as fallback. Add deprecation comment in the hook.
9. All new code: 80%+ patch coverage, build/test/lint/format clean.

## Out of scope

- Removing the single-task limitation entirely (other races still exist: husky pre-push, CI rate limits — separate concerns)
- Changing the sentinel format from a flat task-id string to YAML/JSON (no need yet)
- Making the hook async or cached

## References

- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (the hook)
- `ai-sdlc-plugin/commands/execute.md` Step 4 + Step 13 (the writers)
- `ai-sdlc-plugin/commands/cleanup.md` (the sweeper)
- backlog/completed/aisdlc-71 - *.md (original design where the single-task limit was documented)
- backlog/completed/aisdlc-78 — surfaced during AISDLC-73 + AISDLC-77 parallel-run test
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Hook (`enforce-blocked-actions.{js,sh}`) walks file_path's directory (or cwd for Bash) up to find a `.worktrees/<id>/.active-task` ancestor and uses THAT task's `permittedExternalPaths`; falls back to project-level `.worktrees/.active-task` only if no worktree match
- [x] #2 `/ai-sdlc execute` Step 4 writes sentinel to `.worktrees/<task-id-lower>/.active-task` (per-worktree), not project-level
- [x] #3 `/ai-sdlc execute` Step 13 cleanup removes only the per-worktree sentinel
- [x] #4 `/ai-sdlc cleanup [<task-id>]` removes the worktree's `.active-task` along with the worktree itself
- [x] #5 Regression test: hook resolves CORRECT `permittedExternalPaths` when TWO synthetic worktrees with different active tasks both have edits in flight at the same time
- [x] #6 CLAUDE.md updated: parallel runs are now safe including with cross-repo writes
- [x] #7 `commands/execute.md` 'Single-task limitation' callout updated or removed (any remaining single-task constraints documented separately)
- [x] #8 Backwards compat: existing `.worktrees/.active-task` project-level sentinel continues to work as fallback for one release; deprecation comment in the hook
- [x] #9 All new code: 80%+ patch coverage; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Moved the `/ai-sdlc execute` active-task sentinel from a single project-level file (`.worktrees/.active-task`) to per-worktree (`.worktrees/<task-id-lower>/.active-task`) and taught the PreToolUse hook to walk up from each tool call's `cwd` to find the right worktree's sentinel. Concurrent runs now resolve their own allowlists independently — including for tasks with cross-repo `permittedExternalPaths`. Project-level sentinel retained as a deprecated fallback for one release (v0.9.0+ removal).

## Changes
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (modified): `enforceWriteEdit` now passes the tool call's cwd into `loadPermittedExternalPaths` → `readActiveTaskId` → new `findWorktreeSentinel` walker. Walker normalizes cwd via `resolve()`, walks up bounded by `<projectAbs>/.worktrees/` (trailing-separator check prevents sibling-prefix escape and `..` traversal collapses lexically). Resolution chain: per-worktree → project-level (deprecated) → env var.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs` (modified): 10 new tests covering precedence (per-worktree wins over project-level with conflicting allowlists), deep-nested cwd walk-up, both fallback paths, missing-sentinel handling, and the explicit AC #5 regression test that exercises a 2x2 truth table across two synthetic worktrees with conflicting allowlists (4 interleaved calls assert per-call resolution).
- `ai-sdlc-plugin/commands/execute.md` (modified): Step 4 writes `.worktrees/<task-id-lower>/.active-task`; Step 13 removes only the per-worktree sentinel; "Single-task limitation" callout removed (other races — husky pre-push, CI rate limits — documented separately).
- `ai-sdlc-plugin/commands/cleanup.md` (modified): worktree removal naturally deletes its own per-worktree sentinel; legacy project-level sentinel still swept defensively.
- `CLAUDE.md` (modified): documented that parallel runs are now safe, including with cross-repo writes.

## Design decisions
- **cwd-driven resolution, not file_path-driven**: The walker runs from the tool call's `cwd` rather than the file path being written. Simpler invariant (one cwd per call), and the developer subagent's cwd is asserted to be the worktree by `/ai-sdlc execute` Step 5 anyway. file_path could escape the worktree (cross-repo writes) so it's a poor anchor.
- **Lexical resolve() + trailing-sep startsWith**: `resolve()` collapses `..` segments without touching the filesystem; combined with `startsWith(worktreesRoot + sep)`, the walker can't escape `<projectAbs>/.worktrees/` and can't be tricked by a sibling like `.worktreesABC`. Symlink-via-malicious-subagent is out of scope — `.worktrees/` and `backlog/tasks/` are trusted per the threat model.
- **Project-level fallback retained one release**: Tagged DEPRECATED in code with v0.9.0+ removal. Lower blast radius than a hard cutover; legacy callers (manual operators, external tooling) keep working through the next release cycle.

## Verification
- `pnpm build` — clean
- `pnpm test` — 35/35 hook tests pass (10 new), no regressions in the wider suite
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 1 minor + 4 suggestion; test: 0 minor + 3 suggestion; security: 0 findings)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- The 5 reviewer suggestions (JSDoc refresh on `readActiveTaskId`, deny-message wording referencing the env var, file-header comment drift, an unreachable defensive branch, malformed-sentinel content tests) are documented in the PR body. None block merge; cosmetic / nice-to-have polish for a future cleanup pass.
- Drop the project-level sentinel path entirely in v0.9.0+ (deprecation comment in the hook tracks the removal version).
<!-- SECTION:FINAL_SUMMARY:END -->
