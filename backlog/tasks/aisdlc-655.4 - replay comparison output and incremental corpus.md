---
id: AISDLC-655.4
title: >-
  RFC-0050: pairwise replay comparison and incremental corpus building
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - evaluation
dependencies:
  - AISDLC-655
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/replay-run.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a pairwise comparison to the replay output (candidate versus reference deltas for recall and false-block rate with counts), a merge mode for the corpus builder so a corpus accumulates across runs, and a per-model timeout for long replays.

Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] The replay output shows candidate-versus-reference deltas for recall and false-block rate with counts.
- [ ] Building the corpus twice merges new items and keeps existing ones without duplicates.
- [ ] A review that exceeds the per-model timeout is recorded as an error and the run continues or stops per the usage-gap rule.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
