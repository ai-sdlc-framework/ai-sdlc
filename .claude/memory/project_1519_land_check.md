---
name: project-1519-land-check
description: planner 2026-10-16 ruling on #1519 (AISDLC-534.1) and failed AISDLC-867; ignore retrigger-once failure
metadata:
  type: project
---

Planner ruling 2026-10-16 (~18:20Z):
- #1519 (AISDLC-534.1) is green and CLEAN with auto-merge armed 17:58Z. Do not retrigger; "cancelled" rows are the Untrusted-Contributor workflow. If still OPEN after two more ticks, run `cli-merge-if-eligible 1519 --source-kind backlog` once and report.
- Leave AISDLC-867 failed until 534.1 reaches Done, then requeue it with one `remove-verdict --from failed`.
- `retrigger-once` failing with "unknown flag: --commit" is a real bug (AISDLC-945 filed by planner); do not work around it, do not re-report.
- Hold handling of AISDLC-889/#1679, #1664, #1600 (acknowledged by planner).

**Why:** planner owns these rulings; avoids noise and duplicate actions.
**How to apply:** check #1519 state at the next two ticks; act per above.
