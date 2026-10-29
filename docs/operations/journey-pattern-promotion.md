# Journey Pattern Promotion Runbook

**RFC:** RFC-0018 section 11 (practitioner validation)
**Implemented:** AISDLC-470 (Phase 6)

The In-Soul Journey Pattern is promoted out of its initial rollout state only when the InternalAdopter reference implementation validates without regressions. Promotion is corpus-driven, not calendar-driven.

## Corpus

The InternalAdopter corpus lives in `orchestrator/src/variant/internal-adopter/journeys.ts`:

| Product | Journeys |
|---|---|
| ProductA | `onboarding`, `daily-task-management`, `billing-inquiry-resolution` |
| ProductB | `shift-start`, `route-completion`, `end-of-shift-handoff` |
| ProductC | `csr-onboarding` (variant `csr`), `customer-self-service` (variant `customer-portal`), `dispute-resolution` |
| ProductD | `submit-test-results`, `request-extension`, `view-historical-tests` (variant `annual-test`, WCAG `AAA`) |

## Promotion gate (all must hold)

1. `pnpm --filter @ai-sdlc/orchestrator test` passes, including `journeys.test.ts` and `journey/conformance.test.ts`.
2. Every corpus journey validates against `spec/schemas/journey.v1.schema.json` and has no state-machine issues (`validateJourneyStateMachine` returns `[]`).
3. `buildAuditReports` yields exactly one WCAG audit report per journey.
4. No blocking `JourneyEvent` from `validateJourneyDeclarations` for any corpus Soul.
5. No regression versus the previous corpus run: no journey removed, no WCAG level lowered, no new `Decision: journey-state-id-drift` findings against substrate code.
6. Admission scoring on a real work item ranks higher when the targeted journey's `completion-rate` is below `alertBelow` (see [journey-metrics.md](journey-metrics.md)).

## Procedure

1. Run the gate above on `main` and record the result.
2. If any item fails, fix the regression and re-run; do not promote on a partial pass.
3. When the gate is clean, the operator records the promotion in the Decision Catalog (`cli-decisions add --scope rfc:RFC-0018`). Promotion is an operator decision; agents do not self-promote.
4. Re-run the gate after each corpus change; the corpus is the source of truth for regressions.

## Related

- [journey-cross-soul-workaround.md](journey-cross-soul-workaround.md)
- [journey-metrics.md](journey-metrics.md)
- [wcag-version-evolution.md](wcag-version-evolution.md)
