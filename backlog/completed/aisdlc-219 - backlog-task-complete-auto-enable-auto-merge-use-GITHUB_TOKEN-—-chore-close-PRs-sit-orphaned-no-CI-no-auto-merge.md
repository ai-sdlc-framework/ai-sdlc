---
id: AISDLC-219
title: >-
  backlog-task-complete + auto-enable-auto-merge use GITHUB_TOKEN — chore close
  PRs sit orphaned (no CI, no auto-merge)
status: Withdrawn
assignee: []
created_date: '2026-05-06 17:18'
updated_date: '2026-05-06 18:30'
labels:
  - bug
  - ci
  - merge-queue
  - framework-bug
  - auto-rebase
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Two workflows use `GITHUB_TOKEN` instead of `AI_SDLC_PAT`, both running into GitHub's [recursive-workflow-prevention rule](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow): pushes/PR-creates by `GITHUB_TOKEN` do NOT trigger downstream workflows.

### `backlog-task-complete.yml` (line 52 + 81)

When a PR with `(AISDLC-N)` in the title merges, this workflow opens a follow-up `chore: close AISDLC-N (auto)` PR to move the task file from `tasks/` to `completed/`. Uses `GITHUB_TOKEN` for both branch push (line 52) and `gh pr create` (line 81).

Result: the chore PR opens but **no CI fires** on its branch (paths-ignore for docs-only PRs is one issue; GITHUB_TOKEN trigger blocking is another). And the `auto-enable-auto-merge.yml` workflow doesn't fire on the bot-created PR because of the same rule.

### `auto-enable-auto-merge.yml` (line 66)

Uses `GITHUB_TOKEN` to call `gh pr merge --auto --rebase`. Even when it DOES fire (on operator-opened PRs), the arm-action is a bot-level call that may hit the queue's `mergeMethod` trap (per `feedback_gh_auto_merge_method_quirk.md` — the workflow's `--rebase` flag is silently coerced to SQUASH when run as bot).

## Observed (2026-05-06)

4 stuck chore: close PRs sitting orphaned:
- #360 (close AISDLC-215) — BEHIND
- #362 (close AISDLC-214) — UNKNOWN, no auto-merge
- #367 (close AISDLC-209) — UNKNOWN, no auto-merge
- #368 (close AISDLC-210) — BLOCKED, no auto-merge

None have auto-merge armed. None show CI activity on their branches.

This will recur after EVERY code PR merge (the workflow opens a follow-up for each).

## Fix

Mirror AISDLC-189's PAT switch:

1. `.github/workflows/backlog-task-complete.yml`:
   - Line 52: `token: ${{ secrets.AI_SDLC_PAT || secrets.GITHUB_TOKEN }}`
   - Line 81: `GH_TOKEN: ${{ secrets.AI_SDLC_PAT || secrets.GITHUB_TOKEN }}`
2. `.github/workflows/auto-enable-auto-merge.yml`:
   - Line 66: `GH_TOKEN: ${{ secrets.AI_SDLC_PAT || secrets.GITHUB_TOKEN }}`

The `|| secrets.GITHUB_TOKEN` fallback ensures the workflows still run (in degraded mode) if the PAT secret is unset, with a clear `::warning::` log.

## Composes with

- **AISDLC-189**: same PAT pattern, already shipped for auto-rebase
- **AISDLC-213**: auto-rebase re-arms auto-merge after force-push (same parent issue: clearing auto-merge state)
- **AISDLC-211**: parent attestation root-cause cluster

## Acceptance Criteria

- [ ] #1 `backlog-task-complete.yml` uses `AI_SDLC_PAT || github.token` for push + PR creation
- [ ] #2 `auto-enable-auto-merge.yml` uses `AI_SDLC_PAT || github.token` for the gh pr merge call
- [ ] #3 If `AI_SDLC_PAT` secret is unset, both workflows log a clear `::warning::` and still run via fallback
- [ ] #4 Empirically: open a test PR with `(AISDLC-NNN)` in title, merge it, confirm follow-up chore close PR auto-merges within 5 min without operator intervention
- [ ] #5 Document operator setup in `docs/operations/auto-rebase-token-setup.md` (the existing doc for the same PAT) — note that `backlog-task-complete` and `auto-enable-auto-merge` also rely on it
- [ ] #6 Backfill: 4 stuck PRs (#360, #362, #367, #368) need manual operator triage (close as superseded if file already on main, OR rebase + manually arm)
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

**Withdrawn — superseded by AISDLC-220.**

Originally filed as a band-aid (PAT switch for `backlog-task-complete.yml` to fire downstream workflow triggers). Operator preferred retiring the workflow entirely instead. AISDLC-220 implements the pre-push hook that auto-moves the task file in the originating PR — no orphan chore PRs, no GITHUB_TOKEN/PAT distinction needed.
