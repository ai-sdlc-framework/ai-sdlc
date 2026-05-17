---
id: AISDLC-343
title: 'feat: RFC-0030 Phase 1 — source adapter interface + registry + 2 default adapters (support-ticket + community-thread)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-1
dependencies: []
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0030. Establishes the source-adapter substrate matching the HarnessAdapter / DatabaseBranchAdapter / EmbeddingAdapter pattern.

## Scope (RFC-0030 §5 + OQ-13.1 credential deferral)

- `orchestrator/src/signal-ingestion/types.ts` — `SignalSourceAdapter` interface per §5.
- `orchestrator/src/signal-ingestion/registry.ts` — registry + `getSignalSourceAdapter()` lookup.
- `orchestrator/src/signal-ingestion/adapters/signal-source-support-ticket.ts` — default support-ticket adapter (Zendesk/Intercom/etc. webhook receiver pattern).
- `orchestrator/src/signal-ingestion/adapters/signal-source-community-thread.ts` — default community adapter (Discourse/Slack/etc.).
- `orchestrator/src/signal-ingestion/errors.ts` — `UnknownSignalSource`, `SignalSourceUnavailable`, `AdapterCredentialInvalid`.
- **OQ-13.1 credential deferral:** adapter `isAvailable()` self-validation only; full credential lifecycle deferred to future "Adapter Credential Management" RFC. Adapter auth failures → `Decision: adapter-credential-invalid` → emit credential-setup task; pipeline continues on remaining adapters.
- **OQ-13.4 manual entry adapter:** `signal-source-manual` ships in Phase 1 too; requires `attestedBy` + auto-filled `attestedAt`; entries default to Tier 1.
- Schema: `spec/schemas/signal-source-adapter.v1.schema.json`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `SignalSourceAdapter` interface ships at `orchestrator/src/signal-ingestion/types.ts`
- [ ] #2 Registry + `getSignalSourceAdapter()` ships
- [ ] #3 Default `signal-source-support-ticket` adapter ships
- [ ] #4 Default `signal-source-community-thread` adapter ships
- [ ] #5 `signal-source-manual` adapter ships with forced `attestedBy` + auto-filled `attestedAt` (per OQ-13.4)
- [ ] #6 Adapter `isAvailable()` self-validation; credential lifecycle deferred (per OQ-13.1)
- [ ] #7 Auth failure routes through `Decision: adapter-credential-invalid`; pipeline continues on remaining adapters
- [ ] #8 Schema `spec/schemas/signal-source-adapter.v1.schema.json` ships
<!-- AC:END -->
