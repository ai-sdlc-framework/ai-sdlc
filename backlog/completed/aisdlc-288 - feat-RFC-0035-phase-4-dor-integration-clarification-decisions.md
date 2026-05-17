---
id: AISDLC-288
title: 'feat: RFC-0035 Phase 4 — RFC-0011 DoR integration + clarification rounds emit Decision records'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-4
  - critical-path
dependencies:
  - AISDLC-285
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0035 Implementation Plan (§14). Wires the existing RFC-0011 DoR clarification flow into the Decision catalog so every clarification question becomes a first-class Decision record.

## Scope

- RFC-0011 DoR clarification rounds emit Decision records
- Each clarification question becomes a Decision with question, options, recommendation, confidence
- Operator answers feed back into Decision resolution (status → resolved)
- Backwards-compatible with existing DoR substrate
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 RFC-0011 DoR clarification rounds emit Decision records into the catalog
- [x] #2 Each clarification question becomes a Decision with question, options, recommendation
- [x] #3 Operator answers feed back into Decision resolution (status → resolved)
- [x] #4 Backwards-compatible with existing DoR substrate (degrade-open when feature flag off)
- [x] #5 Integration test: DoR clarification round produces a queryable Decision via `cli-decisions list`
<!-- AC:END -->

## Final Summary

## Summary

The DoR-to-Decision bridge (`pipeline-cli/src/decisions/dor-bridge.ts`) wires RFC-0011 DoR clarification verdicts into the RFC-0035 Decision Catalog. Every clarification question produced by a needs-clarification verdict becomes a `decision-opened` event with `source: dor-clarification`. Operator answers are recorded as `operator-answered` events, and the projection folds them into `lifecycle: answered`.

## Changes

- `pipeline-cli/src/decisions/decision-record.ts` (modified): adds `OperatorAnsweredEvent` type + updates `DecisionEvent` union
- `pipeline-cli/src/decisions/event-log.ts` (modified): adds `makeOperatorAnsweredEvent` factory
- `pipeline-cli/src/decisions/projection.ts` (modified): folds `operator-answered` events to `lifecycle: answered`
- `pipeline-cli/src/decisions/dor-bridge.ts` (new): `emitDorDecisions()` + `resolveDorDecision()` with degrade-open
- `pipeline-cli/src/decisions/index.ts` (modified): re-exports dor-bridge
- `pipeline-cli/src/decisions/dor-bridge.test.ts` (new): 23 unit tests (AC#1-AC#4)
- `pipeline-cli/src/decisions/dor-integration.test.ts` (new): 6 integration tests (AC#5)

## Design decisions

- **Degrade-open pattern (AC#4)**: When `AI_SDLC_DECISION_CATALOG` is off, `emitDorDecisions()` returns `{ enabled: false }` without touching the event log. DoR substrate is fully unaffected.
- **One Decision per question**: Each clarification question gets its own DEC-NNNN id with the verbatim question as summary and three standard resolution options (provide-answer, bypass-gate, reject-issue).
- **Standard options**: The three DoR resolution paths are canonical for all dor-clarification Decisions; they match the DoR bypass/clarification patterns already in the comment loop.
- **OperatorAnsweredEvent in the union**: Added as a first-class type (not just catch-all) so the projection can fold it deterministically into `lifecycle: answered` + `answeredOptionId` + `answeredBy`.

## Verification

- `pnpm build` (tsc) — clean
- `pnpm test` (Vitest) — 3354 passed, 1 skipped
- `pnpm lint` — 0 errors (2 pre-existing warnings in unrelated file)
- `pnpm format:check` — clean

## Follow-up

Phase 5 (Stage C LLM evaluation + calibration files) is the next phase per RFC-0035 §14.
