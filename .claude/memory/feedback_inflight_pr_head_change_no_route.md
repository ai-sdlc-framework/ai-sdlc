---
name: feedback-inflight-pr-head-change-no-route
description: Planner standing rule 2026-10-15 - never route a PR to the planner on a head change while its task is inflight
metadata:
  type: feedback
---

A PR whose task is INFLIGHT (an executor holds the claim) is never routed to the planner on a head change. Report it only when the task reaches done or failed, or the executor escalates.

**Why:** the executor is pushing fixes, so each new head is expected; the reconciler's `no-match` plus `route-to-planner` on such a PR is noise (planner message 2026-10-15, #1612/AISDLC-894 f54e849: no action).

**How to apply:** when `cli-dispatch reconcile` prints `route-to-planner` for a PR whose task is in the handoff's Inflight list, send nothing. The #1543 hold stands, and its missing `origin/ai-sdlc/file-rfc-0054` ref is known, so do not report it. Related: [[feedback-check-planner-holds-before-routing]].
