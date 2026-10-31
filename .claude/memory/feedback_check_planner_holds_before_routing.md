---
name: check-planner-holds-before-routing
description: Before sending a reconcile route-to-planner PR to the planner, check the RESUME HERE planner notes in the handoff memory; listed PRs with unchanged failing shape are held, not routed
metadata:
  type: feedback
---

Planner ruling 2026-10-15: dispatch rulings do not survive clears, so before messaging the planner about a `route-to-planner` PR, read `project_planner_handoff_2026_10_15.md` "RESUME HERE (planner notes)". A PR listed there with an unchanged failing-check shape is held, not routed.

Current rulings: #1596 and #1568 are pending (CI mid-run, issue-link transient), so wait for the `ai-sdlc/pr-ready` rollup. #1543 is held for AISDLC-878, so stop rebase-in-place. #1594 is parked for AISDLC-895; retry the arm only after #1601 merges.

**Why:** repeat routing of already-ruled PRs wastes planner turns (the AISDLC-903 gap).
**How to apply:** check the handoff notes first, then send only new states. See [[feedback_dispatch_report_blockers_to_planner]].
