---
id: AISDLC-115.9
title: 'Phase 8: Enforce (flip AI_SDLC_DOR_GATE warn-only → enforce)'
status: To Do
assignee: []
created_date: '2026-05-01 16:26'
labels:
  - rfc-0011
  - phase-8
  - enforce
  - promotion
milestone: m-3
dependencies:
  - AISDLC-115.8
parent_task_id: AISDLC-115
priority: medium
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#10-backward-compatibility
    resolution: flagged
  - date: '2026-05-03'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final phase. Flips the feature flag from warn-only to enforce in the dogfood project's `dor-config.yaml`. After this, the pipeline rejects Needs Clarification issues at PPA admission. Per RFC §12 Phase 8.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Feature flag `AI_SDLC_DOR_GATE` flipped from `warn-only` → `enforce` in the dogfood project's `dor-config.yaml`
- [ ] #2 Pipeline now REJECTS `Needs Clarification` issues at PPA admission + `/ai-sdlc execute` start (no longer just warns)
- [ ] #3 Metrics dashboard live with weekly digest entries
- [ ] #4 AISDLC-115 (parent) AC #2 + AC #3 marked complete in this PR's chore commit; parent task closes
- [ ] #5 spec/rfcs/RFC-0011-definition-of-ready-gate.md revision history extended with v4 entry: 'Promoted from warn-only to enforce in dogfood project DDDD-MM-DD'
- [ ] #6 CHANGELOG.md gets an entry under Unreleased > Added
<!-- AC:END -->
