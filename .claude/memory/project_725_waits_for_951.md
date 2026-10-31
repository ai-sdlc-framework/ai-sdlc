---
name: project_725_waits_for_951
description: planner 2026-10-16 21:05Z: no reenter or re-enqueue of 725 until 951 lands; land 951 first, then DEC-0187 re-enqueue 725; report 951 PR number and "1346 landed"
metadata:
  type: project
---

Planner ruling 2026-10-16 (relayed; release #1592 now waits for #1346 / AISDLC-725).

- Do NOT reenter or re-enqueue 725 (#1346) until AISDLC-951 lands. The 725 failure is the Step 10.5 ledger loop that 951 fixes. Approvals are on record (3), findings minor.
- Report 951's PR number to the planner as soon as it exists (delta has it inflight).
- When 951's PR is green, land it first through cli-merge-if-eligible (priority over every other arm), ff the parent, rebuild dist, then DEC-0187 re-enqueue 725 with the note "approvals on record, review-round + sign only, 951 ledger fix now on main".
- When #1346 lands, send the planner "1346 landed" (the planner then pings the operator for #1592).

**Why:** 725 is the critical path for the release PR.
**How to apply:** check every tick for 951's PR; the reconciler's route-to-planner on #1554 stays ignored (held). See [[reference_dec_0187_reenqueue]] and [[project_855_hold_for_946]].
