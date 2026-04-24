---
id: AISDLC-40
title: State Store Migration V11 — DID Artifacts + Code Area Metrics Extension
status: Done
assignee: []
created_date: '2026-04-24 17:21'
updated_date: '2026-04-24 17:42'
labels:
  - state-store
  - database
  - M1
milestone: m-1
dependencies:
  - AISDLC-38
references:
  - orchestrator/src/state/schema.ts
  - orchestrator/src/state/types.ts
  - orchestrator/src/state/store.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add `MIGRATION_V11` in `orchestrator/src/state/schema.ts`, bump `CURRENT_SCHEMA_VERSION = 11`.

New tables:
- `did_compiled_artifacts` (id, did_name, namespace, scope_lists_json, constraint_rules_json, anti_pattern_lists_json, bm25_corpus_blob, principle_corpora_blob, compiled_at, source_hash) — used by M5
- `did_scoring_events` (id, did_name, issue_number, sa_dimension, layer1_result_json, layer2_result_json, layer3_result_json, composite_score, phase_weights_json, created_at)
- `did_feedback_events` (id, did_name, issue_number, dimension, signal ENUM accept|dismiss|escalate|override, principal, notes, created_at) — used by M6
- `design_change_events` (id, did_name, change_id, change_type, status, payload_json, emitted_at) — §A.9
- ALTER `code_area_metrics`: ADD `has_frontend_components`, `design_metrics_json`, `data_point_count`

Add TypeScript record types in `state/types.ts`; store methods (insert/query/updateByDid) in `state/store.ts`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 CURRENT_SCHEMA_VERSION = 11
- [x] #2 Migration applies cleanly on V10 database
- [x] #3 Store methods: insertDidCompiledArtifacts, getDidCompiledArtifacts, recordDidScoringEvent, recordDidFeedback, recordDesignChange, getCodeAreaMetrics(codeArea, {window}) with hasFrontendComponents + designMetrics
- [x] #4 Round-trip tests for each new table
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
State store Migration V11 landed. V10→V11 upgrade path applies cleanly; 6 new tables cover the full RFC-0008 surface (M1, M5, M6).

## Changes
- `orchestrator/src/state/schema.ts`: bumped `CURRENT_SCHEMA_VERSION = 11`, added `MIGRATION_V11` with 6 tables + indices.
- `orchestrator/src/state/types.ts`: added `DidCompiledArtifactRecord`, `DidScoringEventRecord` (+ `SaDimension`, `SaPhase` unions), `DidFeedbackEventRecord` (+ `FeedbackSignal` union), `DesignChangeEventRecord`, `CodeAreaMetricsRecord`, `DesignLookaheadNotificationRecord`.
- `orchestrator/src/state/store.ts`: added store methods — `insertDidCompiledArtifact` / `getLatestDidCompiledArtifact` / `getDidCompiledArtifactByHash`, `recordDidScoringEvent` / `getDidScoringEvents`, `recordDidFeedback` / `getDidFeedbackEvents`, `recordDesignChange` / `getDesignChangeEvents`, `insertCodeAreaMetrics` / `getCodeAreaMetrics` / `getCodeAreaMetricsHistory`, `upsertDesignLookaheadNotification` / `getDesignLookaheadNotification`. All DESC-ordering queries use `(timestamp DESC, id DESC)` to handle SQLite's second-level `datetime('now')` precision.
- `orchestrator/src/state/store-did.test.ts`: 21 round-trip tests covering all 6 tables + migration verification.

## Design decisions
- **BLOB columns for BM25/principle corpora**: kept as `Buffer` in TypeScript so M5 can serialize lunr/bm25 indices directly without JSON re-encoding.
- **`hasFrontendComponents` stored as INTEGER, exposed as `boolean`**: matches RFC-0006 `approved` pattern; mapper coerces on read.
- **CHECK constraint on `did_feedback_events.signal`**: enforces enum at the DB layer; verified by round-trip test.
- **`UNIQUE(issue_number)` on `design_lookahead_notifications` with upsert semantics**: C7 needs dedupe-per-issue; `first_notified_at` preserved on conflict.

## Verification
- `pnpm build` — clean
- `pnpm vitest run src/state/store-did.test.ts` — 21/21 pass
- `pnpm vitest run` — 1826/1826 pass (full orchestrator suite, no regressions)
- `pnpm lint` — clean

## Follow-up
AISDLC-41 (C1 Computable SA-2 component) unblocked — can now consume `insertDesignTokenEvent` history + new store surface.
<!-- SECTION:FINAL_SUMMARY:END -->
