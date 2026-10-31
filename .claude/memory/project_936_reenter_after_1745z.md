---
name: project-936-reenter-after-1745z
description: planner ruling 2026-10-16: reenter AISDLC-936/#1667 push-only only after 17:45Z; paced GraphQL; ignore no-match on file-aisdlc-938..944 branches
metadata:
  type: project
---

Planner ruling 2026-10-16 (received 17:36Z): AISDLC-936 / PR #1667: `cli-dispatch.mjs reenter` push-only (sign if contentHash changed, ready flip, marker) AFTER 17:45Z, not before. GraphQL bucket reset 17:39:40Z. Before 17:45Z take no reconcile/reenter/markReady gh actions beyond the bare tick. From 17:45Z resume normal ticks.

**Why:** a burst re-triggers the GraphQL secondary rate limit.
**How to apply:** one GraphQL-heavy action per PR, 20 s apart, no burst. Planner filing PRs for AISDLC-938..944 (branches ai-sdlc/file-aisdlc-938..944) are opened by hand; ignore reconciler no-match on them until the planner reports PR numbers. Delete this note once #1667 is reentered.
