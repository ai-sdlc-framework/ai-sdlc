---
id: AISDLC-292
title: 'feat: RFC-0035 Phase 8 — RFC-0023 TUI decisions-pending pane + multi-surface notification'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-8
  - critical-path
dependencies:
  - AISDLC-285
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - pipeline-cli/src/tui/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 8 of RFC-0035 Implementation Plan (§14). Operator TUI gets a `decisions-pending` pane. RFC-0023 Phase 1 is already signed off and shipped. OQ resolution requires multi-surface notification (TUI + Slack + email).

## Scope

- TUI `decisions-pending` pane
- Decision actor routing visible per row (Engineering / Product / Operator)
- Operator can resolve a Decision directly from the TUI
- Multi-surface notification: TUI + Slack + email per OQ resolution
- Composes with the existing `TuiCaptureFiled` event aggregator pattern
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 TUI `decisions-pending` pane shows pending Decision records
- [ ] #2 Decision actor routing visible per row (Engineering / Product / Operator)
- [ ] #3 Operator can resolve a Decision directly from TUI
- [ ] #4 Multi-surface notification: TUI + Slack + email per OQ resolution
- [ ] #5 Composes with `TuiCaptureFiled` event aggregator pattern (no duplicate aggregator)
- [ ] #6 Configurable per-surface enablement via decisions-config.yaml
<!-- AC:END -->
