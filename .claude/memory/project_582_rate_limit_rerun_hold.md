---
name: project-582-rate-limit-rerun-hold
description: Planner ruling 2026-10-15 on AISDLC-582/#1521 and the gh secondary rate limit; hold gh calls, rerun failed jobs once, no reenter
metadata:
  type: project
---

Planner ruling 2026-10-15 (~23:00Z): AISDLC-582 / PR #1521 failed on workflow checks that die in 5-8 s (Detect Changes, issue-link, pr-ready). That is the rate-limit shape, not a planner decision. All ACs are on the branch.

**Why:** gh returns "API rate limit already exceeded for user" (secondary limit) even though `gh api rate_limit` shows graphql 4765/5000 left. tick, `cli-ci sweep` and `reconcile` all fail on it.

**How to apply:**
1. Keep gh calls to the minimum until about 23:15Z (the limit resets at epoch 1792105348).
2. Then rerun the failed workflow jobs on #1521 once, after checking the head is unchanged.
3. If a job fails for a REAL reason (e.g. issue-link rule), fix that one thing on the branch; only a genuinely failing gate goes back to the planner, with the real FAIL line.
4. Leave board failed/582 as is; no `remove-verdict`, no reenter. Once #1521 is green, land it via `cli-merge-if-eligible --source-kind backlog`.
5. Report to the planner once #1521 is green or shows a real failure.

Keep epsilon idle (three-executor rule); leave beta alone while its subagents push. Related: [[feedback-check-planner-holds-before-routing]].
