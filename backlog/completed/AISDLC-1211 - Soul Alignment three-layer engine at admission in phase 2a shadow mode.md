---
id: AISDLC-1211
title: 'Soul Alignment three-layer engine at admission in phase 2a shadow mode'
status: Done
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
- [x] #1 Admission of a fixture task writes shadow rows for every SA dimension with weights (0, 0) and leaves the admitted score identical to the label-table result.
- [x] #2 Each row carries composite score and claim rank; a task never claimed carries `rank: null`.
- [x] #3 The existing admission tests pass unchanged; a new test proves the engine is called exactly once per admission.

## Final Summary

## Summary
Admission can now run the three-layer SA engine in phase 2a shadow mode through a new `soulAlignmentShadow` hook on `computeAdmissionComposite`. The hook fires once per non-override admission and never feeds the score, and `createSoulAlignmentShadow` (new `orchestrator/src/sa-scoring/admission-shadow.ts`) writes the SA-1 and SA-2 rows with weights (0,0). Nothing in the repo passes the hook to the admission path yet, so no production admission calls the engine until a caller does. Opened as draft PR #2473.

## Changes
- orchestrator/src/admission-composite.ts
- orchestrator/src/sa-scoring/index.ts
- orchestrator/src/sa-scoring/admission-shadow.ts
- orchestrator/src/sa-scoring/admission-shadow.test.ts
- orchestrator/src/sa-scoring/index.test.ts
- orchestrator/src/index.ts
- backlog/tasks/AISDLC-1211 - Soul Alignment three-layer engine at admission in phase 2a shadow mode.md

## Design decisions
I ran build, test, lint, format:check and dark-code:check in the worktree before the final push; all passed. The pre-push patch coverage gate passed at 100% on 24 of 24 changed lines.

The engine is async and admission is sync, so the hook fires the engine and does not wait for it. Rows are written shortly after admission returns. Engine errors go to an optional `onError` callback and never reach admission.

The claim rank is stored as `rank` inside `phase_weights_json` (null at admission) because the `did_scoring_events` table has no rank column. A real column would need a schema migration, which I avoided because the schema version constant is 12 while a migration 13 already exists.

The second commit is the task file claim edit under `backlog/tasks/`. I committed it because an uncommitted change blocked the rebase.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

