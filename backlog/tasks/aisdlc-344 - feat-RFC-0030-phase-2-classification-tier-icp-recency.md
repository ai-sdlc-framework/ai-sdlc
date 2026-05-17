---
id: AISDLC-344
title: 'feat: RFC-0030 Phase 2 — classification (tier + ICP resonance + recency) + language gate'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-2
dependencies:
  - AISDLC-343
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0030 §6. Classifies signals on three deterministic axes + applies English-only language gate per OQ-13.2.

## Scope (RFC-0030 §6 + OQ-13.2)

- `orchestrator/src/signal-ingestion/classifier.ts` — classifies on:
  - **Tier** (enterprise / mid / smb / free / churned; metadata-driven; language-independent).
  - **ICP resonance** (strong / partial / weak; embedding-based when RFC-0019 adapter is available, BM25-based otherwise).
  - **Recency** (decayed weight per `recencyHalfLifeDays`).
- **OQ-13.2 language gate:** non-English signals → `Decision: signal-language-unsupported` → drop signal + log to catalog. Per-org `acceptedLanguages: [en]` config; future v2 extensibility.
- Per-org tier multipliers + ICP resonance weights read from `.ai-sdlc/signal-ingestion.yaml`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Tier classification: enterprise / mid / smb / free / churned (metadata-driven)
- [ ] #2 ICP resonance classification: strong / partial / weak (BM25 default; embedding when RFC-0019 available)
- [ ] #3 Recency decay applied per `recencyHalfLifeDays` config
- [ ] #4 Non-English signals dropped + logged as `Decision: signal-language-unsupported`
- [ ] #5 Per-org `acceptedLanguages` config respected (default `[en]`)
- [ ] #6 Tier multipliers + ICP resonance weights read from `.ai-sdlc/signal-ingestion.yaml`
<!-- AC:END -->
