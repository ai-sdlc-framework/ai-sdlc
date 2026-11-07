---
id: AISDLC-1201
title: Demo scenarios stop pinning real backlog task ids
status: Superseded
assignee: []
created_date: '2026-11-06'
labels:
  - pipeline-cli demo defect triage
dependencies: []
priority: low
dispatchable: false
drift_status: flagged
drift_checked: '2026-11-07'
drift_log:
  - date: '2026-11-07'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      pipeline-cli/demo/scenarios/home-page.json
    resolution: flagged
  - date: '2026-11-07'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
---

## Resolution

Superseded (operator, 2026-11-07): #2413 (AISDLC-1189) replaced the real task ids in the demo scenarios with `pipeline-cli/src/hierarchy/fixtures/demo-scenario.json`; the referenced `home-page.json` no longer exists.

## Description

**Source.** Planner session 2026-11-05/06; filed on operator go (decision rubric, 2026-11-06). Non-dispatchable until triaged.

Demo scenarios such as `pipeline-cli/demo/scenarios/home-page.json` name real backlog task ids. When the named task completes, its done step moves the task file to `backlog/completed/` and the demo test fails on pre-push. This broke AISDLC-1189 twice (scenario repointed 1150 to 1189, then off 1189).

## Acceptance Criteria
- [ ] #1 Demo scenarios use a fixture task that never moves, not a real backlog id.
- [ ] #2 The demo test fails with a clear message if a scenario names a real backlog task.
