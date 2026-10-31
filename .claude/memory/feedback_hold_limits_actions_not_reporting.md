---
name: hold-limits-actions-not-reporting
description: "operator 2026-10-14: a planner 'stay idle' hold made dispatch stop reporting to the planner and answer only in its pane; holds limit actions, never reporting; pause with cli-hierarchy hold once AISDLC-899 lands"
metadata:
  type: feedback
---

On 2026-10-14 the planner paused the drain with a prose message to dispatch ("cancel any wake loop and stay idle; next action comes from me; nothing else"). Dispatch read it as "stay quiet": it stopped ticking and relaying blockers and merge shas, and reported only in its own pane. The operator hit this several times that day and asked how to prevent it.

**Why:** the hierarchy's only report path is `SendMessage` up one tier (executor -> dispatch -> planner -> operator). Pane text is invisible to the tier above. There was no board mechanism for a pause, so the planner improvised prose and dispatch over-read it.

**How to apply:**
- Never send "stay idle" or "nothing else" to a tier. A hold message must say explicitly: no claims/relaunches, keep reporting every blocker, verdict and merge sha by `SendMessage` as it happens.
- Once AISDLC-899 (PR #1563) lands, pause with `cli-hierarchy hold --reason` and resume with `cli-hierarchy resume`; tick keeps reporting while held.
- When a tier goes quiet during a hold, ask it for its blockers rather than assuming none. See [[planner-is-exception-handler]] and [[feedback_automation_ladder]].
