---
id: AISDLC-25
title: Stewardship Enforcement and Context Strategy Selection
status: Done
assignee: []
created_date: '2026-04-13 22:56'
updated_date: '2026-04-13 23:54'
labels:
  - stewardship
  - governance
  - M6
milestone: m-0
dependencies:
  - AISDLC-11
  - AISDLC-16
references:
  - spec/rfcs/RFC-0006-design-system-governance-v5-final.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement stewardship enforcement logic and the context strategy selection algorithm.

Stewardship enforcement (§5.3):
- enforceStewardship(change, principal, binding) validates that changes to designAuthority-scoped fields are submitted by authorized principals
- Changes to sharedAuthority fields require both disciplines when requireBothDisciplines=true
- All stewardship decisions recorded in audit log with submitter identity, fields changed, approvals

Context strategy selection (§7.2):
- selectContextStrategy(trigger, task, binding) implements the 5-step decision tree:
  1. Token-change trigger with no component mods → tokens-only
  2. Modifying/composing existing components → manifest-first
  3. Creating new component → full
  4. Both tokens AND composition → full
  5. Reusability score < 0.5 → full
- Re-selection on scope change after design impact review (§7.2 bottom)
- Strategy changes logged to audit with reason (scope-changed-at-impact-review)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 enforceStewardship returns allow/deny with reason
- [x] #2 Rejects unauthorized changes to scoped fields
- [x] #3 Requires both-discipline approval for shared authority fields
- [x] #4 All stewardship decisions recorded in audit log
- [x] #5 selectContextStrategy implements the 5-step decision tree
- [x] #6 Re-selection on scope change after impact review works correctly
- [x] #7 Context strategy changes logged with reason
- [x] #8 Unit tests for all stewardship and strategy selection paths
<!-- AC:END -->
