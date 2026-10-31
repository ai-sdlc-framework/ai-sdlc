---
name: dispatch-report-blockers-to-planner
description: Dispatch must message the planner every time it hits a blocker or finishes a brief, even when told to "stay idle"
metadata:
  type: feedback
---

When the dispatch session ingests (or declines to ingest) a brief, or hits anything it is waiting on, it sends the planner one message at that moment. It does not only tell the operator in-session.

**Why:** operator 2026-10-14 was upset that dispatch listed its blockers (executor-count hold, #1559 not landed, 859 PAT scope) to the operator but never to the planner. The planner had said "stay idle, next action comes from me"; dispatch read that as "stay silent" when it meant "do not act" (no claims, no relaunch, no loop). The planner also wanted a merge-sha line per landed task, so silence had a cost. Step 3 of the operator-dispatch command already requires this.

**How to apply:** after every brief or tick that leaves something blocked, send ONE self-contained message to `identity.planner` listing what was done, what was not done and why, and what dispatch waits on. "Stay idle" from the planner restricts actions, never reporting. Send it before answering the operator, not after being asked. Related: [[route-questions-via-planner]], [[feedback_planner_is_exception_handler]].
