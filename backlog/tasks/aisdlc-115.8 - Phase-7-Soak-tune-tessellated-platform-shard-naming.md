---
id: AISDLC-115.8
title: 'Phase 7: Soak + tune + tessellated-platform shard naming'
status: To Do
assignee: []
created_date: '2026-05-01 16:26'
updated_date: '2026-05-03 00:24'
labels:
  - rfc-0011
  - phase-7
  - soak
  - tune
  - shard-naming
milestone: m-3
dependencies:
  - AISDLC-115.7
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
parent_task_id: AISDLC-115
priority: medium
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      spec/rfcs/RFC-0011-definition-of-ready-gate.md#12-implementation-plan
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      backlog/docs/ppa-product-signoff-rfc0011.md
    resolution: flagged
  - date: '2026-05-03'
    type: dep-resolved
    detail: Dependency AISDLC-115.7 has been completed
    resolution: flagged
  - date: '2026-05-03'
    type: refs-orphaned
    detail: All referenced files have been deleted
    resolution: flagged
  - date: '2026-05-03'
    type: dep-resolved
    detail: Dependency AISDLC-115.7 has been completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Soak + tune phase. Folds in Alex's Addition 2 (tessellated-platform shard naming). Per maintainer directive 2026-05-01, the exit criterion is corpus-driven (false-positive rate threshold), NOT calendar-driven. Whichever comes first — calendar duration is a side-effect, not a gate. Per RFC §12 Phase 7.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Run DoR in `warn-only` mode against real issue stream (no blocking); collect false-positive data to calibration log per Phase 5
- [ ] #2 Tune Stage B agent prompt + per-gate severity based on observed false-positives
- [ ] #3 Tessellated-platform shard naming per Alex's Addition 2: when project's DID is a Tessellated DID with >1 shard, Gate 5 also requires shard identification; clarification message lists shard names
- [ ] #4 Single-shard / non-tessellated platforms unaffected by the new check (regression test)
- [ ] #5 Phase 7 EXIT CRITERION (corpus-driven, NOT calendar-driven per maintainer directive 2026-05-01): false-positive rate < 10% per gate AND override-rate plateau in calibration log
- [ ] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->
