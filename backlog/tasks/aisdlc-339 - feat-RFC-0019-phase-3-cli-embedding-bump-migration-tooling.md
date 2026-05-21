---
id: AISDLC-339
title: 'feat: RFC-0019 Phase 3 — `cli-embedding-bump` migration tooling + stale-vector policy (catalog-routed)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0019
  - embedding-substrate
  - phase-3
dependencies:
  - AISDLC-337
  - AISDLC-338
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0019 §11. Migration tooling + catalog-routed stale-vector policy enforcement.

## Scope (RFC-0019 §11 Phase 3, OQ-2 + OQ-3 + OQ-4 resolutions)

- `pipeline-cli/bin/cli-embedding-bump.mjs` (entry point).
- `--dry-run`: count + cost estimate (uses cost-tracker per OQ-6).
- `--execute`: read-old → re-embed → atomic-swap → keep .bak.
- **OQ-2 stale-vector policy at read-time + RE-WALKTHROUGH per-consumer override:**
  - `lazy-re-embed` framework default: stale vector → re-embed silently + emit `Decision: stale-vector-encountered` to RFC-0035 catalog (no operator interrupt).
  - `fail-loud` per-org opt-in: stale vector → refuse comparison + emit `Decision: stale-vector-encountered` severity HIGH + surface in operator batch review.
  - **RE-WALKTHROUGH:** `embed()` / `read()` APIs accept optional `staleVectorPolicy?: 'lazy' | 'fail-loud' | 'inherit'` parameter (default `'inherit'` → org default → framework default `lazy-re-embed`). RFC-0009 `Eτ_tessellation_drift` consumer pins `'fail-loud'` at API site to preserve historical-trajectory fidelity (lazy-re-embed silently overwrites historical vectors, destroying time-series signal). Read-time consumers (PPA similarity, DoR dedup, classifier embeddings) leave default.
- **OQ-3 cross-provider compatibility — RE-WALKTHROUGH SPLIT:**
  - Cross-PROVIDER (e.g., openai vs cohere): ALWAYS refuse + emit `Decision: cross-provider-comparison-attempted` → auto-action: emit `cli-embedding-bump` migration task + log Decision. Math is genuinely undefined; cost of auto-migrate is catastrophic (entire-corpus re-embed).
  - Cross-VERSION-within-provider (e.g., 3-small@2024-01-25 vs 3-small@2025-01-25): delegates to OQ-2 `staleVectorPolicy` — closely-correlated embedding spaces, lazy re-embed is valid. **Resolves logical conflict in v0.2 resolution** that lumped both cases as "strict no-op" contradicting OQ-2's lazy-re-embed default.
- **OQ-4 deprecation lifecycle + RE-WALKTHROUGH:**
  - **Three-layer precedence** (framework default → adapter-declared → per-org override): 90d framework default; adapter capability matrix gains optional `defaultGracePeriodDays` field (e.g., Cohere adapter could declare `60`); per-org `gracePeriodDays` in `embedding-config.yaml` overrides on top.
  - **Catalog dedup via per-Decision-key counter** (prevents Decision flood under orchestrator-driven loads): emit `Decision: embedding-provider-deprecated` at milestones 89/60/30/7/1 days before `deprecatedAt`, NOT per-load. Dedup key: `embedding-provider-deprecated:<adapter-name>:<deprecatedAt>`.
  - At `deprecatedAt`: operator-strict mode → escalate severity; default mode → continue milestone warnings.
  - At `removedAt`: pipeline-load emits `Decision: embedding-provider-removed` → auto-action: emit `cli-embedding-bump` migration task; downstream consumers degrade gracefully (no pipeline halt).
- Integration tests: deprecation lifecycle (milestone-warnings → error → removal); migration round-trip; mid-migration concurrent read returns consistent result; per-consumer staleVectorPolicy override respected at API site (re-walkthrough); cross-provider vs cross-version policies handled independently (re-walkthrough); adapter-declared defaultGracePeriodDays + per-org override precedence (re-walkthrough); catalog dedup counter emits at milestones, NOT per-load (re-walkthrough).

## Exit criteria

`cli-embedding-bump --dry-run` produces accurate cost estimate; `--execute` is atomic under concurrent reads; deprecation lifecycle phases trigger correct catalog Decisions + operator-facing surfacing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-embedding-bump --dry-run` ships with accurate count + cost estimate
- [ ] #2 `cli-embedding-bump --execute` is atomic under concurrent reads
- [ ] #3 `lazy-re-embed` default: stale vector re-embeds silently + logs Decision
- [ ] #4 `fail-loud` opt-in: stale vector refuses comparison + surfaces Decision
- [ ] #5 Per-consumer `staleVectorPolicy?: 'lazy' | 'fail-loud' | 'inherit'` API parameter respected at embed()/read() call sites (re-walkthrough OQ-2)
- [ ] #6 Cross-PROVIDER comparison attempt refuses + emits migration task via catalog (re-walkthrough OQ-3)
- [ ] #7 Cross-VERSION-within-provider delegates to staleVectorPolicy (re-walkthrough OQ-3)
- [ ] #8 Deprecation lifecycle: three-layer precedence (framework default → adapter `defaultGracePeriodDays` → per-org override) (re-walkthrough OQ-4)
- [ ] #9 Catalog dedup: Decision counter emits at milestones 89/60/30/7/1 days before deprecatedAt, NOT per-load (re-walkthrough OQ-4)
- [ ] #10 Pipeline never halts on stale-vector / cross-provider / deprecation events
- [ ] #11 Integration tests: full deprecation lifecycle (milestone warnings + optional error + removal) + migration round-trip + per-consumer override + split cross-provider/version + catalog dedup
<!-- AC:END -->
