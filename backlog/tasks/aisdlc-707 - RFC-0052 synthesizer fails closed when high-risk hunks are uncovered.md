---
id: AISDLC-707
title: >-
  RFC-0052 synthesizer fails closed when high-risk hunks are uncovered
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - review
dependencies:
  - AISDLC-674
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - .ai-sdlc/_decisions/events.jsonl
priority: low
dispatchable: false
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parked (planner, 2026-10-06): do not start without a planner go.

AISDLC-674 names high-risk hunks that no reviewer covered but leaves the verdict
unchanged. Per DEC-0040 the synthesizer must not approve in that case.

References: DEC-0040, RFC-0052.

## Acceptance Criteria
- [ ] When any hunk classified high-risk has no covering review, the synthesized verdict is `approved: false` with reason `incomplete-coverage` and the list of uncovered hunks (file and line range).
- [ ] Medium and low risk uncovered hunks are reported but do not flip the verdict.
- [ ] The behaviour sits behind the staged comparison window from AISDLC-679 so it can be observed before it gates.
- [ ] Tests cover: covered, uncovered-high, uncovered-medium, empty plan.
- [ ] RFC-0052 text records the resolution of the open point with a link to DEC-0040.

## Out of scope
- Changing risk classification.
<!-- SECTION:DESCRIPTION:END -->
