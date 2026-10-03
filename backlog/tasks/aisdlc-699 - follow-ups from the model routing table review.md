---
id: AISDLC-699
title: >-
  Follow-ups from the routing table review: kind check in the compliance loader, own-property kind lookup, and missing tests
status: To Do
assignee: []
created_date: '2026-10-03'
labels:
  - reference
  - orchestrator
  - tests
  - model-routing
dependencies: []
references:
  - reference/src/core/validation.ts
  - orchestrator/src/compliance/loader.ts
  - orchestrator/src/validate-config.ts
  - orchestrator/src/config.ts
  - pipeline-cli/src/tui/config-browser/reference-validator.ts
  - pipeline-cli/src/routing/load-table.ts
  - reference/src/core/usage-config-schema.test.ts
priority: medium
dispatchable: true
blocked:
  reason: "Builds on pull request 1174 (routing table and validateResource change); remove this block once it is merged"
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The pull request that lands this repository's model routing table (#1174) changes
`validateResource` so that `ModelRouting` and `UsageConfig` documents are validated
against their own schemas. Its two review rounds approved it and left minor findings
and suggestions, which the operator asked to have filed (2026-10-03). None is a defect
in normal operation; each is a small hardening or a missing test.

Start this task only once that pull request is on `main`: the routing table file and
the changed `validateResource` are what it builds on. Until then it carries a
`blocked.reason`.

## Conventions
- TypeScript strict, ESM, Vitest, 80% line coverage on new code.
- Tests that read this repository's real `.ai-sdlc/` directory resolve it from the test
  file's location, as `orchestrator/src/config.test.ts` does.

## Scope
1. **Compliance loader kind check.** `loadCompliancePosture` accepts whatever
   `validateResource` validates. A `compliance.yaml` holding a valid document of another
   kind then fails later with a `TypeError` on `spec.regimes`. Check the kind explicitly
   and fail with a message naming the expected and the actual kind.
2. **Own-property kind lookup.** `validateResource` uses `kind in SCHEMA_FILES`, which is
   true for inherited names such as `constructor` and `toString`; such a document makes
   the validator throw `Schema not found`, and `loadConfig` does not catch it, so one
   file aborts the whole config load. Use an own-property check so these kinds take the
   unknown-kind path and produce the usual warning.
3. **Tests.**
   - `UsageConfig` through `validateResource`: a document that is valid under the schema
     asserts `valid: true` directly; an invalid one asserts an error path; a typo of the
     kind is skipped.
   - `validate-config`: a valid and an invalid `ModelRouting` document.
   - The config browser's reference validator: a `ModelRouting` document yields no
     unknown-kind warning.
   - The committed `.ai-sdlc/model-routing.yaml` parses with `parseRoutingTable`, every
     cell model is in `strength`, and the security reviewer sits on the strongest entry.
     The test asserts structure, not specific model names, so a later model change does
     not break it.
4. **Security floor note.** Add one sentence to `docs/operations/model-routing.md`
   stating that the security-reviewer floor is relative to the table's own `strength`
   order, so reordering `strength` changes what the floor means.

## Acceptance Criteria
- [ ] A `compliance.yaml` with a valid document of another kind fails with a message naming both kinds, not a `TypeError`.
- [ ] `validateResource({ kind: 'constructor', apiVersion: 'x' })` returns the skipped result and does not throw; `loadConfig` on a directory containing such a file returns a warning for it and still loads the other files.
- [ ] The four test additions listed in scope item 3 exist and pass.
- [ ] `docs/operations/model-routing.md` carries the floor note.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
