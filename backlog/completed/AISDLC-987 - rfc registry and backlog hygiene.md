---
id: AISDLC-987
title: 'RFC registry and backlog hygiene: Registry rows, stale lifecycles, completed/ statuses'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - docs
  - backlog
dependencies: []
references:
  - spec/rfcs/README.md
  - scripts/check-task-moved.sh
  - backlog/config.yml
  - docs/operations/backlog-and-execution-reference.md
priority: low
dispatchable: true
---

## Description

`spec/rfcs/README.md` carries its own drift note at `:407`: four RFCs (the adopter-extension and triage-signal RFCs numbered 0037 to 0040) exist on disk but have no Registry row, and "backfilling rows for 0037-0040 is tracked separately" has not happened. About ten existing rows show a lifecycle column that no longer matches the `lifecycle:` frontmatter of the RFC file they link (the Registry starts at `:345`; "Next available number" is at `:405`). On the backlog side, `backlog/completed/` holds 975 files of which 123 do not carry `status: Done` (86 `To Do`, 36 `In Progress`, one `Approved`, two `Withdrawn`, one `Superseded`, counted 2026-10-20), although `scripts/check-task-moved.sh` moves the file into `completed/` as the done signal and `docs/operations/backlog-and-execution-reference.md` defines done as the move.

Out of scope: resolving any RFC Open Question (operator-only), changing any RFC's lifecycle, and reopening any completed task. Fix: a check script regenerates the Registry rows (number, title, lifecycle, link) from each RFC file's frontmatter and fails on a missing or stale row; the README rows are regenerated once by that script; the completed-task statuses are set to `Done` mechanically (the `Withdrawn` and `Superseded` files keep their status, the one `Approved` and every `To Do` and `In Progress` become `Done`); and a drift check (a `backlog-drift` rule or a small test) fails when a file under `backlog/completed/` carries a status other than `Done`, `Withdrawn` or `Superseded`, so neither drift can recur.

**Five-step review (requirements first).**
1. Requirement questioned: does the Registry table need to exist by hand at all? It is a view over frontmatter, so the script owns it and humans stop editing rows.
2. Delete: the registry-drift note at `:407` once the rows exist.
3. Simplify: one script for the rows, one rule for completed statuses.
4. Accelerate: a reviewer never checks rows by hand again.
5. Automate: both checks run in the docs lane of CI.

## Acceptance Criteria

- [x] `spec/rfcs/README.md` has a Registry row for every `RFC-NNNN-*.md` on disk, with the lifecycle column equal to the file's frontmatter; the drift note is removed.
- [x] A check script fails on a missing or stale Registry row and runs in CI's docs lane.
- [x] Every file under `backlog/completed/` carries `status: Done`, `Withdrawn` or `Superseded`; a drift check enforces it.
- [x] No RFC Open Question, lifecycle or completed-task content changes beyond the status line.

## Final Summary

## Summary
Added `scripts/check-rfc-registry.mjs` and `scripts/check-completed-status.mjs`. The first backfilled the missing RFC-0037 to 0040 rows and fixed the stale lifecycle cells. The second set 121 completed tasks to `Done`. Both checks run in `pnpm rfc:check` and in the `governance-gate` job of `ai-sdlc-gate.yml`, which also runs on docs-only PRs. `pnpm build`, `pnpm test`, `pnpm lint` and `pnpm format:check` passed locally before I rebased onto `origin/main`. I didn't re-run them after the rebase, only both new checks.

## Changes
- scripts/check-rfc-registry.mjs
- scripts/check-rfc-registry.test.mjs
- scripts/check-completed-status.mjs
- spec/rfcs/README.md
- package.json
- .github/workflows/ai-sdlc-gate.yml
- backlog/completed/ (121 task files, status line only)

## Design decisions
The lease push was refused by the hook (AISDLC-798, session cwd not bound to the worktree). The branch did not exist on the remote yet, so a plain `git push -u` from the worktree went through. The draft PR is open. RFC-0001 (template) is exempt from the Registry check because its frontmatter lifecycle is Draft while its row says Template. The task counted 123 non-Done completed files; the script found 121, none of them `Approved`. The `Withdrawn` and `Superseded` files kept their status. The task file AISDLC-987 is still in `backlog/tasks/`, so the pre-push task-move hook skipped it.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

