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
- **OQ-2 stale-vector policy at read-time:**
  - `lazy-re-embed` default: stale vector → re-embed silently + emit `Decision: stale-vector-encountered` to RFC-0035 catalog (no operator interrupt).
  - `fail-loud` opt-in: stale vector → refuse comparison + emit `Decision: stale-vector-encountered` with severity HIGH + auto-action: surface in operator batch review.
- **OQ-3 cross-provider compatibility:** attempt to compare across `(provider, modelVersion)` → refuse + emit `Decision: cross-provider-comparison-attempted` → auto-action: emit `cli-embedding-bump` migration task + log Decision.
- **OQ-4 deprecation lifecycle:**
  - 90d before `deprecatedAt`: emit `Decision: embedding-provider-deprecated` (warning severity); catalog routes to operator batch.
  - At `deprecatedAt`: operator-strict mode → escalate severity; default mode → continue warning.
  - At `removedAt`: pipeline-load emits `Decision: embedding-provider-removed` → auto-action: emit `cli-embedding-bump` migration task; downstream consumers degrade gracefully (no pipeline halt).
- Integration tests: deprecation lifecycle (warning → error → removal); migration round-trip; mid-migration concurrent read returns consistent result.

## Exit criteria

`cli-embedding-bump --dry-run` produces accurate cost estimate; `--execute` is atomic under concurrent reads; deprecation lifecycle phases trigger correct catalog Decisions + operator-facing surfacing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `cli-embedding-bump --dry-run` ships with accurate count + cost estimate
- [ ] #2 `cli-embedding-bump --execute` is atomic under concurrent reads
- [ ] #3 `lazy-re-embed` default: stale vector re-embeds silently + logs Decision
- [ ] #4 `fail-loud` opt-in: stale vector refuses comparison + surfaces Decision
- [ ] #5 Cross-provider comparison attempt refuses + emits migration task via catalog
- [ ] #6 Deprecation lifecycle: 90d warning → optional error at deprecatedAt → migration task at removedAt
- [ ] #7 Pipeline never halts on stale-vector / cross-provider / deprecation events
- [ ] #8 Integration tests cover full deprecation lifecycle + migration round-trip
<!-- AC:END -->
