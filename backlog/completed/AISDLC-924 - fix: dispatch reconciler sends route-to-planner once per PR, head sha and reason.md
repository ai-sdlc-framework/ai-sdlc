---
id: AISDLC-924
title: 'fix: dispatch reconciler sends route-to-planner once per PR, head sha and reason'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [bug, hierarchy, reconcile, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/hierarchy/reconcile.ts, pipeline-cli/src/hierarchy/reconcile.test.ts, pipeline-cli/src/hierarchy/dispatch-loop.ts]
priority: medium
dispatchable: true
---

## Description

The dispatch PR reconciler re-routes the same PR to the planner on every tick with no backoff. In ai-sdlc-io (plugin 0.29.0) the planner received eight identical `route-to-planner` messages for one PR in an hour; here, three identical reports for the same three PRs arrived within 20 minutes. Each repeat costs planner context and tokens and carries no new information.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the planner must be told again when nothing changed. A report is only news when the head or the reason changes. 2. Deleted: the repeat messages. 3. Simplified: one dedupe key, (PR, head sha, reason), applied to `route-to-planner` and every other planner-facing report. 4. Accelerated: a quieter planner inbox, fewer wasted turns. 5. Automated: board-persisted dedupe state and tests.

A report is sent once per key. A repeat on the same key is suppressed until the head sha or the reason changes. The next tick summary line shows the suppressed count. The dedupe state is persisted on the board so it survives dispatch self-clears.

## Acceptance Criteria

- [ ] The first report for a (PR, head sha, reason) key is sent; later ticks with the same key send nothing.
- [ ] A new head sha or a new reason sends again.
- [ ] The next tick summary line shows the suppressed count.
- [ ] The dedupe state is persisted on the board and survives a restart.
- [ ] Tests in `reconcile.test.ts` cover send, suppress, re-send on change, the summary count and persistence.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Source: friction report from ai-sdlc-io on plugin 0.29.0, plus the same pattern observed locally today.
