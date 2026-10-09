---
id: AISDLC-784
title: >-
  cache-versus-JIT report in the usage ledger
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - rfc-0053
  - context-engine
  - phase-3
dependencies:
  - AISDLC-780
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - docs/operations/usage-ledger.md
  - pipeline-cli/src/usage/report.ts
  - pipeline-cli/src/usage/commands.ts
  - pipeline-cli/src/usage/attribution.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add the RFC-0053 cache-versus-JIT report to the RFC-0050 usage ledger. Per session and per role it reports injected tokens by moment (from the load ledger), the share of injections later cited or acted on, and the cache-read tokens of the same sessions. A weekly check flags a profile whose change raised net tokens over the week. The report is the evidence for profile default changes under the asymmetric rule. This task instruments the trade and does not assume just-in-time loading is cheaper.

Sequencing: depends on AISDLC-780 in `dependencies:`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The usage report gains a section with injected tokens by moment and role, read from the load ledger (test with a fixture ledger).
- [ ] The report computes the cited-share of injections from ledger rows and later tool or decision references (test).
- [ ] The report shows cache-read tokens for the same sessions beside injected tokens (test).
- [ ] A weekly net-token flag fires when a profile change raised net tokens and stays quiet otherwise (test).
- [ ] `docs/operations/usage-ledger.md` documents the new section.
