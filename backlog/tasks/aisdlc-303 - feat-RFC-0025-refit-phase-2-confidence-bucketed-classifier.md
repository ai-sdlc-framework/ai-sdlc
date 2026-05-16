---
id: AISDLC-303
title: 'feat: RFC-0025 Refit Phase 2 — Confidence-bucketed classifier (OQ-1)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0025
  - refit
  - phase-2
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
  - AISDLC-274
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
priority: critical
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 2. Implements the OQ-1-affirmed confidence-bucketed classifier. Composes with the RFC-0024 Refit Phase 2 shared classifier substrate (AISDLC-274) — same Haiku-class + 0.7 threshold + calibration corpus pattern.

## Scope (OQ-1 affirmed resolution)

- Three-tier classification:
  - High-confidence (≥ 0.7): auto-classify into `operator-under-decided` or `framework-misbehaved`
  - Mid-confidence (0.3–0.7): `ambiguous` (operator triages)
  - Low-confidence (< 0.3): unclassified, log only (no operator-facing surface)
- Per-org thresholds configurable in `.ai-sdlc/quality-monitoring.yaml` (§13.1 schema; `quality.classifier.confidenceThresholds`).
- Calibration loop: operator overrides feed back as negative exemplars; silence-as-positive-exemplar.
- Uses the shared classifier substrate from AISDLC-274 (no new classifier infrastructure).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Three-tier classifier ships per §13 OQ-1 resolution
- [ ] #2 Per-org thresholds read from `.ai-sdlc/quality-monitoring.yaml`
- [ ] #3 Calibration loop composes with the shared classifier substrate (AISDLC-274)
- [ ] #4 Operator overrides emit negative exemplars; silence emits positive
- [ ] #5 Low-confidence cases (< 0.3) log only — no operator-facing artifact
- [ ] #6 Test coverage for all three confidence tiers + threshold-boundary edge cases
<!-- AC:END -->
