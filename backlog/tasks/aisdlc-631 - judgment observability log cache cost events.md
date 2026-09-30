---
id: AISDLC-631
title: >-
  RFC-0049 Phase 2: judgment log, content-addressed cache, cost attribution, events, pipeline-cli context builder, doctor check
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-2
  - observability
  - cost
dependencies:
  - AISDLC-630
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - orchestrator/src/cost-tracker.ts
  - orchestrator/src/defaults.ts
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
  - orchestrator/src/cli/commands/doctor-checks.ts
  - docs/operations/doctor.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Makes every judgment evaluation observable and attributable, and gives `pipeline-cli`
callers one function that assembles a ready-to-use judgment context. RFC-0049 section 7
is the specification. This is also the first per-call latency record in the framework.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`. Its Open Questions
  are resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No vendor SDK and no new runtime dependency. HTTP goes through an injectable `fetch`;
  tests never touch the network.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **JSONL log sink** (in `reference`, takes `artifactsDir` as a parameter): appends
   one record per evaluation to `<artifactsDir>/_judgment/log-YYYY-MM-DD.jsonl` with
   fields `ts`, `judgmentId`, `version`, `questionSetHash`, `stateHash`, `provider`,
   `modelVersion`, `configuredMode`, `effectiveMode`, `downgradeReason`, `answers`,
   `thresholds`, `outcome`, `incumbent`, `latencyMs`, `inputTokens`, `outputTokens`,
   `costUsd`, `cacheHit`, `taskId`, `sourceKind`. The state itself is never written,
   only its hash. A write failure is swallowed and never fails the evaluation.
2. **Incumbent recording:** `evaluateJudgment` accepts an optional `incumbent` value
   from the caller (what the existing path decided) and passes it to the sinks, so
   agreement can be computed from `shadow` records.
3. **Content-addressed cache:** file per key under `<artifactsDir>/_judgment/cache/`,
   key is SHA-256 of provider name, pinned model, `questionSetHash`, canonical
   questions and `stateHash`. Used only when `defaults.cache` is true and the model is
   an exact version. A hit returns the stored answers, sets `cacheHit` true, reports
   zero tokens and zero cost, and makes no provider call.
4. **Cost:** add a `jev-1.13.0` row to `DEFAULT_MODEL_COSTS` in
   `orchestrator/src/defaults.ts` (input 0.042, output 0, cache read 0 per million).
   Add `recordJudgmentCost` to `orchestrator/src/cost-tracker.ts` following the
   existing `recordEmbeddingCost` column-reuse convention: `pipelineType`
   `judgmentTokens`, `agentName` the `consumerLabel`, `model` `<provider>@<modelVersion>`.
   Provide an orchestrator-side sink that calls it for uncached evaluations.
5. **Events:** add `JudgmentEscalated` and `JudgmentProviderUnavailable` to the event
   type union in `pipeline-cli/src/orchestrator/events.ts` and to
   `spec/schemas/orchestrator-events.v1.schema.json`. `JudgmentProviderUnavailable` is
   emitted at most once per process per reason.
6. **pipeline-cli context builder:** one function in a new `pipeline-cli/src/judgment/`
   module that loads the config, resolves the artifacts directory the way the rest of
   `pipeline-cli` does, registers the built-in providers, and returns the `ctx` that
   `evaluateJudgment` needs with the log sink and an events sink attached. Later tasks
   call only this.
7. **Doctor check** in `orchestrator/src/cli/commands/doctor-checks.ts`, documented in
   `docs/operations/doctor.md`: reports layer disabled (informational), provider key
   missing, model not pinned while any judgment is configured `enforce`, and any
   judgment configured `enforce` that the runtime would downgrade, with the reason.

## Acceptance Criteria
- [ ] One evaluation produces exactly one well-formed JSONL record containing every listed field, and the record does not contain the state text.
- [ ] An unwritable log directory does not change the evaluation result.
- [ ] A repeated evaluation with identical provider, pinned model, questions and state is served from the cache: the fake provider sees one request, the second record has `cacheHit` true and `costUsd` 0.
- [ ] The cache is bypassed when the model is an alias or `defaults.cache` is false.
- [ ] `costUsd` on a record equals `inputTokens` times the provider's `inputCostPer1MTokens` divided by one million.
- [ ] `CostTracker.computeCost` for `jev-1.13.0` uses the new row, not the Sonnet fallback, and `recordJudgmentCost` writes a `cost_ledger` row with `pipelineType` `judgmentTokens`.
- [ ] Both new event types validate against the updated events schema and appear in the type union; the schema test suite passes.
- [ ] The pipeline-cli context builder returns a usable context with the layer disabled (no config) without throwing, and every evaluation through it abstains.
- [ ] The doctor check reports each of its four conditions in a hermetic test and is listed in `docs/operations/doctor.md`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
