---
id: AISDLC-16
title: Quality Gate Enforcement Engine — Design System Rule Evaluators
status: Done
assignee: []
created_date: '2026-04-13 22:54'
updated_date: '2026-04-13 23:23'
labels:
  - quality-gate
  - enforcement
  - M3
milestone: m-0
dependencies:
  - AISDLC-15
references:
  - reference/src/policy/enforcement.ts
  - reference/src/core/types.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend the evaluateRule function in reference/src/policy/enforcement.ts to handle the four new design system rule types.

The function dispatches on discriminant properties (existing pattern: 'metric' in rule, 'tool' in rule). Add four new dispatch branches:

1. designTokenCompliance: check ctx.metrics[category + '-violations'] against maxViolations, or check ctx.metrics['token-coverage'] against threshold
2. visualRegression: check ctx.metrics['visual-diff-percentage'] against diffThreshold, check baseline existence
3. storyCompleteness: check ctx.metrics['story-count'] against minStories, check flags for default/state/a11y stories
4. designReview: check ctx.designReview?.decision for approval status, handle timeout/pause

Extend EvaluationContext with design-specific fields: designReview (decision, reviewer, categories), designTokenCompliance (violations array).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 evaluateRule handles all four new rule types without modifying existing evaluation
- [x] #2 EvaluationContext extended with design-specific context fields
- [x] #3 Unit tests for each new rule type (pass, fail, advisory override)
- [x] #4 Existing gate enforcement tests continue to pass
- [x] #5 designReview rule correctly implements timeout/pause behavior
<!-- AC:END -->
