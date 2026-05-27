---
id: AISDLC-446
title: 'feat(orchestrator): sync-parent should prune stale parent debris when same task ID exists in completed/'
status: Done
assignee: []
created_date: '2026-05-27'
labels:
  - orchestrator
  - sync-parent
  - hygiene
  - pattern-c
  - low
dependencies: []
references:
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
priority: low
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`/ai-sdlc execute` Step 0.5 (`sync-parent` — AISDLC-217) auto-syncs untracked `backlog/{tasks,completed}/aisdlc-N*.md` files in the parent's working tree into `origin/main` via a generated `chore: sync N untracked task files` PR. The step intentionally skips files already present on `origin/main` (no-op message: "already there, skipping").

This skip leaves a real class of debris in the parent's working tree: when the operator filed a task via `mcp__backlog__task_create` (writing to `backlog/tasks/aisdlc-N - <slug>.md` in the parent), a dev subagent then implemented the task in a worktree and moved the file to `backlog/completed/` as part of its PR. The PR merges. `origin/main` now has the file in `completed/`, BUT the parent's working tree retains the original untracked copy in `tasks/`. Pattern C's `git reset --hard origin/main` preserves untracked files by design, so the debris persists indefinitely.

Concrete incident: AISDLC-445 (2026-05-26). Operator filed the task → dev moved to completed/ → PR #733 merged. The parent retained `backlog/tasks/aisdlc-445 - fixci-verify-attestation.yml-Stage-step-must-propagate-per-patch-id-transcript-leaves-directory-AISDLC-421-follow-up.md` as untracked. `cli-deps frontier` reads the working tree and reported AISDLC-445 as `status: To Do` despite the actual canonical file (in `completed/`) being `status: Done`. The operator surfaced this manually; without intervention the stale entry would have re-appeared in every frontier scan + cluttered every orchestrator-tick output.

## Scope

Add a complementary `prune-stale-parent-debris` step to the `sync-parent` flow. It runs AFTER the existing sync-to-main step and removes untracked files in `backlog/tasks/` whose same-ID counterpart exists in main's `backlog/completed/` AND whose content matches the canonical completed/ version (safety: don't delete genuine new edits).

## Acceptance criteria

<!-- AC:BEGIN -->
- [ ] #1 New step (or extension of `sync-parent`) scans parent for untracked `backlog/tasks/aisdlc-*.md` files
- [ ] #2 For each, checks whether `origin/main:backlog/completed/<same-id> *.md` exists
- [ ] #3 If exists AND `diff` against the canonical completed/ version produces no output → safe to delete
- [ ] #4 If exists BUT content differs → log a warning naming the file + skip (operator may have local edits worth preserving)
- [ ] #5 If does NOT exist → leave alone (genuine new task; existing sync-to-main path handles it)
- [ ] #6 Idempotent: re-running produces no output when there's nothing to prune
- [ ] #7 Hermetic tests cover all three branches (clean-delete, content-mismatch-skip, no-counterpart-no-op)
- [ ] #8 Wired into Step 0.5 of `/ai-sdlc execute` AND `/ai-sdlc orchestrator-tick` so every tick cleans up debris
- [ ] #9 Output line per pruned file (so operator sees what was cleaned up); silent when no debris
<!-- AC:END -->

## Validation cases

| Scenario | Expected behavior |
|---|---|
| Untracked tasks/aisdlc-N.md, same ID in completed/ on main, content matches | Delete the tasks/ file silently except for one log line |
| Untracked tasks/aisdlc-N.md, same ID in completed/ on main, content DIFFERS | Log warning, skip (preserve operator's local edits) |
| Untracked tasks/aisdlc-N.md, no completed/ counterpart on main | Leave alone (Step 0.5's existing sync-to-main path handles it) |
| No untracked task files | No-op, no output |
| Tracked tasks/aisdlc-N.md | Leave alone (different code path) |

## Related

- AISDLC-217 — original `sync-parent` step (handles new untracked files, NOT post-merge debris)
- AISDLC-216 — Pattern C MCP routing (writes new tasks to parent in some flows, causing the debris pattern)
- AISDLC-445 (2026-05-26) — empirical incident documented in Description above
