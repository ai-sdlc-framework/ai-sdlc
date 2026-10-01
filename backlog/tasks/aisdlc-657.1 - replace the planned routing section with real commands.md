---
id: AISDLC-657.1
title: >-
  RFC-0050 docs: replace the planned proposal section in the routing runbook with real commands
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - docs
dependencies:
  - AISDLC-657
references:
  - docs/operations/model-routing.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The "Planned behaviour (not yet available)" section of `docs/operations/model-routing.md` describes the weekly routing proposal, its approval, silence leaving the table unchanged, automatic reverts and the strength-only override file, with no runnable commands because the feature had not shipped when the runbook was written. When it ships, replace that section with the real commands and captured output, and remove the "not yet available" labels.

## Acceptance Criteria
- [ ] The planned section in `docs/operations/model-routing.md` is replaced by commands run against the shipped CLI, with real captured output.
- [ ] The statements about the 30-task and 5-point defaults, silence and strength-only overrides match the shipped behaviour.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
