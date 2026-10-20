---
id: AISDLC-987
title: 'RFC registry and backlog hygiene: Registry rows, stale lifecycles, completed/ statuses'
status: To Do
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

- [ ] `spec/rfcs/README.md` has a Registry row for every `RFC-NNNN-*.md` on disk, with the lifecycle column equal to the file's frontmatter; the drift note is removed.
- [ ] A check script fails on a missing or stale Registry row and runs in CI's docs lane.
- [ ] Every file under `backlog/completed/` carries `status: Done`, `Withdrawn` or `Superseded`; a drift check enforces it.
- [ ] No RFC Open Question, lifecycle or completed-task content changes beyond the status line.
