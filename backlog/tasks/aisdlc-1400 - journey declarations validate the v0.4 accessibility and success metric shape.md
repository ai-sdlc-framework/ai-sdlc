---
id: AISDLC-1400
title: 'Journey declarations validate the v0.4 accessibility and success metric shape'
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - rfc-0018
  - journey
  - schema
  - orchestrator
dependencies: []
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/schemas/journey.v1.schema.json
  - spec/schemas/design-intent-document.schema.json
  - spec/schemas/journey-config.v1.schema.json
  - reference/src/core/generated-schemas.ts
  - reference/src/core/journey-schema.test.ts
  - orchestrator/src/journey/inheritance-validator.ts
  - orchestrator/src/variant/internal-adopter/journeys.ts
  - docs/operations/wcag-version-evolution.md
assumes:
  - RFC-0018
priority: medium
---

## Description

**Gap.** RFC-0018 v0.4 (Design Authority editorial pass, PR #2967, on main at `ee3b8a7e4`) changed the journey `accessibility` and `successMetrics` shape. The code still implements v0.3 (AISDLC-465, #824): `journey.v1.schema.json:134` allows `wcagVersion` `3.0`, `:139` allows any `conformanceTarget` from 0 to 100, `:145` leaves `auditCadence` optional, and metric items (`:152`, `additionalProperties: false`) have `targetSeconds` (`:177`) but no `unit` or `direction`.

**Source.** RFC-0018 §9 "v0.4 follow-ups", items 1, 3 (floor, unique ids, non-negative values only) and 7. Spec text: §5.3, §5.4 "Success metric fields", §6.1, §6.3 (migration). Engineering review in the planner session 2026-11-23 accepted these changes as written.

**Out of scope.** `additionalCriteria` (AISDLC-1402), router and scoring changes (AISDLC-1401), audit due dates (AISDLC-1403).

## Fix

- `spec/schemas/journey.v1.schema.json` (and the journey fields in `design-intent-document.schema.json`), per §6.1:
  - `conformanceTarget`: `const: 100`.
  - `wcagVersion`: enum `["2.0","2.1","2.2"]` (`3.0` removed, OQ-7 amendment item 1).
  - `auditCadence`: required (OQ-6 amendment item 1).
  - metric item: `unit` (`ratio` | `seconds` | `count`) and `direction` (`higher-is-better` | `lower-is-better`) required; `targetSeconds` removed; `alertBelow` allowed only with `higher-is-better`, `alertAbove` only with `lower-is-better`; `minimum: 0` on `target`/`alertBelow`/`alertAbove` when `unit` is `seconds` or `count`, and 0 to 1 when `ratio`, in the schema's `allOf`/`if`/`then` (review nit: in the schema, not only the validator).
- Regenerate `reference/src/core/generated-schemas.ts`.
- `orchestrator/src/journey/inheritance-validator.ts`:
  - `wcagVersion` floor: a journey version earlier than the parent's floor is a `JourneyInheritanceViolation`, checked separately from `wcagLevel` (§5.3: 2.1 AAA under a 2.2 AA parent violates). Where the parent declares no floor, the check does not apply.
  - metric ids unique within a journey.
- Loader migration message (§6.3): a v0.3 declaration with `conformanceTarget` below 100, `targetSeconds`, a metric missing `unit`/`direction`, or no `auditCadence` fails with a message naming the field and the v0.4 replacement (for `conformanceTarget`: "declare it as a success metric if still wanted").
- Update the InternalAdopter reference data (`variant/internal-adopter/journeys.ts`) to v0.4, keeping the three ProductD journeys at whole-journey `AAA` (still valid; v0.4 only recommends against it), and update `docs/operations/wcag-version-evolution.md` for the removal of `3.0`.

## Acceptance Criteria

- [ ] #1 Schema tests: `conformanceTarget: 99` rejected; `wcagVersion: "3.0"` rejected; missing `auditCadence` rejected; metric without `unit` or `direction` rejected; `targetSeconds` rejected; `alertAbove` with `higher-is-better` rejected; negative `seconds` value rejected; `ratio` above 1 rejected.
- [ ] #2 Validator tests: 2.1 AAA journey under a 2.2 AA parent is a violation; 2.2 AA under 2.1 AA passes; no parent floor means no check; duplicate metric ids in one journey are a violation.
- [ ] #3 A v0.3 declaration fixture fails with a message naming each offending field and its v0.4 replacement.
- [ ] #4 The InternalAdopter journeys validate against the v0.4 schema; ProductD's three `AAA` journeys still load.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
