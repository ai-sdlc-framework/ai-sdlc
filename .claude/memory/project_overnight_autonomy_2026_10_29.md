---
name: project_overnight_autonomy_2026_10_29
description: "Operator 2026-10-29 ~05:00Z overnight authorization: autonomous drain, rubric-recommended option self-recorded, releases + plugin pin updates allowed, hierarchy restarts allowed (esp. over context budget), watch agent context; review in the morning"
metadata:
  type: project
---

Operator (Dominique) left the planner to run overnight from 2026-10-29 ~05:00Z (2026-10-28 22:00 PDT) and ruled:

- Keep dispatching the backlog in autonomous mode.
- Any decision that comes up: run the `decision-rubric` skill, pick the recommended option, record it (`cli-decisions add` + `answer`, or `--timebox --autonomous-fallback` for class (b)); the operator reviews them in the morning via `cli-decisions operator-digest`. RFC Open Questions stay operator-only (unchanged).
- Authorized: tag releases (arm the release-please PR via `cli-merge-if-eligible <pr> --source-kind release --arm` once its brief has drained, per [[feedback_release_pr_arm_is_standing]]) and update plugin pins as needed.
- Authorized: restart the hierarchy or any session as necessary, especially when a session is over its context budget; the operator does not want long contexts burning tokens overnight. Watch the CONTEXT column of `cli-hierarchy status` every tick.

**Why:** the operator wants the ~40 queued tasks landed by morning without being woken for routine rulings; token burn from over-budget contexts is the main risk he named.

**How to apply:** the planner cron `235efcce` (:13/:43, created 2026-10-29 05:05Z, expires 2026-11-05) carries these rules in its prompt; recreate it with the same prompt if `CronList` is empty after a clear. Context watch: executor/dispatch above 120k or idle-after-verdict → `cli-hierarchy restart <name>`; planner above 150k → handoff write then clear. Disk hygiene added the same night (disk hit 97%): sweep worktrees when free < 20 GiB or count > 60; AISDLC-1108 (#2102) makes the tick do it. See [[feedback_autonomous_mode_stop_asking]], [[feedback_restart_executors_the_old_way]], [[feedback_timebox_operator_decisions]].
