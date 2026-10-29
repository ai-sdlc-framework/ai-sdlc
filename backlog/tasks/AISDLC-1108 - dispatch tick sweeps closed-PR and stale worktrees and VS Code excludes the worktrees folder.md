---
id: AISDLC-1108
title: >-
  Dispatch tick sweeps closed-PR, no-PR and stale worktrees (not only merged + clean), looks PRs up per branch instead of a 200-row list, checks the remove exit code; VS Code settings exclude .worktrees
status: To Do
assignee: []
created_date: '2026-10-29'
labels:
  - hierarchy
  - dispatch
  - stability
  - tooling
dependencies: []
references:
  - pipeline-cli/src/steps/00-sweep.ts
  - pipeline-cli/src/steps/00-parent-upkeep.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - ai-sdlc-plugin/commands/cleanup.md
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
On 2026-10-29 the operator's disk reached 97% (554 MiB free) with 264 directories under `.worktrees/` while the board had 3 tasks inflight. Transcript writes failed with ENOSPC, macOS raised the "out of application memory" alarm because swap could not grow, and VS Code's file watcher was indexing every worktree's `node_modules`. A manual `/ai-sdlc:cleanup` sweep recovered tens of GiB, which the dispatch tick should have done on its own.

The tick already calls `sweepMergedWorktrees` once per tick (`pipeline-cli/src/hierarchy/dispatch-loop.ts`, via `runParentUpkeep` in `pipeline-cli/src/steps/00-parent-upkeep.ts`), but the sweep in `pipeline-cli/src/steps/00-sweep.ts` lets the pile grow in four ways:

1. It removes a worktree only when its PR is `MERGED` and `git status --porcelain` is empty. Worktrees for closed-unmerged PRs, failed or abandoned tasks, planner filing branches and branches with no PR are never removed, by design.
2. PR state comes from one `gh pr list --state all --limit 200` call. With over 2000 PRs in the repository, any worktree whose PR is older than the 200 most recent resolves to "no PR" and is kept forever. This is the largest share of the pile.
3. Any untracked file (build output, a review ledger, a `.active-task` sentinel) marks the tree dirty and blocks removal with only a `console.warn`.
4. `git worktree remove` runs with `allowFailure: true` and its exit code is not checked, so a failed removal is counted as swept. The whole upkeep is also skipped when the GitHub quota is under the floor or when `check-orchestrator-state.sh` refuses, and nothing surfaces how many worktrees are waiting.

Separately, the repository has no `.vscode/settings.json`, so VS Code watches, searches and indexes `.worktrees/**` (hundreds of `node_modules` trees).

**Five-step review (requirements first).** Requirement questioned: "a worktree is kept until its PR has merged, because an unmerged branch may still be needed for a resume". The board already knows which tasks are inflight and which PRs are open; everything else is a leftover, and the branch (local and on origin) survives a worktree removal, so nothing is lost. Deleted: the `MERGED`-only rule and the 200-row list lookup. Simplified: one eligibility function `worktreeDisposition(entry)` returning `keep-inflight | keep-open-pr | remove-merged | remove-closed | remove-no-pr | remove-stale`, fed by the board (inflight claims), the per-branch PR state (`gh pr view <branch> --json state,mergedAt,closedAt`, cached per tick, or `gh pr list --head <branch> --state all --limit 1`), and the directory mtime for the stale rule. Accelerated: the sweep stops needing a clean tree for a `remove-*` disposition; `git worktree remove --force` is used and its exit code checked, falling back to `rm -rf` plus `git worktree prune` when git refuses. Automated: the tick runs the sweep every N ticks (configurable, default every tick as today), `cli-hierarchy status` prints `worktrees: <count> (<n> removable)` and alarms above a configurable ceiling (default 40), and `/ai-sdlc:cleanup` reuses the same disposition function so the manual path and the tick agree.

Rules for the dispositions:
- `keep-inflight`: the task id of the worktree directory is on the board as inflight, or the directory holds a `.active-task` sentinel younger than 24 h. Never removed.
- `keep-open-pr`: the branch has an OPEN PR. Kept; counted in status.
- `remove-merged`: PR MERGED (today's rule, minus the clean-tree requirement; a dirty merged worktree is logged at info level with the untracked paths, then removed).
- `remove-closed`: PR CLOSED and not merged. The branch stays local and on origin; only the worktree goes.
- `remove-no-pr`: no PR for the branch and the directory mtime is older than a grace window (default 6 h) so a developer pass that has not pushed yet is not interrupted.
- `remove-stale`: any `keep-open-pr` worktree whose PR has had no head change for a long window (default 14 days) is removed as well; a resume recreates it from the branch.

Also add `.vscode/settings.json` with `files.watcherExclude`, `search.exclude` and `files.exclude` entries for `.worktrees/**`, `**/node_modules/**`, `**/dist/**` and `**/coverage/**`, and note in `docs/operations/cli-hierarchy.md` that the operator can mirror the same keys in VS Code user settings.

Branch deletion stays out of scope (operator-controlled, CLAUDE.md). Review ledgers stranded in a worktree were made recoverable before any sweep by AISDLC-966; keep that ordering.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `worktreeDisposition` returns the six dispositions above from fixture inputs (board inflight set, PR state, sentinel age, directory mtime, PR head age); table-driven test.
- [ ] A worktree whose PR is CLOSED-unmerged, or whose branch has no PR and whose mtime is older than the grace window, is removed by the tick sweep (test with a fake git and gh runner).
- [ ] A worktree for an inflight task, or with a sentinel younger than 24 h, is never removed even when its PR is merged or closed (test).
- [ ] PR state is resolved per branch (or per batch covering every worktree branch), not from a 200-row recent list; a worktree whose PR is older than the 200 most recent PRs is still classified correctly (test).
- [ ] A dirty merged or closed worktree is removed with `--force`; the untracked paths are logged; the remove exit code is checked and a refusal falls back to `rm -rf` + `git worktree prune` and is reported, never counted as swept when it fails (test).
- [ ] `cli-hierarchy status` prints the worktree count and the removable count, and prints an alarm line above the ceiling (test).
- [ ] `/ai-sdlc:cleanup` (`ai-sdlc-plugin/commands/cleanup.md`) uses the same disposition rules so a manual sweep removes closed and stale worktrees too; its prose says branches are never deleted.
- [ ] `.vscode/settings.json` exists with `files.watcherExclude`, `search.exclude` and `files.exclude` covering `.worktrees/**`, `**/node_modules/**`, `**/dist/**`, `**/coverage/**`.
- [ ] `docs/operations/cli-hierarchy.md` documents the dispositions, the windows and their config keys, and the status line.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence (2026-10-29 ~05:00Z): `df -h /` 926Gi size, 554Mi free, 97% used; `.worktrees` 264 entries, board 3 inflight; manual merged-PR sweep removed 125+ worktrees and freed 46 GiB in 10 minutes; macOS "out of application memory" dialog and Claude Code "Transcript writes are failing (disk full, ENOSPC)" seen by the operator. Operator ruling: dispatch owns worktree hygiene; the operator must never have to run the sweep by hand.
