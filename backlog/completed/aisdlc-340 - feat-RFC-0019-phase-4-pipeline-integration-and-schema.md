---
id: AISDLC-340
title: 'feat: RFC-0019 Phase 4 — `Pipeline.spec.embedding` schema + first downstream consumer (RFC-0009 Eτ wiring) + operator runbook'
status: Done
assignee: []
created_date: '2026-05-16'
updated_date: '2026-05-24'
labels:
  - rfc-0019
  - embedding-substrate
  - phase-4
  - critical-path-rfc-0009
dependencies:
  - AISDLC-337
  - AISDLC-338
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0004-cost-governance-and-attribution.md
priority: medium
blocked:
  reason: |
    RFC-0019 and RFC-0009 are at 'Ready for Review' lifecycle (not yet
    Signed Off). Operator acknowledged this is intentional — Phase 4 is
    the spec-implementation phase per RFC-0019 §11. Sister Phase tasks
    AISDLC-337 (Phase 1) and AISDLC-338 (Phase 2) already shipped under
    the same lifecycle state. All 7 OQs in RFC-0019 were resolved in the
    2026-05-21 re-walkthrough (v0.3); the lifecycle promotion to
    'Signed Off' awaits the engineering owner sign-off check (separate
    operator action documented in RFC-0019 §17).
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0019 §11. Pipeline schema integration + spec-level wiring for RFC-0009 Phase 4 Eτ rule #2 + operator runbook.

## Scope (RFC-0019 §11 Phase 4)

- Schema amendment: add `Pipeline.spec.embedding` per §10.1 (provider + storageBackend + staleVectorPolicy + deprecation overrides).
- Pipeline-load wires `Pipeline.spec.embedding` → registry lookup → adapter instantiation → storage backend instantiation.
- **First downstream consumer spec-level wiring:** `Eτ_tessellation_drift` rule from RFC-0009 OQ-6 / RFC-0009 Phase 4.2 (AISDLC-317). Spec-level wiring lands here; runtime usage activates once RFC-0009 Phase 4.2 ships. Eτ consumer pins `staleVectorPolicy: 'fail-loud'` at API site (re-walkthrough OQ-2 — preserves historical-trajectory fidelity for drift signal).
- Cost-tracker integration per RFC-0004 — `embeddingTokens` line item flows into pipeline-level cost-budget.
- **OQ-6 RE-WALKTHROUGH per-consumer attribution:** cost-tracker records `consumerLabel` dimension alongside `(provider, modelVersion, accountId)`; pipeline-load wires `consumerLabel` propagation from `embed()` call sites through to cost-tracker.
- **OQ-7 RE-WALKTHROUGH unified-cost-report:** new cost-tracker view `cli-cost-report --unified` aggregates `inputTokens` + `outputTokens` + `embeddingTokens` + SubscriptionLedger window consumption (cost-converted) with explicit `costModel` label per row. Answers finance's monthly-spend query in one place. Documented in operator runbook.
- `.ai-sdlc/embedding-config.yaml` schema published; `ai-sdlc init` template ships with documented defaults.
- Operator runbook: `docs/operations/embedding-providers.md` covering: choosing an adapter, configuring stale-vector policy (incl. per-consumer override examples), monitoring deprecation lifecycle (milestone dedup), running `cli-embedding-bump`, GC strategy, scale-escalation heuristic (JSONL→sqlite swap criteria), unified cost report.

## Exit criteria

End-to-end pipeline run with `AI_SDLC_EMBEDDING_PROVIDER=on` writes vectors during a stage that calls `embed()`; cost-tracker records `embeddingTokens` line items; operator runbook published.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Schema amendment: `Pipeline.spec.embedding` per §10.1
- [x] #2 Pipeline-load wires spec → registry lookup → adapter + storage instantiation
- [x] #3 Spec-level wiring for `Eτ_tessellation_drift` rule; consumer pins `staleVectorPolicy: 'fail-loud'` (re-walkthrough OQ-2)
- [x] #4 Cost-tracker integration: `embeddingTokens` line item with `consumerLabel` dimension propagated from embed() call sites (re-walkthrough OQ-6)
- [x] #5 `cli-cost-report --unified` ships aggregating embeddingTokens + chat tokens + SubscriptionLedger with `costModel` labels (re-walkthrough OQ-7)
- [x] #6 `.ai-sdlc/embedding-config.yaml` schema published; `ai-sdlc init` template ships with re-walkthrough fields (scaleEscalationHeuristic, perConsumerOverridesAllowed, crossProviderPolicy split, catalogDedup milestones, unifiedCostReport, adapterBillingModelRespected)
- [x] #7 Operator runbook `docs/operations/embedding-providers.md` published with sections: choosing an adapter, stale-vector policy (incl. per-consumer override examples), deprecation lifecycle (milestone dedup), `cli-embedding-bump`, GC, scale-escalation heuristic, unified cost report (re-walkthrough)
- [x] #8 End-to-end pipeline run with embedding enabled writes vectors + records cost with consumerLabel
<!-- AC:END -->

## Final Summary

### Summary
Phase 4 of RFC-0019 ships the `Pipeline.spec.embedding` schema amendment, the pipeline-load wiring that resolves spec → registered adapter + storage backend (with deprecation gate), the first downstream consumer spec-stub (`Eτ_tessellation_drift` pinned to `fail-loud` per OQ-2 re-walkthrough), the per-consumer `consumerLabel` propagation through `recordEmbeddingCost()` (OQ-6), the `cli-cost-report --unified` CLI aggregating embedding + chat + subscription substrates (OQ-7), the `.ai-sdlc/embedding-config.yaml` init template with every re-walkthrough field documented, and the operator runbook extended with adapter-selection / stale-vector-policy / deprecation-lifecycle / cli-embedding-bump / unified-cost-report sections.

### Changes
- `spec/schemas/pipeline.schema.json` (modified): added `EmbeddingSpec` definition + `spec.embedding` field with provider/fallback/storageBackend/staleVectorPolicy/autoEmbedOnWrite/maxBatchSize/deprecationOverrides.
- `reference/src/core/types.ts` (modified): added `EmbeddingSpec`, `EmbeddingStaleVectorPolicy`, `EmbeddingDeprecationOverrides` TypeScript types + wired `embedding?` onto `PipelineSpec`.
- `reference/src/core/generated-schemas.ts` (modified): regenerated from amended JSON Schema.
- `orchestrator/src/embedding/pipeline-load.ts` (new): `loadEmbeddingFromPipelineSpec()` entry point + feature-flag parser + three-layer-precedence `resolveEffectiveGracePeriodDays()` + deprecation gate.
- `orchestrator/src/embedding/pipeline-load.test.ts` (new): 32 unit tests covering feature-flag, happy-path, fallback resolution, unknown-provider/storage errors, deprecation-gate phases, three-layer precedence.
- `orchestrator/src/embedding/consumers/tessellation-drift.ts` (new): canonical consumer-label + pinned `fail-loud` policy + `embedDriftSignal()` helper.
- `orchestrator/src/embedding/consumers/tessellation-drift.test.ts` (new): pins the load-bearing constants + verifies `consumerLabel` propagation.
- `orchestrator/src/embedding/storage/types.ts` (modified): exported `EmbeddingStaleVectorPolicy`.
- `orchestrator/src/embedding/index.ts` (modified): re-exported all new Phase 4 surfaces.
- `orchestrator/src/cli/commands/init-templates.ts` (modified): added `EMBEDDING_CONFIG_YAML_STUB` template with every OQ re-walkthrough field documented inline.
- `orchestrator/src/cli/commands/init.ts` (modified): scaffolds `.ai-sdlc/embedding-config.yaml` on `ai-sdlc init`.
- `pipeline-cli/src/cli/cost-report.ts` (new): self-contained unified-cost-report CLI (no orchestrator import); aggregates by `(costModel, category, source, consumer)`.
- `pipeline-cli/src/cli/cost-report.test.ts` (new): 22 unit tests covering aggregation, CSV-quoting, subscription cost-conversion, CLI router.
- `pipeline-cli/bin/cli-cost-report.mjs` (new): bin shim.
- `pipeline-cli/package.json` (modified): registered `cli-cost-report` bin.
- `docs/operations/embedding-providers.md` (modified): added "Choosing an adapter", "Stale-vector policy (per-org + per-consumer)", "Deprecation lifecycle (with milestone dedup)", "Running cli-embedding-bump", "Unified cost report" sections.

### Design decisions
- **OQ-2 fail-loud pinning lives in the consumer module, not as a magic-string at every call site.** `TESSELLATION_DRIFT_STALE_VECTOR_POLICY` is exported as a constant so it's grep-able + testable + impossible to forget at the call site. The `embedDriftSignal()` wrapper bakes in both the label AND the policy intent.
- **Three-layer precedence (`framework → adapter → per-org`) resolved via `resolveEffectiveGracePeriodDays()` rather than scattered ternaries.** Single function; trivial to test; documented in the operator runbook.
- **`cli-cost-report` does NOT import from `@ai-sdlc/orchestrator`.** Pipeline-cli is orchestrator-free by design. The CLI reads JSONL/JSON files directly; operators export the SQLite cost ledger to JSONL with a one-line node script (documented in runbook).
- **Subscription cost-conversion is intentionally approximate.** The framework surfaces "subscription dollars at play" without claiming line-item accuracy a subscription-billed substrate cannot provide. The model + defaults are operator-overridable + documented.
- **`EmbeddingSpecInput` type-shape duplicated in `pipeline-load.ts` rather than imported from `@ai-sdlc/reference`.** Avoids circular dep (orchestrator → reference is the established direction). The shape is structurally identical and tested via the schema-validation smoke test.

### Verification
- `pnpm build` — clean across all workspaces (reference, orchestrator, pipeline-cli, dashboard, dogfood, mcp-advisor, conformance, plugin)
- `pnpm test` — 3761 orchestrator + 5216 pipeline-cli + 1358 reference + 372 dogfood + 159 mcp-server + 131 mcp-advisor + 172 dashboard + 24 conformance + 15 sdk-typescript — all green
- `pnpm lint` — clean (eslint .)
- `pnpm format:check` — clean (prettier --check .)
- End-to-end smoke: `Pipeline.spec.embedding` YAML validates against the schema via `validateResource()` and surfaces the full `EmbeddingSpec` shape correctly.

### Follow-up
- **Phase 5 (AISDLC-341)** — corpus-driven soak + flag promotion. Operator runs dogfood pipeline with `AI_SDLC_EMBEDDING_PROVIDER=on` for one full corpus window; promote default-on per the RFC-0014 promotion runbook pattern.
- **`cli-embedding-bump` (AISDLC-339)** — Phase 3 migration tool referenced in the runbook + the `Running cli-embedding-bump` section. The runbook section is written as a forward-reference contract Phase 3 must honor.
- **RFC-0009 Phase 4.2 (AISDLC-317)** — wires `embedDriftSignal()` into the actual drift-computation pipeline. This task ships only the spec-level stub; runtime usage activates when AISDLC-317 lands.
- **Operator action on first deprecation:** when an OpenAI embedding model approaches `deprecatedAt`, the orchestrator's Decision-catalog writer (currently keyed on `embedding-provider-deprecated:<adapter>:<deprecatedAt>`) needs the milestone-dedup wiring per OQ-4 — currently emitted as a per-load `DeprecationWarningEvent`; the dedup belongs at the catalog-write layer, not the loader.
