---
id: AISDLC-15
title: Quality Gate Rule Types — Schema and Types for Design System
status: Done
assignee: []
created_date: '2026-04-13 22:54'
updated_date: '2026-04-13 23:23'
labels:
  - quality-gate
  - schema
  - types
  - M3
milestone: m-0
dependencies:
  - AISDLC-10
references:
  - spec/schemas/quality-gate.schema.json
  - reference/src/core/types.ts
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extend the quality gate JSON schema and TypeScript types with four new rule variants for design system governance.

New rule types to add to GateRule union (reference/src/core/types.ts:476):
1. DesignTokenComplianceRule — type, designSystem, category, maxViolations, metric, operator, threshold
2. VisualRegressionRule — type, designSystem, config (diffThreshold, failOnNewStory, requireBaseline), override (approvers)
3. StoryCompletenessRule — type, config (requireDefaultStory, requireStateStories, requireA11yStory, minStories)
4. DesignReviewRule — type, designSystem, reviewers, minimumReviewers, timeout, onTimeout, triggerConditions (always + conditional), reviewContext, feedback (structured categories, actionOnReject, maxRejections)

Also add DesignReviewFeedback interface per RFC §8.5.3 with decision, reviewer, categories array (category, rating, comment), actionableNotes, referenceUrls.

Update quality-gate.schema.json with corresponding JSON Schema definitions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 JSON Schema validates all four rule type examples from RFC §8.1-8.5
- [x] #2 Four new TypeScript rule interfaces with full field coverage
- [x] #3 GateRule union includes all four new types
- [x] #4 DesignReviewFeedback interface matches RFC §8.5.3 exactly
- [x] #5 Schema generation produces valid TypeScript
<!-- AC:END -->
