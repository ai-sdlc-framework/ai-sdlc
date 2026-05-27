---
id: AISDLC-451
title: >-
  Frontier triage rubric — cross-check tasks for already-shipped / closed-PR /
  blocked-on-OQ before dispatch
status: To Do
assignee: []
created_date: '2026-05-27 22:10'
labels:
  - frontier
  - rfc-0014
  - dor-rubric
  - operator-friction
  - vision-alignment
dependencies: []
references:
  - pipeline-cli/src/cli/deps.ts
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - VISION.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Origin: 2026-05-27 session. cli-deps frontier returned 14 "ready" tasks; on inspection: 1 already shipped (the work was on main, but the task file remained in tasks/), 1 explicitly blocked (a task with `blocked.reason`), 1 had a failed prior PR (closed without merge), 4 OQ-refinements awaiting walkthrough, plus a couple of session-list items that referenced backlog IDs that had never been filed as backlog files. I burned ~15 min triaging instead of dispatching.

The DoR rubric checks shape + references but doesn't cross-check execution state. A task can pass DoR and be in `backlog/tasks/` while its work has already shipped, or its prior PR is closed, or the task ID is fictitious.



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [ ] AC-1: cli-deps frontier output includes a "dispatch-readiness" signal per task: {ready, stale-shipped, closed-prior-pr, blocked, missing-id}
- [ ] AC-2: Stale-shipped check: grep CLAUDE.md and recent commit messages for task ID + "already done" / "shipped" / "default-on" keywords; flag stale tasks
- [ ] AC-3: Closed-prior-PR check: query `gh pr list --search "AISDLC-N" --state closed` and surface any non-merged closed PRs
- [ ] AC-4: Blocked check: parse `blocked.reason` from frontmatter (already partially done by upstream-OQ gate)
- [ ] AC-5: Missing-ID check: backlog/tasks/ or backlog/completed/ files must exist for any task surfaced
- [ ] AC-6: orchestrator-tick Step 5 (fill-to-cap) skips non-ready tasks AND surfaces them in next Decision Catalog tick: "frontier candidate X is stale-shipped — close task file?"
- [ ] AC-7: Cleanup task: sweep current backlog/tasks/ for already-shipped entries and move to completed/

<!-- AC:END -->

## References

- pipeline-cli/src/cli/deps.ts (frontier command)
- pipeline-cli/src/dor/upstream-oq-gate.ts (existing blocked check)
- ai-sdlc-plugin/commands/orchestrator-tick.md (Step 5 fill-to-cap)
- spec/rfcs/RFC-0014-dependency-graph-composition.md
- spec/rfcs/RFC-0011-definition-of-ready-gate.md
- VISION.md §3 (Operator's role: decision steward, not bug triager)

