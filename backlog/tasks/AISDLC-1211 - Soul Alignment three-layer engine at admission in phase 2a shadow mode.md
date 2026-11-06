---
id: AISDLC-1211
title: 'Soul Alignment three-layer engine at admission in phase 2a shadow mode'
status: To Do
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - admission
dependencies:
  - AISDLC-1208
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - orchestrator/src/sa-scoring/index.ts
  - orchestrator/src/admission-composite.ts
  - orchestrator/src/admission-score.ts
priority: medium
dispatchable: true
---

## Description

**Source.** RFC-0062 Phase 1 item 2, with the propensity logging from OQ-3 (DEC-0387). Affected surface: `orchestrator/src/admission-composite.ts` (the `soulAlignmentOverride` slot) and the three-layer engine `scoreSoulAlignment` in `orchestrator/src/sa-scoring/index.ts`, which has no production caller.

Admission uses the label tables in `admission-score.ts:253-263` and `backlog-adapter.ts` for Soul Alignment, so scores are nearly constant per label and the Decision Engine ranks by author trust.

## Scope

- `admission-composite.ts` calls `scoreSoulAlignment` through `soulAlignmentOverride` in phase 2a shadow mode: weights (0, 0), the label fallback still decides, one `did_scoring_events` row per dimension.
- Each shadow row also records the composite score and the dispatch rank the task received at claim (from AISDLC-1208), so a later fit can correct for the policy that produced the log.
- Phase 2b promotion stays gated on `validatePhase2bExemplars`; this task does not flip it.

## Acceptance Criteria
- [ ] #1 Admission of a fixture task writes shadow rows for every SA dimension with weights (0, 0) and leaves the admitted score identical to the label-table result.
- [ ] #2 Each row carries composite score and claim rank; a task never claimed carries `rank: null`.
- [ ] #3 The existing admission tests pass unchanged; a new test proves the engine is called exactly once per admission.
