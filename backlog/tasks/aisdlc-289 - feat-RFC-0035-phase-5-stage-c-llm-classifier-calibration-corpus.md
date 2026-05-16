---
id: AISDLC-289
title: 'feat: RFC-0035 Phase 5 — Stage C LLM classifier + calibration files + shared corpus'
status: To Do
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
- [ ] #1 Stage C LLM classifier ships behind feature flag
- [ ] #2 `decision-policy.md`, `decision-principles.md`, `decision-exemplars.yaml` calibration files
- [ ] #3 Confidence threshold 0.7 (configurable via decisions-config.yaml)
- [ ] #4 Shared corpus aggregator (composes with pipeline-cli/src/capture/ from RFC-0024)
- [ ] #5 Auto-apply with 24h override window for cold-start period
- [ ] #6 Operator override emits negative exemplar; silence emits positive exemplar
- [ ] #7 Override window per-org configurable
<!-- AC:END -->
