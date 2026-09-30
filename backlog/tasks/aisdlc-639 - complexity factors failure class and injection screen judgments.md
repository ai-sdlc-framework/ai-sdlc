---
id: AISDLC-639
title: >-
  RFC-0049 Group C: complexity.factors, failure.class and triage.injection-screen judgments (tighten-only)
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - judgment-layer
  - phase-7
  - triage
  - security
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/policy/complexity.ts
  - orchestrator/src/admission-score.ts
  - pipeline-cli/src/tui/analytics/quality-classifier.ts
  - orchestrator/src/triage.ts
  - orchestrator/src/runners/security-triage.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three independent tighten-only judgments. Each can only add caution: raise a
complexity factor, attach a label for the operator, or flag suspicious text. None can
lower a score, mark anything safe, or take an automatic action. RFC-0049 section 5,
Group C.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`. Its Open Questions
  are resolved; do not edit that section. If the RFC and this task disagree, stop and
  return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No vendor SDK and no new runtime dependency. HTTP goes through an injectable `fetch`;
  tests never touch the network.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **`complexity.factors`**: `egressClass` `work-item-text`, `riskClass` `tighten`,
   `direction` `tighten-only`. The boolean factors consumed by
   `reference/src/policy/complexity.ts` (such as security sensitivity and API change)
   are assumed supplied today. Add one Noul per boolean factor over the work item text,
   consulted where the factor input is built for admission
   (`orchestrator/src/admission-score.ts`). A Noul above threshold sets the factor to
   true; nothing sets a factor to false or lowers a numeric factor. The existing
   formula and weights are unchanged. This runs in `orchestrator`, so it needs a small
   orchestrator-side context builder mirroring the pipeline-cli one and attaching the
   cost sink from AISDLC-631.
2. **`failure.class`**: `egressClass` `agent-output`, `riskClass` `tighten`,
   `direction` `tighten-only`. For a failure the orchestrator failure playbook left
   unmatched, a Choice over the four classes used by
   `pipeline-cli/src/tui/analytics/quality-classifier.ts` plus an explicit
   none-of-these option. The result is an advisory label on the existing
   classification output for the operator; the existing binary heuristic result is
   kept as the primary value, and no retry or recovery action is derived from the
   label.
3. **`triage.injection-screen`**: `egressClass` `work-item-text`, `riskClass`
   `tighten`, `direction` `tighten-only`. In `orchestrator/src/triage.ts`, before the
   existing security triage runs on externally authored issue text: one Noul per hazard
   (text that addresses the reading model with instructions; text that asks for
   secrets, credentials or tokens; text that asks to disable checks, reviews or
   governance rules). Any Noul above threshold adds a finding and sets a suspicious
   flag that the triage result carries forward; the existing triage still runs and its
   own reject threshold is unchanged. The screen never marks text safe and never skips
   the existing triage.

## Acceptance Criteria
- [ ] With the layer disabled, admission scores, quality classification and triage results are unchanged on existing fixtures.
- [ ] `complexity.factors` can turn a false boolean factor true and cannot turn a true factor false or reduce the computed complexity (property-style test over the fixture set).
- [ ] `failure.class` is consulted only for failures the playbook did not match, and its label appears alongside, not in place of, the existing classification.
- [ ] `triage.injection-screen` adds a finding and the suspicious flag when a hazard Noul clears its threshold, and the existing security triage still runs in that case.
- [ ] A low injection probability leaves the triage result exactly as the existing triage produced it.
- [ ] The orchestrator-side context builder writes a `cost_ledger` row for an uncached evaluation and abstains cleanly with the layer disabled.
- [ ] Each of the three definitions is registered with `direction` `tighten-only` and provides `agrees`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
