---
name: three-executors-until-rate-limit-fix
description: Operator ruling 2026-10-15 17:20Z: run alpha/beta/gamma only; retire delta and epsilon once their tasks finish, until the rate-limit fix is released
metadata:
  type: project
---

When ai-sdlc-executor-delta (AISDLC-875) and ai-sdlc-executor-epsilon (AISDLC-910) report done: /clear them as usual, but do NOT issue a new /ai-sdlc:executor command. Alpha, beta, gamma stay on the drain; queue slots stay queued. Report to the planner when both are idle. The operator may take them down with cli-hierarchy himself.

**Why:** rate-limit burn; ruling relayed by the planner, valid until the rate-limit fix is released.
**How to apply:** on each tick, if delta/epsilon report done, clear and leave idle; message the planner once both are idle. Lift only when the planner says the fix is released. Related: [[feedback_stability_before_unsupervised_spend]].
