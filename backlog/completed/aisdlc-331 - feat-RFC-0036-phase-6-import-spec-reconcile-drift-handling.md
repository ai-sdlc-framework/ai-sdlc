---
id: AISDLC-331
title: 'feat: RFC-0036 Phase 6 — `ai-sdlc import-spec --reconcile` for drift handling (catalog-routed)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-6
dependencies:
  - AISDLC-329
  - AISDLC-289
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
blocked:
  reason: 'RFC-0036 lifecycle is Ready for Review; all 12 §14 OQs resolved via operator walkthrough 2026-05-16 (RFC §14 header) — implementation phases AISDLC-326..336 cleared to proceed. RFC-0035 G0 contract is the design intent this task implements.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0036 §13. Drift handling for in-progress imported tasks when upstream `tasks.md` changes. Catalog-routed per OQ-2 + RFC-0035 G0 non-blocking contract.

## Scope (OQ-2)

- `ai-sdlc import-spec --reconcile [--task <id>]` detects drift between in-progress task and current upstream `tasks.md`.
- Drift detected → `Decision: spec-drift-detected` → Stage A classifies severity (typo / cosmetic / semantic / scope).
- **Low-severity** (typo/cosmetic): catalog auto-syncs the change to the task body; logs decision; no operator interrupt.
- **High-severity** (semantic/scope): catalog auto-defers with 24h override window; operator-surfaced in next batch review.
- Default-on-silence at 24h expiry: no-fork (task continues against dispatched version).
- **In-progress task NEVER halts** — it continues against the version it was dispatched with until the operator decides.
- Composes with RFC-0035 Phase 5 (AISDLC-289) shared classifier substrate for severity classification.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `ai-sdlc import-spec --reconcile` detects drift between in-progress task + upstream
- [x] #2 Drift severity classified via RFC-0035 Stage A (typo / cosmetic / semantic / scope)
- [x] #3 Low-severity drift auto-syncs without operator interrupt
- [x] #4 High-severity drift auto-defers with 24h override window per RFC-0024 §15.1
- [x] #5 In-progress task NEVER halts; continues against dispatched-version contract
- [x] #6 Default-on-silence at 24h expiry = no-fork
- [x] #7 Reads `adopter-authoring.yaml drift-handling.severityThresholds` config
- [x] #8 Integration test: each severity tier produces correct routing behavior
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

## Summary
RFC-0036 Phase 6 ships `cli-import-spec --reconcile [--task <id>]` for catalog-routed drift handling. The reconcile pass scans `backlog/{tasks,completed}/*.md` for tasks carrying a `specRef.source: spec-kit` block, re-parses the upstream `tasks.md` via the Phase 4 parser, classifies the drift per RFC-0035 Stage A (no-change / cosmetic / semantic / scope / removed-upstream), and routes each per the `drift-handling.severityThresholds` policy: low-severity auto-syncs the task body + commits an auto-resolved Decision (decision-opened + operator-answered with `accept-auto-sync`); high-severity opens `Decision: spec-drift-detected` with a 24h override window (RFC-0024 §15.1 default-on-silence = no-fork). The in-progress task is byte-identical after a defer — never halted, continues against the dispatched version.

## Changes
- `pipeline-cli/src/import-spec/reconcile.ts` (new): orchestrator + deterministic Stage A `classifyDrift` + imported-task scanner + auto-sync rewriter + Decision emitters for auto-sync, defer-24h, and removed-upstream.
- `pipeline-cli/src/import-spec/reconcile.test.ts` (new): 25 hermetic tests — classifier unit cases for every tier + integration cases for each routing outcome + Decision audit-trail asserts + config-override coverage.
- `pipeline-cli/src/import-spec/config.ts` (extended): adds `DriftHandlingConfig` + `driftHandling.severityThresholds.{typoCosmetic, semanticScope}` parsing for `.ai-sdlc/adopter-authoring.yaml` per RFC §14.1.
- `pipeline-cli/src/import-spec/config.test.ts` (extended): 4 new tests covering defaults, nested form, flat form, unknown-value fallback.
- `pipeline-cli/src/cli/import-spec.ts` (extended): adds `--reconcile [--task <id>]` mode + `renderReconcileOutcome` text renderer + mutual-exclusion check with `--from`.
- `pipeline-cli/src/cli/import-spec.test.ts` (extended): 3 renderer tests covering empty / auto-sync / defer outputs.
- `pipeline-cli/src/import-spec/index.ts` (extended): exports the reconcile module surface.

## Design decisions
- **Deterministic classifier for v1**: Stage A uses parsed-content compare (normaliseLine + aggressiveNormalise + normaliseBody) rather than the LLM-backed shared classifier substrate. Reproducible, no API spend, no flake. LLM-backed reclassification is a documented future Decision (`import-spec:drift-classifier-llm`) — the v1 contract is the per-severity routing action, not the sub-tier label.
- **AC count change = scope, not semantic**: ACs are the binary-testable contract surface (RFC-0011 G1). Any change to AC count or AC word content shifts the contract — operator must decide whether the in-flight implementation still covers it.
- **Auto-sync emits `decision-opened` + `operator-answered`**: mirrors the OQ-7 analyze auto-resolution pattern in Phase 5 — full audit trail even on the no-prompt path. Operator sees nothing under normal operation; the catalog log carries the why.
- **Defer-24h opens decision but does NOT auto-answer**: caller waits for explicit operator action OR catalog's 24h silence-sweeper closes with `no-fork-accept-drift` per RFC-0024 §15.1 default-on-silence — exactly what OQ-2 specifies. Pipeline never halts; in-progress task continues against dispatched version.
- **Removed-upstream marks superseded, never deletes**: per RFC §6.4. Footer marker is idempotent (`<!-- IMPORT-SPEC-RECONCILE:SUPERSEDED -->` guard).
- **Per-artifact parse cache**: each `tasks.md` is parsed once even if N imported tasks reference it — keeps `--reconcile` cheap on large monorepos with many imported features.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 5028 passed (106 import-spec + 25 new reconcile tests), 1 skipped
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm build` (full repo) — clean

## Follow-up
- LLM-backed drift reclassification (`import-spec:drift-classifier-llm` — future Decision)
- Phase 7+ tutorials documenting `--reconcile` operator workflow
<!-- SECTION:FINAL_SUMMARY:END -->
