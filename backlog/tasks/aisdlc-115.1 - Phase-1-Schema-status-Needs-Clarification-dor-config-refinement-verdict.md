---
id: AISDLC-115.1
title: >-
  Phase 1: Schema + status (Needs Clarification + dor-config +
  refinement-verdict)
status: To Do
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-1
  - schema
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#9-schema-changes
  - spec/schemas/refinement-verdict.v1.schema.json
  - .ai-sdlc/dor-config.yaml
parent_task_id: AISDLC-115
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Foundation phase. Adds the `Needs Clarification` status + the two new YAML/JSON schemas the gate needs. No agent code yet — this just lands the data shapes so subsequent phases have stable types to consume. Per RFC §12 Phase 1.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Add `Needs Clarification` to task and issue status enums (Backlog.md adapter + GitHub IssueTracker adapter)
- [ ] #2 New `.ai-sdlc/dor-config.yaml` schema at `spec/schemas/dor-config.v1.schema.json` covering: notifications.{authorChannel,dedicatedChannel}, staleness.{warnAfterDays,closeAfterDays,closedLabel}, autoPassRules[], evaluationMode (warn-only|enforce)
- [ ] #3 New `spec/schemas/refinement-verdict.v1.schema.json` capturing per-gate verdict shape (gate id, verdict, confidence high|medium|low, optional clarification question)
- [ ] #4 JSON-schema validators wired into existing test harness; existing tooling (Backlog.md task_edit, GitHub IssueTracker) accepts the new status without regression
- [ ] #5 Pre-existing test suite stays green; new schema tests at 80%+ patch coverage
<!-- AC:END -->
