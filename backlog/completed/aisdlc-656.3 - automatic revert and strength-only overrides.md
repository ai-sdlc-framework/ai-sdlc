---
id: AISDLC-656.3
title: >-
  RFC-0050 OQ-3 part 3: automatic revert to the previous model, ModelRoutingOverrideApplied event and strength-only override writer
status: Done
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
updated_date: '2026-10-10 21:51'
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
- [x] A cell whose approval rate falls more than 5 points below its evidence rate over 30 tasks since the change gets an override to its previous model, a `ModelRoutingOverrideApplied` event and an informational Decision; 29 tasks or 5 points does not.
- [x] Writing an override to a weaker or equal model is refused, and a hand-edited weaker override is ignored by the resolver.
- [x] A symlinked `_routing` directory or `overrides.json` that resolves outside `.ai-sdlc/artifacts` is refused.
- [x] An override is dropped once the table cell it covers changes.
- [x] The new event validates against the updated events schema and the full reference schema test passes.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Each orchestrator tick now drops overrides whose routing-table cell changed, then judges every cell an applied proposal changed. When the changed model's first-pass approval over at least minTasks tasks since the change is more than marginPoints below the rate in the evidence that justified the change, the cell is overridden back to its previous (stronger) model, a `ModelRoutingOverrideApplied` event is emitted and one informational Decision is filed. The override writer only ever strengthens a cell and refuses symlinks that leave the artifacts directory.

## Changes
- `pipeline-cli/src/routing/overrides.ts` (modified): `writeOverride` (strength-only, realpath containment, records `tableModel`), `dropStaleOverrides`, `safeOverridesPath`; the reader ignores an out-of-tree file.
- `pipeline-cli/src/routing/revert.ts` (new): pure `evaluateReverts` (30 tasks, more than 5 points, idempotent on an existing override).
- `pipeline-cli/src/orchestrator/routing-revert.ts` (new): tick adapter `runRoutingReverts`, evidence reader, escaped informational Decision, event emission.
- `pipeline-cli/src/orchestrator/loop.ts`, `pipeline-cli/src/cli/orchestrator.ts` (modified): `routingRevert` adapter called each tick and wired in production.
- `pipeline-cli/src/orchestrator/events.ts`, `spec/schemas/orchestrator-events.v1.schema.json`, `reference/src/core/generated-schemas.ts` (modified): new event type and fields.
- `pipeline-cli/src/routing/evaluate-cell.ts`, `pipeline-cli/src/usage/route-commands.ts`, `pipeline-cli/src/routing/index.ts` (modified): export shared helpers (`rowsFor`, `aggregate`, `collect`).
- Tests (new): overrides, revert, routing-revert, loop.routing-revert; events-schema additions.

## Design decisions
- **Evidence benchmark**: the table cell's single `evidence` reference is read for its first-pass rate and `generatedAt`; the window "since the change" starts at that time. The reference must be a safe path inside the artifacts directory and describe the same role and model.
- **Attribution**: like a proposal, a revert needs repository-attributable evidence (matching repoId, zero legacy and unavailable records); otherwise it does nothing.
- **Lifetime**: an override records the table model it covers and is dropped on the next tick once the cell differs; hand-written entries without `tableModel` are left alone.

## Verification
- `pnpm build` — clean
- `pnpm lint` — clean (including clock-discipline)
- `pnpm format:check` — clean
- `pnpm dark-code:check` — clean
- `pnpm test` — pipeline-cli 10232 passed; 14 failures in bin-invocation, verify-runtime and tui suites that fail identically on untouched main (environment-dependent); reference and the touched suites all pass
- 3 reviews approved (Claude-native code and test reviewers because Codex quota was exhausted)

## Follow-up
(none)
