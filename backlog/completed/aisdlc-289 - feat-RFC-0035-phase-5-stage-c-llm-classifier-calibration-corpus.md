---
id: AISDLC-289
title: 'feat: RFC-0035 Phase 5 — Stage C LLM classifier + calibration files + shared corpus'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-5
  - critical-path
dependencies:
  - AISDLC-287
  - AISDLC-321
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - pipeline-cli/src/capture/
priority: high
blocked:
  reason: 'RFC-0035 14/14 OQs resolved per 2026-05-15 walkthrough; lifecycle is Ready for Review awaiting per-owner sign-off. Phase 5 implementation proceeds under operator-acknowledged upstream-OQ override — same pattern as sibling Phase 3 (AISDLC-287) and Phase 4 (AISDLC-288).'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0035 Implementation Plan (§14). Stage C is the LLM-as-last-resort tier. OQ-3 resolution introduces an auto-apply + 24h override window pattern with a shared classifier corpus that composes with the RFC-0024 capture corpus.

## Scope

- Stage C LLM evaluation behind feature flag
- Calibration files: `decision-policy.md`, `decision-principles.md`, `decision-exemplars.yaml`
- Confidence threshold 0.7 (per-org configurable via `decisions-config.yaml`)
- Shared corpus aggregator composing with the RFC-0024 capture corpus (per OQ-3)
- Auto-apply with 24h override window during cold-start
- Silence-as-positive-exemplar: no operator override within window → exemplar promoted; override → negative exemplar
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Stage C LLM classifier ships behind feature flag
- [x] #2 `decision-policy.md`, `decision-principles.md`, `decision-exemplars.yaml` calibration files
- [x] #3 Confidence threshold 0.7 (configurable via decisions-config.yaml)
- [x] #4 Shared corpus aggregator (composes with pipeline-cli/src/capture/ from RFC-0024)
- [x] #5 Auto-apply with 24h override window for cold-start period
- [x] #6 Operator override emits negative exemplar; silence emits positive exemplar
- [x] #7 Override window per-org configurable
<!-- AC:END -->

## Final Summary

### Summary

RFC-0035 Phase 5 ships the Stage C LLM evaluation tier behind `AI_SDLC_DECISION_CATALOG` (default-on since AISDLC-392). Stage C composes with the AISDLC-321 shared classifier substrate via the `decision-recommendation` task type — no parallel LLM call site, no parallel corpus, no parallel override-window logic. The auto-apply + 24h override-window pattern from OQ-3 fires on reversible decisions that meet the threshold; the override window is per-org configurable via `decisions-config.yaml: overrideWindowHours`. A shared corpus aggregator surfaces per-task-type metrics + cross-task rollups + anchor-candidate clusters (OQ-11, ≥ 3 consistent overrides) across all 5 substrate task types.

### Changes

- `pipeline-cli/src/decisions/stage-c.ts` (new): Stage C runner + auto-apply gate + event factories (`makeStageCCompletedEvent`, `makeStageCAutoApplyAnsweredEvent`, `makeOverriddenEvent`). Composes with substrate `classify('decision-recommendation', ...)`.
- `pipeline-cli/src/decisions/corpus-aggregator.ts` (new): Read-side aggregator across the substrate's 5 per-task-type corpus files. Per-task metrics, cross-task rollup with volume-weighted accuracy, anchor-candidate detection.
- `pipeline-cli/src/decisions/decision-record.ts` (modified): Added `stage-c-completed` + `overridden` event types + `StageCOutput`/`StageCRecommendation`/`StageCCompletedEvent`/`OverriddenEvent` interfaces + structural validation.
- `pipeline-cli/src/decisions/projection.ts` (modified): Fold `stage-c-completed` into `status.evaluation.stageC`; fold `overridden` into `lifecycle=answered`.
- `pipeline-cli/src/decisions/decisions-config.ts` (modified): New `stageCConfidenceThreshold` field (default 0.7).
- `pipeline-cli/src/decisions/index.ts` (modified): Barrel re-exports for stage-c + corpus-aggregator.
- `pipeline-cli/src/cli/decisions.ts` (modified): New subcommands `score-c`, `answer`, `override`, `corpus aggregate` (with `--anchor-threshold` override).
- `spec/schemas/decision.v1.schema.json` (modified): Added `stage-c-completed` to the event-type enum.
- `reference/src/core/generated-schemas.ts` (regenerated).
- `.ai-sdlc/decision-policy.md` (new): Top-level policy mirroring `review-policy.md`.
- `.ai-sdlc/decision-principles.md` (new): 7 durable principles mirroring `review-principles.md`.
- `.ai-sdlc/decision-exemplars.yaml` (new): Seed exemplar bank from the 14-OQ walkthrough.
- Tests (new): `pipeline-cli/src/decisions/stage-c.test.ts` (34 tests), `pipeline-cli/src/decisions/corpus-aggregator.test.ts` (13 tests), CLI tests appended to `pipeline-cli/src/cli/decisions.test.ts` (16 new tests).

### Design decisions

- **Compose over duplicate (RFC-0035 §15.1 Pattern 6 + Pattern 4).** Stage C does not own prompt templates, corpus storage, or override-window helpers. The substrate already has them; Stage C wraps them. This is the single biggest architectural commitment for this PR — the corpus is shared with capture / DoR / PR-comment classifiers and the aggregator confirms it via the 5-row per-task-type table.
- **Mid-band guard (§5.3).** `runStageC` short-circuits when Stage B's composite score lands outside `[0.4, 0.7)` because outside that band the LLM call has no marginal value over the rubric. `--force` bypasses the guard for operator spot-checks.
- **Auto-apply gate is conservative.** `isStageCAutoApplyEligible()` gates on reversible + metBehindThreshold + llmAnswerEligible + no substrate error. Irreversible decisions (`spec.reversible: false`) NEVER auto-apply regardless of confidence — the override window pattern is reserved for reversible decisions where the operator can roll back.
- **`overridden` event + corpus polarity flip in one CLI call.** `cli-decisions override <id> <option>` emits the `overridden` event AND invokes substrate `recordOperatorOverride()` so the corpus polarity flips to negative atomically with the decision-log mutation. Two systems, one operator action.
- **Aggregator is read-only.** Corpus storage stays in the substrate; the aggregator is a projection. Anchor PROMOTION (Phase 9) will be operator-driven (`cli-decisions corpus tag-anchor` is wired but not implemented in this PR — Phase 9 follow-up); anchor DETECTION ships here so operators can see candidates.

### Verification

- `pnpm build` — clean
- `pnpm test` — 4853 pipeline-cli tests pass (47 new Stage C + corpus aggregator tests; 16 new CLI tests). Full workspace: orchestrator 3669, pipeline-cli 4853, reference 1358, dashboard 172, plugin 159, mcp-advisor 131, dogfood 372, etc. — all green.
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- Phase 6 (AISDLC-290): decision support surface — counter-arguments, alternatives, sub-decisions in `StageCOutput`. Phase 5 leaves those fields populated as empty arrays per the task brief.
- Phase 9 (AISDLC-294): override-driven calibration loop — `cli-decisions corpus tag-anchor <event-id>` to flip a detected candidate cluster to an active calibration anchor (the substrate's prompt-anchoring layer reads from this tag set).
- Production LLM invoker wiring: `cli-decisions score-c` runs without a real invoker today (falls open to a `pending` sentinel) — operators get a dry-run preview. The orchestrator should inject the Anthropic Haiku adapter at the appropriate phase entry point.
