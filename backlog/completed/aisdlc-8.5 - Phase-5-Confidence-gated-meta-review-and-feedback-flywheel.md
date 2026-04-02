---
id: AISDLC-8.5
title: 'Phase 5: Confidence-gated meta-review and feedback flywheel'
status: Done
assignee: []
created_date: '2026-04-02 17:50'
updated_date: '2026-04-02 20:09'
labels:
  - review-agents
  - calibration
  - feedback
milestone: v0.8.0
dependencies:
  - AISDLC-8.3
  - AISDLC-8.4
references:
  - .github/workflows/ai-sdlc-review.yml
  - orchestrator/src/runners/review-agent.ts
parent_task_id: AISDLC-8
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a confidence-gated filtering layer and a human feedback loop that calibrates thresholds over time.

## Confidence filtering

After review agents produce findings with confidence scores:
- **>0.8**: Post directly to PR as inline comment
- **0.5-0.8**: Run through a lightweight meta-review pass (Haiku) that evaluates: "Is this a real issue or noise?"
- **<0.5**: Suppress entirely (log for analytics but don't post)

## Meta-review pass

A second LLM call (Haiku, ~$0.002/call) that receives:
- The original finding
- The relevant code context
- The review principles

And returns: `{ keep: true/false, adjustedSeverity?: string, reason: string }`

## Feedback flywheel

Track human responses to review comments:
- **Accept** (human fixes the issue) → true positive signal
- **Dismiss** (human dismisses the review) → false positive signal
- **Ignore** (human merges without addressing) → low-value signal

Store signals in the state database. Use them to:
1. Calibrate confidence thresholds (Platt scaling against labeled data)
2. Identify categories with high false-positive rates → add exemplars
3. Measure review quality over time (precision, recall, F1)

## Changes needed
1. Add meta-review step to the review workflow for medium-confidence findings
2. Track accept/dismiss signals via GitHub review comment reactions or dismiss events
3. Store feedback in StateStore for threshold calibration
4. Add a dashboard view for review quality metrics (enterprise package)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Medium-confidence findings (0.5-0.8) go through meta-review before posting
- [ ] #2 Low-confidence findings (<0.5) are suppressed
- [ ] #3 Human accept/dismiss signals are tracked in StateStore
- [ ] #4 Review quality dashboard shows precision/recall trends
<!-- AC:END -->
