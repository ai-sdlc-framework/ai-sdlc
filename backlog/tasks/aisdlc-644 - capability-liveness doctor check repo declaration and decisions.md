---
id: AISDLC-644
title: >-
  RFC-0049 OQ-7: capability-liveness doctor check, required-capabilities declaration, Decision filing, runbook
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0049
  - capability-liveness
  - doctor
  - decisions
  - adopter
  - docs
dependencies:
  - AISDLC-643
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - orchestrator/src/cli/commands/doctor-checks.ts
  - docs/operations/doctor.md
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/bin/cli-decisions.mjs
  - docs/operations/README.md
  - docs/operations/fail-soft-at-the-adopter-boundary.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Makes a degraded capability visible to the operator without blocking anything.
RFC-0049 section 9.3 and the OQ-7 resolution: doctor reports `fail`, the orchestrator
tick files a Decision, and no tick or PR check is ever refused because a capability is
degraded.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0049-system-one-judgment-layer.md`, section 9. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, 80% line coverage on new code.
  Scripts under `scripts/` use `node --test`.
- Every new module is reachable from a non-test importer or a barrel re-export, so the
  dark-code gate passes (`pnpm dark-code:check`).
- Strings an adopter can see (errors, CLI output, templates) carry no internal task ids.

## Scope
1. **Schema and loader:** new `spec/schemas/capabilities-config.v1.schema.json` for
   kind `CapabilitiesConfig` with `spec.required` (list of capability ids). Register it
   with the AJV instance, regenerate and commit
   `reference/src/core/generated-schemas.ts`, and run the full `reference` test suite.
   The loader reads `.ai-sdlc/capabilities.yaml` from the base ref with `git show`, the
   same trust model as `pipeline-cli/src/steps/reviewer-set.ts`; a missing or invalid
   file means an empty required list; it never throws. An id in `required` that is not
   registered is reported by doctor as a configuration warning.
2. **Doctor check** `capability-liveness` in
   `orchestrator/src/cli/commands/doctor-checks.ts`: prints one row per registered
   capability with current status, counts and the last degraded reason. Severity:
   `fail` when a required capability is `degraded` or `never-observed`; `warn` when a
   required capability is `shadow`; `pass` otherwise. With an empty required list the
   check passes and the table is informational. Document it in
   `docs/operations/doctor.md`.
3. **Event:** add `CapabilityDegraded` to the event type union in
   `pipeline-cli/src/orchestrator/events.ts` and to
   `spec/schemas/orchestrator-events.v1.schema.json`.
4. **Decision filing** in the orchestrator tick: for each required capability whose
   status is `degraded` or `never-observed`, emit `CapabilityDegraded` and file one
   Decision through the Decision Catalog library with three options (wire the
   capability, remove it from the required list, accept the degraded state until a
   stated date). At most one Decision per capability per calendar day, and none while
   an open Decision for that capability exists. The tick continues normally in every
   case; a failure to file is logged and swallowed.
5. **This repository's declaration:** add `.ai-sdlc/capabilities.yaml` requiring the
   eight capabilities that have an owning wiring task in the RFC-0049 section 9.1
   table.
6. **Init template:** `.ai-sdlc/templates/capabilities.yaml`, commented, with an empty
   required list.
7. **Docs:** `docs/operations/capability-liveness.md` (what a capability is, the three
   outcomes, the state file, the doctor table, how to declare requirements, what the
   Decision means and how to answer it), linked from `docs/operations/README.md`, and
   a short section in `docs/operations/fail-soft-at-the-adopter-boundary.md` stating
   the corollary: degrade, and report the degradation. The new document cites RFC-0049
   by id.

## Acceptance Criteria
- [ ] With no `.ai-sdlc/capabilities.yaml` on the base ref, the doctor check passes, prints the table, and the tick files no Decision.
- [ ] A required capability that is `degraded` or `never-observed` makes the doctor check `fail`; one in `shadow` makes it `warn`; all required capabilities `live` makes it `pass`.
- [ ] The tick files exactly one Decision for a degraded required capability, files none on a second tick the same day, and files none while that Decision is open.
- [ ] The orchestrator tick dispatches normally when required capabilities are degraded and when Decision filing throws (asserted in a test).
- [ ] `CapabilityDegraded` validates against the updated events schema and appears in the type union.
- [ ] The config schema is registered with AJV, `generated-schemas.ts` is regenerated and committed, and `pnpm validate-schemas` passes.
- [ ] The loader ignores a working-tree copy of the file and reads only the base ref.
- [ ] `.ai-sdlc/capabilities.yaml` in this repository lists exactly the eight capabilities with an owning wiring task, and the init template lists none.
- [ ] `docs/operations/capability-liveness.md` exists, cites `RFC-0049`, is linked from `docs/operations/README.md`, and contains no internal task ids.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
