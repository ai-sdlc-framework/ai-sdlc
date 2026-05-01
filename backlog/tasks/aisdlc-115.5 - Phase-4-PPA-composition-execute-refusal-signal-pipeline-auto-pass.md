---
id: AISDLC-115.5
title: 'Phase 4: PPA composition + execute refusal + signal-pipeline auto-pass'
status: To Do
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-4
  - ppa-integration
  - auto-pass
milestone: m-3
dependencies:
  - AISDLC-115.4
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#7-pipeline-integration
  - backlog/docs/ppa-product-signoff-rfc0011.md
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
parent_task_id: AISDLC-115
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wires DoR verdicts into the existing pipeline boundaries: PPA admission + `/ai-sdlc execute` start gate. Folds in Alex's Addition 1 (signal-pipeline auto-pass) per Product sign-off. Per RFC §12 Phase 4.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PPA admission step amended to skip issues in `Needs Clarification` (no scoring effort wasted on unready issues)
- [ ] #2 `/ai-sdlc execute <task-id>` refuses to start when task is in `Needs Clarification`, with a clear error message + link to the DoR comment
- [ ] #3 Signal-pipeline auto-pass per Alex's Addition 1: new `kind: signal-pipeline-generated` rule in `dor-config.yaml` autoPassRules; gates 1, 4, 5, 6 skipped; gates 2, 3, 7 retained
- [ ] #4 `evaluateIssue()` interface accepts a `gatesSkipped` parameter (or equivalent shape per Alex's note to Dom)
- [ ] #5 Existing tests pass; new tests cover the refusal paths + the signal-pipeline auto-pass path
- [ ] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->
