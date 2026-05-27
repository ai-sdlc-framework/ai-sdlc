---
id: AISDLC-449
title: Auto-reverify cached blockers before extending passive heartbeat past N ticks
status: To Do
assignee: []
created_date: '2026-05-27 22:09'
labels:
  - orchestrator
  - rfc-0015
  - vision-alignment
  - operator-friction
dependencies:
  - AISDLC-447
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - VISION.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Root cause of 18h passive monitoring loop on 2026-05-26→27. After context compaction, I trusted cached task-summary lines ("blocked on operator sign-off / CI race") without re-investigating the actual PR state. Real bug (v6 envelope filename) was always fixable.

The orchestrator-tick skill body has no rule that says "if you've been heartbeating with no state change for N ticks, re-investigate the cached blockers." Result: silent rot.



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: orchestrator-tick skill body adds Step 6.5 "stale-cache reverify": after K consecutive ticks with no PR state change AND no new dispatches, re-fetch failing-check details for each BLOCKED PR
- [ ] AC-2: K is configurable (default 2 for 1h cadence = 2h grace, ~3 for 20min cadence = 1h grace)
- [ ] AC-3: When reverify surfaces a new actionable signal (e.g. failing check changed reason), surface via Decision Catalog or AskUserQuestion rather than silently heartbeat again
- [ ] AC-4: When reverify confirms same blocker, escalate timebox urgency in Decision Catalog (depends on AISDLC-447)
- [ ] AC-5: Tests + worked example in skill body docs

<!-- AC:END -->

## References

- spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
- ai-sdlc-plugin/commands/orchestrator-tick.md (Step 6 ScheduleWakeup)
- VISION.md §4 (Honest failure modes — no silent rot)
- AISDLC-447 (depends on timebox flag for AC-4)

