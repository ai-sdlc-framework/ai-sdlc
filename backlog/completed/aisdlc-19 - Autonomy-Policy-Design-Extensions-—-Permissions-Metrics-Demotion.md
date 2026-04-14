---
id: AISDLC-19
title: 'Autonomy Policy Design Extensions — Permissions, Metrics, Demotion'
status: Done
assignee: []
created_date: '2026-04-13 22:55'
updated_date: '2026-04-13 23:32'
labels:
  - autonomy
  - schema
  - M4
milestone: m-0
dependencies:
  - AISDLC-10
references:
  - spec/schemas/autonomy-policy.schema.json
  - reference/src/core/types.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend autonomy policy schema and types with design-specific governance features.

Permissions — new designSystem block on autonomy levels:
- modifyExistingComponents, createNewComponents, modifyTokens, modifyStories, approveVisualDiffs (always false per §13.3)

Guardrails:
- requireDesignReview (always|conditional|never)
- maxComponentsPerPR

Promotion metrics with calibrationRange:
- token-compliance-rate, visual-regression-pass-rate, component-reuse-rate
- design-review-approval-rate, design-review-first-pass-rate, new-component-design-acceptance
- design-review-rejection-categories (none-major operator)

Demotion triggers:
- token-compliance-below-threshold, visual-regression-failure-streak
- design-review-rejection-streak, design-major-issue

Add calibrationRange and rationale fields to MetricCondition for template thresholds per §13.2.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Autonomy policy schema validates the full example from RFC §13
- [x] #2 TypeScript Permissions extended with designSystem block
- [x] #3 Guardrails extended with requireDesignReview and maxComponentsPerPR
- [x] #4 MetricCondition extended with optional calibrationRange and rationale
- [x] #5 New demotion trigger types recognized in evaluation
- [x] #6 All existing autonomy tests pass
<!-- AC:END -->
