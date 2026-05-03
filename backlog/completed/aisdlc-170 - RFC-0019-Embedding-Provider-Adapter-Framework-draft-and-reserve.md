---
id: AISDLC-170
title: 'RFC-0019: Embedding Provider Adapter Framework — draft + reserve in registry'
status: Done
assignee: []
created_date: '2026-05-03'
labels:
  - spec
  - governance
  - rfc-process
dependencies: []
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/README.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reserve RFC-0019 in the registry per AISDLC-165 governance and ship the initial RFC draft for the Embedding Provider Adapter Framework.

The framework unblocks RFC-0009 OQ-6 rule #2 (Eτ_tessellation_drift via embedding distance) by establishing the embedding substrate, and provides a pluggable adapter pattern for future consumers (PPA semantic similarity, DoR clarification dedup, classifier embeddings, backlog auto-tagging).

The structural template is RFC-0010 §13 (HarnessAdapter Framework) — same shape: interface + registry + capability matrix + deprecation lifecycle + default adapter + adopter extension point. The deprecation lifecycle mirrors RFC-0010 §11 model alias pattern (warning → error → removal).

Default adapter ships as `openai-text-embedding-3-small` (1536 dims, $0.02/1M tokens, OpenAI snapshot 2024-01-25). Storage backend defaults to JSONL (`<artifactsDir>/_embeddings/<provider>-<modelVersion>.jsonl`) following the `_dor/calibration.jsonl`, `_deps/snapshot.jsonl`, `_subscription-ledger/*.jsonl` convention. Migration tooling (`cli-embedding-bump`) handles re-embed when an adapter is deprecated.

The RFC ships with 7 open questions for operator walkthrough; each carries a lean to enable Phase 1 implementation work to begin without blocking on every OQ resolution.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 RFC-0019 file exists at `spec/rfcs/RFC-0019-embedding-provider-adapter.md` with full structure (frontmatter + 18 sections including Sign-Off, Revision History, 7 open questions)
- [x] #2 Registry table in `spec/rfcs/README.md` includes RFC-0019 row (Status: Draft, Lifecycle: Draft, Author: dominique@reliablegenius.io, File link, Notes)
- [x] #3 "Next available number" line in registry updated from RFC-0019 to RFC-0020
- [x] #4 RFC frontmatter declares `requires: [RFC-0010]` (structural template + deprecation pattern)
- [x] #5 Drift check exits 0 (`backlog-drift check`)
- [x] #6 Format check exits clean (`pnpm format:check`)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Two-file edit: new `spec/rfcs/RFC-0019-embedding-provider-adapter.md` (full RFC body, ~600 lines) + amend `spec/rfcs/README.md` registry table (one row added, "Next available number" line bumped to RFC-0020).

- **Structural template**: mirrored RFC-0010 §13 §1-§9 numbering. Sections 1-4 establish summary/motivation/goals/architecture; §5 the EmbeddingAdapter interface with TypeScript declarations; §6 registry + capability matrix + capability declarations; §7 the openai-text-embedding-3-small default adapter (full implementation sketch); §8 vector storage schema + JSONL backend; §9 migration mechanism with `cli-embedding-bump`; §10 Pipeline.spec.embedding configuration + AI_SDLC_EMBEDDING_PROVIDER feature flag; §11 5-phase implementation plan; §12 schema changes; §13 backward compatibility; §14 alternatives considered; §15 7 open questions with leans; §16 references; §17 sign-off; §18 revision history.
- **Default adapter choice**: `openai-text-embedding-3-small` over `-large` for cost ($0.02 vs $0.13 per 1M tokens) — bootstrap use case (RFC-0009 OQ-6 drift) is cost-sensitive; quality-sensitive adopters can register the larger variant via the framework.
- **Storage backend**: JSONL chosen over sqlite for v1 to match existing pattern (`_dor`, `_deps`, `_subscription-ledger` are all JSONL append-only). sqlite is a Phase 6+ extension via the EmbeddingStorageBackend interface.
- **Stale-vector policy**: lazy-re-embed default for operator-friendliness; fail-loud option for strict-provenance shops.
- **7 open questions**: Q1 storage backend, Q2 stale policy, Q3 cross-provider compat, Q4 deprecation grace period, Q5 package location, Q6 cost-tracker integration, Q7 SubscriptionLedger interaction. Each carries a lean so Phase 1 work isn't blocked on every OQ resolution.
- **No CLAUDE.md edit needed**: AISDLC-165 already added the "Number lookup" guidance pointing future sessions at the registry's "Next available number" line. RFC-0019 is now the entry future sessions will see incremented to.
<!-- SECTION:NOTES:END -->

## Final Summary

## Summary
Reserved RFC-0019 in the canonical registry and shipped the initial Draft of the Embedding Provider Adapter Framework spec, mirroring RFC-0010 §13's harness-adapter pattern (interface + registry + capability matrix + deprecation lifecycle + default adapter + adopter extension). Unblocks RFC-0009 OQ-6 rule #2 (Eτ_tessellation_drift via embedding distance) and establishes the substrate for future consumers.

## Changes
- `spec/rfcs/RFC-0019-embedding-provider-adapter.md` (new): 18-section RFC with TypeScript interface declarations, capability matrix, default `openai-text-embedding-3-small` adapter sketch, JSONL storage backend, migration mechanism via `cli-embedding-bump`, 5-phase implementation plan, 7 open questions with leans.
- `spec/rfcs/README.md` (modified): added RFC-0019 row to registry table; bumped "Next available number" line from RFC-0019 to RFC-0020.

## Design decisions
- **Mirror RFC-0010 §13 structure verbatim**: harness-adapter and database-branch-adapter already established the orchestrator's standard pattern for pluggable provider integrations. Operators who grok one get embedding adapters for free.
- **OpenAI text-embedding-3-small as default**: 6.5× cheaper than -large for marginal quality difference on short-text drift detection (the bootstrap use case). Quality-sensitive adopters register the larger variant via the framework.
- **JSONL storage default, not sqlite**: matches existing `_dor`/`_deps`/`_subscription-ledger` convention; trivial inspection with `jq`/`grep`; GC by mtime; no schema-migration story for v1.
- **Lazy-re-embed as default stale-vector policy**: operator-friendly — pipelines keep working after adapter swap, cost amortizes across actual usage. Strict-provenance shops can flip to fail-loud.
- **Ship 7 open questions with leans, not blocked-on-resolution**: Phase 1 work can begin against the leans; operator walkthrough resolves them before phase exit.

## Verification
- `pnpm format:check` — clean
- `npx backlog-drift@0.1.3 check` — exit 0 (warnings/info only on unrelated tasks)

## Follow-up
- Operator walks through 7 open questions in §15; flip lifecycle to Ready for Review after resolution.
- Phase 1 implementation tasks (orchestrator/src/embedding scaffolding + OpenAI default adapter + registry) gated on RFC-0019 sign-off; create AISDLC-170.1 through 170.5 sub-task tree at that point.
- Coordinate with RFC-0009 author so OQ-6 rule #2 (Eτ_tessellation_drift) wires through Pipeline.spec.embedding once both RFCs reach Phase 4.
