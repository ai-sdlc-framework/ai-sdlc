---
id: AISDLC-656.3
title: >-
  RFC-0050 OQ-3 part 3: automatic revert to the previous model, ModelRoutingOverrideApplied event and strength-only override writer
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0050
  - model-routing
  - decisions
  - orchestrator
dependencies:
  - AISDLC-656.1
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
  - pipeline-cli/src/usage/scorecard-commands.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Third of three parts of AISDLC-656 (operator-approved split, 2026-10-02). Under the
asymmetric rule the operator chose, a return to a stronger model after measured
inferiority is automatic. This part adds the revert check, the event, and the
override writer that can only strengthen a cell.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`, section B5
  and the OQ-3 resolution. Do not edit the RFC's Open Questions. If the RFC and this
  task disagree, stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No prompt, response, file content or tool output is written, logged or put in a
  fixture. Fixtures are synthetic. Tests never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.
- New event ids go in `KNOWN_CAPABILITY_IDS` in `scripts/check-rfc-docs.mjs` only if
  that script lists events; otherwise leave it alone.

## Scope
1. **Automatic revert:** `evaluateReverts` runs each tick. For a cell changed by an
   applied proposal (the table carries the evidence reference and previous model from
   AISDLC-656.2), when its current model's first-pass approval rate over at least
   `minTasks` tasks since the change is more than `marginPoints` below the rate
   recorded in the evidence that justified the change, write an override for that cell
   to its previous model in `overrides.json` under the artifacts directory, emit
   `ModelRoutingOverrideApplied`, and file an informational Decision.
2. **Event:** add `ModelRoutingOverrideApplied` to the event type union in
   `pipeline-cli/src/orchestrator/events.ts` and to
   `spec/schemas/orchestrator-events.v1.schema.json`; register the schema `$ref` in
   `getAjv()` and commit the regenerated `generated-schemas.ts`.
3. **Strength-only writer:** the override writer refuses any override whose model is
   not stronger than the cell's table model in the table's `strength` order, and the
   resolver from AISDLC-654 ignores a non-conforming entry. The writer resolves the
   `_routing` and `overrides.json` paths with realpath and refuses a symlink that
   leaves `.ai-sdlc/artifacts`. Model names in Decision text are escaped.
4. **Lifetime:** an override stays until the table cell it covers changes, then it is
   dropped on the next tick.

## Acceptance Criteria
- [ ] A cell whose approval rate falls more than 5 points below its evidence rate over 30 tasks since the change gets an override to its previous model, a `ModelRoutingOverrideApplied` event and an informational Decision; 29 tasks or 5 points does not.
- [ ] Writing an override to a weaker or equal model is refused, and a hand-edited weaker override is ignored by the resolver.
- [ ] A symlinked `_routing` directory or `overrides.json` that resolves outside `.ai-sdlc/artifacts` is refused.
- [ ] An override is dropped once the table cell it covers changes.
- [ ] The new event validates against the updated events schema and the full reference schema test passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
