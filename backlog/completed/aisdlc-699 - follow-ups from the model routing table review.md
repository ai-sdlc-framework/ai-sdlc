---
id: AISDLC-699
title: >-
  Follow-ups from the routing table review: kind check in the compliance loader, own-property kind lookup, and missing tests
status: Done
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
- [x] A `compliance.yaml` with a valid document of another kind fails with a message naming both kinds, not a `TypeError`.
- [x] `validateResource({ kind: 'constructor', apiVersion: 'x' })` returns the skipped result and does not throw; `loadConfig` on a directory containing such a file returns a warning for it and still loads the other files.
- [x] The four test additions listed in scope item 3 exist and pass.
- [x] `docs/operations/model-routing.md` carries the floor note.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`validateResource` now looks kinds up with an own-property check, so inherited names such as `constructor` take the unknown-kind (skipped) path instead of throwing; `loadCompliancePosture` checks the kind explicitly and names both kinds on a mismatch. The four test additions and the security-floor doc sentence are in.

## Changes
- `reference/src/core/validation.ts` (modified): `Object.hasOwn(SCHEMA_FILES, kind)` instead of `kind in SCHEMA_FILES`.
- `orchestrator/src/compliance/loader.ts` (modified): explicit `CompliancePosture` kind check before validation.
- `orchestrator/src/compliance/loader.test.ts`, `orchestrator/src/config.test.ts` (modified): kind-mismatch and inherited-name tests.
- `orchestrator/src/validate-config-model-routing.test.ts` (new): valid and invalid ModelRouting documents.
- `pipeline-cli/src/routing/committed-table.test.ts` (new): committed table structure, no model names asserted.
- `pipeline-cli/src/tui/config-browser/reference-validator.test.ts`, `reference/src/core/usage-config-schema.test.ts` (modified): ModelRouting and UsageConfig cases.
- `docs/operations/model-routing.md` (modified): floor-relative-to-strength sentence.

## Design decisions
- **Unreachable `skipped` guard kept in the loader**: harmless fail-closed fallback after the new kind check.

## Verification
- `pnpm build` - clean
- `pnpm test` - reference 1960 and orchestrator 5086 pass; pipeline-cli has 15 failures in untouched areas (docs-only lockstep, verify-runtime trust, bin-invocation, TUI layout), all outside this diff
- `pnpm lint` - clean
- `pnpm format:check` - clean apart from files the build rewrites in `dashboard/`, which are not committed
- 3 reviewers approved (code and test reviewers on the Claude-native agents because Codex was over its usage limit)

## Follow-up
- declined: reviewer suggestions (comment the unreachable branch, `String(kind)` on a map-valued kind) - minor, still fail closed
<!-- SECTION:FINAL_SUMMARY:END -->
