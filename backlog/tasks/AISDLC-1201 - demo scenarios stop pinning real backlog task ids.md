---
id: AISDLC-1201
title: 'Demo scenarios stop pinning real backlog task ids'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - pipeline-cli demo defect triage
dependencies: []
references:
  - pipeline-cli/demo/scenarios/home-page.json
priority: low
dispatchable: false
---

## Description

**Source.** Planner session 2026-11-05/06; filed on operator go (decision rubric, 2026-11-06). Non-dispatchable until triaged.

Demo scenarios such as `pipeline-cli/demo/scenarios/home-page.json` name real backlog task ids. When the named task completes, its done step moves the task file to `backlog/completed/` and the demo test fails on pre-push. This broke AISDLC-1189 twice (scenario repointed 1150 to 1189, then off 1189).

## Acceptance Criteria
- [ ] #1 Demo scenarios use a fixture task that never moves, not a real backlog id.
- [ ] #2 The demo test fails with a clear message if a scenario names a real backlog task.
