---
id: AISDLC-324
title: 'feat: RFC-0022 Phase 3 — `ai-sdlc init` compliance-posture wizard step'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0022
  - compliance
  - phase-3
  - init-wizard
dependencies:
  - AISDLC-322
  - AISDLC-323
references:
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0022 §9 Implementation Plan. Wires CompliancePosture authoring into the `ai-sdlc init` flow.

## Scope (RFC-0022 §9 Phase 3, §7 init wizard)

- Amend RFC-0011 wizard with the §7 "Compliance posture" step.
- Multi-select prompt with regime descriptions (HIPAA, SOC2, PCI-DSS, GDPR, FedRAMP, ISO-27001).
- Attestation prompt: operator confirms regime applicability.
- Notes prompt: optional context per declared regime.
- Write `.ai-sdlc/compliance.yaml` with declared regimes + computed `derivedGates` + operator-visible review block.
- **OQ-2 auto-fill:** `attestedBy` set from git config user.email; `attestedAt` set to ISO-8601 now.
- **For OQ-11 specifically (cross-RFC):** gate-config step reads `compliance.yaml`, pre-selects DB-pool default, surfaces the rationale (per RFC-0009 OQ-11 + RFC-0022 OQ-1 trigger checklist).
- Integration test: fresh checkout → `ai-sdlc init` → declares HIPAA → resulting `compliance.yaml` has correct `derivedGates` → DB-pool config defaults to per-shard.

## Exit criteria

New init flow tested end-to-end against a fresh checkout; OQ-11 default flips correctly based on declared regimes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 RFC-0011 init wizard adds §7 "Compliance posture" step
- [ ] #2 Multi-select prompt for HIPAA / SOC2 / PCI-DSS / GDPR / FedRAMP / ISO-27001
- [ ] #3 Attestation prompt confirms operator awareness
- [ ] #4 `attestedBy` auto-filled from git config; `attestedAt` auto-filled to ISO-8601 now per OQ-2
- [ ] #5 `.ai-sdlc/compliance.yaml` written with declared regimes + composed `derivedGates`
- [ ] #6 Gate-config step reads `compliance.yaml` + pre-selects DB-pool default per RFC-0009 OQ-11 trigger checklist
- [ ] #7 Integration test: HIPAA declaration → per-shard DB-pool default
<!-- AC:END -->
