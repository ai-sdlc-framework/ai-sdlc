---
name: feedback-cron-survives-clear
description: "Operator 2026-10-16: a session cron job (CronCreate) survives /clear; never recreate it after a clear, check CronList first"
metadata:
  type: feedback
---

A CronCreate job in the planner session survives `/clear` and the 150k auto-clear. Do not recreate it after a clear; run `CronList` first and only create one when none exists.

**Why:** operator correction 2026-10-16 ("clear doesn't kill it so no need to re-create it every time"); duplicate jobs would double the drive loop and the gh quota spend.

**How to apply:** after any clear, `CronList` before `CronCreate`. The standing 30-min planner drive is job `e84665df` (`13,43 * * * *`), ordered in [[project_planner_handoff_2026_10_16]]. Related: [[feedback_stability_before_unsupervised_spend]].
