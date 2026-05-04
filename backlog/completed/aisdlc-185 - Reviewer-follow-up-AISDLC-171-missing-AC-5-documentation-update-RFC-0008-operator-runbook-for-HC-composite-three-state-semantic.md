---
id: AISDLC-185
title: >-
  Reviewer follow-up: AISDLC-171 missing AC #5 documentation update (RFC-0008 +
  operator runbook for HC composite three-state semantic)
status: Done
assignee: []
created_date: '2026-05-04 18:35'
labels:
  - docs
  - spec
  - reviewer-finding
dependencies: []
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - docs/operations/operator-runbook.md
  - orchestrator/src/admission-hc.ts
  - orchestrator/src/design-authority.ts
  - >-
    backlog/completed/aisdlc-171 -
    HC-composite-design-pillar-wiring-investigate-stewardship-designAuthority-to-HC_design-propagation-gap.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source
Code reviewer on PR #256 (AISDLC-171, retro review 2026-05-04) flagged AC #5 of the original task was NOT addressed by the merged PR.

## Original AC #5 from AISDLC-171
The PR resolved RFC-0009 OQ-8 by surfacing a `designAuthorityConfigured` diagnostic flag rather than changing HC_design behavior. The intent was that this resolution should be documented in:
- RFC-0008 §14.2 (the canonical source of HC_design principal-participation semantic)
- Operator runbook (so operators reading docs — not just code — encounter the same explanation)

## What shipped
PR added excellent inline JSDoc tying back to RFC-0008 §14.2 and RFC-0009 §13 OQ-8, but did NOT touch:
- `spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md`
- Any operator runbook

Future adopters reading the spec — not the orchestrator code — will still be confused by the same bug Alex hit.

## Fix
Backport the three-state semantic + new diagnostic flag explanation into:
- RFC-0008 HC composite section (`§14.2` or wherever HC_design is normatively spec'd)
- `docs/operations/operator-runbook.md` (or equivalent)

Worked example: show the 3 states (preDesignSystem / configured-but-inactive / active) with example DSB configurations + expected `designAuthorityConfigured` flag values + computeDesignAuthorityWeight outputs.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 RFC-0008 §14.2 (or equivalent) updated with the three-state HC_design semantic + diagnostic flag explanation
- [ ] #2 Operator runbook updated with worked example covering the 3 states
- [ ] #3 Cross-references to RFC-0009 §13 OQ-8 added in both docs
- [ ] #4 RFC-0009 §13 OQ-8 status updated to RESOLVED with pointer to AISDLC-171 PR + this follow-up
<!-- AC:END -->
