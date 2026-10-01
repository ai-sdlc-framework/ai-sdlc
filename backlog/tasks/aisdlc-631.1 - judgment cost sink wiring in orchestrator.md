---
id: AISDLC-631.1
title: >-
  RFC-0049 follow-up: wire the judgment cost sink into the orchestrator context builder
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - cost
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - orchestrator/src/cost-tracker.ts
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Reviewer minor on AISDLC-631: the orchestrator-side cost sink (`recordJudgmentCost`)
exists but the orchestrator context builder does not attach it, so judgments evaluated
from `orchestrator` write no `cost_ledger` row.

## Scope
Attach the cost sink in the orchestrator-side judgment context builder for uncached
evaluations; leave `pipeline-cli` as is (it records `costUsd` in the judgment log only).

## Acceptance Criteria
- [ ] An uncached evaluation through the orchestrator context writes one `cost_ledger` row with `pipelineType` `judgmentTokens`; a cached one writes none.
- [ ] A failing ledger write does not change the evaluation result.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
