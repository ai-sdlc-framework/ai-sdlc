---
name: 1608-wait-for-883-verdict
description: planner 2026-10-16: #1608 waits for AISDLC-883 verdict on epsilon, then conditional reenter with the GUARD_EXEMPT_ACTIONS note
metadata:
  type: project
---

Planner ruling 2026-10-16 (option 2) on #1608 (AISDLC-883, executor-epsilon): let 883 finish; planner does not message executors.

**Why:** the guard change needs a code edit; dispatch cannot do it and the rebase-resolver racing the executor's worktree was a mistake.

**How to apply:** when the AISDLC-883 verdict lands, check the pushed head. If the guard exempts 'held' and 'wait-and-rerun' but NOT 'ready-to-requeue', do nothing. Otherwise run `cli-dispatch.mjs reenter --board-dir "$BOARD_DIR" 1608 --note "<prose>"`. The note says: keep held + wait-and-rerun exempt, drop ready-to-requeue, add one same-head held x3 test, verify hierarchy tests with env -u AI_SDLC_WEBHOOK_SECRET. Ignore land-prep "not in done/" refusals until then. Never run rebase/resolver work in a worktree whose task is inflight.
