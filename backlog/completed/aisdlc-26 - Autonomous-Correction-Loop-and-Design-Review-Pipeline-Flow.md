---
id: AISDLC-26
title: Autonomous Correction Loop and Design Review Pipeline Flow
status: Done
assignee: []
created_date: '2026-04-13 22:56'
updated_date: '2026-04-13 23:54'
labels:
  - correction-loop
  - design-review
  - M6
milestone: m-0
dependencies:
  - AISDLC-16
  - AISDLC-17
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - orchestrator/src/review-meta.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement the autonomous correction loop (§8.4) and design review pipeline flow (§8.5).

Correction loop:
- When visual regression or token compliance gates fail, feed structured VisualRegressionFailure payloads to agent
- Re-execute agent with failure context
- Check 4 exit conditions: maxRetries reached, agent changes a token reference, cumulative cost exceeds softLimit, design review triggerConditions met
- Track full iteration history (each attempt's code diff and visual diff)
- On escalation to design review, include full iteration history in review context

Design review flow:
- Create review requests with structured context (storyScreenshots, visualDiffs, tokenUsageReport, pageContext, designToolAnnotations, correctionLoopHistory)
- Collect structured DesignReviewFeedback (decision, categories with ratings, actionableNotes)
- Feed rejection feedback back to agent when actionOnReject=return-to-agent
- Enforce maxRejections escalation to human implementation

DesignReviewFeedbackStore (§A.7):
- record() stores feedback entries
- precision() returns accepted/(accepted+dismissed)
- highFalsePositiveCategories() and falseNegativeCategories() for calibration
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Correction loop feeds structured failure payloads to agent
- [x] #2 All four exit conditions implemented and tested
- [x] #3 Iteration history preserved for design review context
- [x] #4 Design review creates review requests with context payload
- [x] #5 Structured feedback collected and stored
- [x] #6 Rejection feedback looped back to agent
- [x] #7 maxRejections escalation to human implementation
- [x] #8 DesignReviewFeedbackStore with record, precision, highFalsePositiveCategories, falseNegativeCategories
- [x] #9 Unit tests for loop termination, feedback flow, and escalation
<!-- AC:END -->
