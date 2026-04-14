---
id: AISDLC-30
title: Design Feedback Flywheel and Metrics Integration
status: Done
assignee: []
created_date: '2026-04-13 22:57'
updated_date: '2026-04-14 00:04'
labels:
  - feedback-flywheel
  - metrics
  - autonomy
  - addendum-a
  - M7
milestone: m-0
dependencies:
  - AISDLC-19
  - AISDLC-26
  - AISDLC-17
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - orchestrator/src/autonomy-tracker.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the design review feedback flywheel from Addendum A §A.7 and wire all design metrics into autonomy promotion/demotion.

Feedback flywheel — DesignReviewFeedbackStore:
- record(entry) stores feedback with prNumber, finding, signal (accepted/dismissed/overridden/escalated), reviewer, category, comment, timestamp
- precision() returns accepted/(accepted+dismissed) ratio
- highFalsePositiveCategories() returns categories sorted by dismiss rate
- falseNegativeCategories() returns categories sorted by escalation rate

Over time this data: calibrates confidence thresholds, identifies categories needing new exemplars, identifies checks that should be added to Design CI, provides the design-review-approval-rate and design-review-first-pass-rate metrics.

Metrics integration — wire six metrics into autonomy evaluator:
1. design-ci-pass-rate (Layer 1)
2. usability-simulation-pass-rate (Layer 3)
3. design-review-approval-rate (Layer 4)
4. design-review-first-pass-rate (Layer 4)
5. design-ci-auto-fix-rate (Layer 1 + correction loop)
6. usability-finding-accuracy (feedback flywheel precision)

These feed the promotion criteria (§13.2) and demotion triggers defined in AISDLC-19. Persist flywheel data via state store (design_review_events table from AISDLC-17).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 DesignReviewFeedbackStore fully implemented with all methods
- [x] #2 record() stores feedback entries with all required fields
- [x] #3 precision() returns accepted/(accepted+dismissed) ratio
- [x] #4 highFalsePositiveCategories() returns categories sorted by dismiss rate
- [x] #5 falseNegativeCategories() returns categories sorted by escalation rate
- [x] #6 All six design review metrics computed and available to autonomy evaluator
- [x] #7 Metrics integrated into promotion criteria evaluation
- [x] #8 Demotion triggers fire on design-specific conditions
- [x] #9 Flywheel data persisted via state store
- [x] #10 End-to-end test: feedback entry -> metric update -> promotion evaluation
<!-- AC:END -->
