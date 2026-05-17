---
id: AISDLC-348
title: 'docs: RFC-0030 Phase 6 — signal-ingestion.yaml schema + governance event logging + operator runbook'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-6
  - docs
dependencies:
  - AISDLC-347
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0030 §11. Ships the per-org config schema + governance event logging + operator runbook.

## Scope (RFC-0030 §11)

- `spec/schemas/signal-ingestion-config.v1.schema.json` — JSON Schema for `SignalIngestionConfig` per §11.
- `.ai-sdlc/signal-ingestion.yaml` template ships in `ai-sdlc init` with documented defaults.
- **Governance event logging:** configuration changes (tier multiplier edits, threshold tweaks, adapter list changes) emit governance events to `events.jsonl` per §11 closing note ("Configuration changes require Product Lead approval (logged as governance events; not DID changes but governance-relevant)"). Composes with RFC-0033 governance reporting layer (when shipped).
- **Operator runbook:** `docs/operations/signal-ingestion.md` covering: adapter configuration, tier-multiplier tuning, SA-resonance threshold calibration, flooding-detection sensitivity, manual signal entry workflow.
- Promotion runbook section: `AI_SDLC_SIGNAL_INGESTION` flag promotion to default-on (corpus-driven; matches RFC-0014/0015 promotion convention).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `spec/schemas/signal-ingestion-config.v1.schema.json` ships
- [ ] #2 `ai-sdlc init` template ships `.ai-sdlc/signal-ingestion.yaml` with defaults
- [ ] #3 Configuration changes emit governance events to events.jsonl
- [ ] #4 `docs/operations/signal-ingestion.md` operator runbook published
- [ ] #5 Promotion runbook covers: adopter-corpus threshold, spot-check protocol, rollback, post-flip monitoring
- [ ] #6 Cross-references RFC-0011 / RFC-0014 / RFC-0015 promotion runbooks
<!-- AC:END -->
