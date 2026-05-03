---
id: AISDLC-115.1
title: >-
  Phase 1: Schema + status (Needs Clarification + dor-config +
  refinement-verdict)
status: Done
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-1
  - schema
milestone: m-3
dependencies: []
references:
  - spec/schemas/refinement-verdict.v1.schema.json
  - .ai-sdlc/dor-config.yaml
parent_task_id: AISDLC-115
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#9-schema-changes
    resolution: flagged
drift_checked: '2026-05-03'
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

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
RFC-0011 Phase 1 schema foundation. Adds `Needs Clarification` lifecycle status to BOTH IssueTracker adapters (Backlog.md adds to default + project-config status set; GitHub uses `status:needs-clarification` label per RFC §9.1). Lands two new JSON schemas (`spec/schemas/dor-config.v1.schema.json` + `spec/schemas/refinement-verdict.v1.schema.json`) wired into the existing ajv harness. No evaluator logic — that's Phase 2a (115.2).

## Verification
- pnpm build && pnpm test (5104 vitest passes + 46/46 node tests) && pnpm lint && pnpm format:check — clean
- validation.ts patch coverage 89.51% lines (above 80%)
- 3 reviews APPROVED: code 0c/0M/4m/2s; test 0c/0M/1m/0s; security 0c/0M/0m/0s

## Reviewer follow-ups (non-blocking, defer to Phase 2 or follow-up)
- AnyResource union missing DorConfig (type-system inconsistency, not runtime bug)
- dor-config schema doesn't require `metadata` field unlike sibling schemas (convention drift)
- mapGitHubIssue marker-label overrides gh.state unconditionally — stale-closed issues surface as Needs Clarification
- listIssues({status:'Needs Clarification'}) doesn't honor the filter
- Phase 2: enforce closeAfterDays > warnAfterDays at runtime
- Phase 2: resolve gatesSkipped/gatesRetained overlap precedence
<!-- SECTION:FINAL_SUMMARY:END -->
