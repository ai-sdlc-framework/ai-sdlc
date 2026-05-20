---
id: AISDLC-304
title: 'feat: RFC-0025 Refit Phase 3 — Multi-window recurrence + first-capture MTTR (OQ-3 + OQ-8)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0025
  - refit
  - phase-3
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 3. Implements the OQ-3-affirmed multi-window recurrence + the OQ-8-affirmed first-capture MTTR.

## Scope (OQ-3 multi-window)

- Compute recurrence rate for three windows simultaneously: 7d (flap detection), 30d (standard recurrence), 90d (legacy regression).
- All three surfaced in metric output + TUI + Slack digest.
- Per-org configurable in `.ai-sdlc/quality-monitoring.yaml` (`quality.recurrence-windows`).

## Scope (OQ-8 first-capture MTTR)

- MTTR clock from first capture per failure-mode fingerprint.
- Output labeled "MTTR (from first capture)" to avoid misinterpretation.
- v2 MTTD substrate documented but disabled (`v2-mttd.enabled: false`).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Three recurrence windows (7d / 30d / 90d) computed and surfaced simultaneously
- [ ] #2 Per-org window list configurable in quality-monitoring.yaml
- [ ] #3 MTTR clock starts at first capture per failure-mode fingerprint
- [ ] #4 Output explicitly labeled "MTTR (from first capture)"
- [ ] #5 v2 MTTD substrate present but disabled in this phase
- [ ] #6 Test coverage for all three windows + multiple captures of the same fingerprint
<!-- AC:END -->
