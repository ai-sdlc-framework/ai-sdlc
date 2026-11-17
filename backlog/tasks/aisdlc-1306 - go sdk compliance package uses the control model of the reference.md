---
id: AISDLC-1306
title: 'Go SDK compliance package uses the control model of the reference'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-go
  - sdk-parity
  - breaking-change
dependencies: []
references:
  - reference/src/compliance/mappings.ts
  - reference/src/compliance/checker.ts
  - sdk-go/compliance/mappings.go
  - sdk-go/compliance/checker.go
  - sdk-go/compliance/compliance_test.go
  - sdk-go/README.md
  - docs/api-reference/compliance.md
priority: medium
dispatchable: true
dispatchableReason: 'Operator ruling of 2026-11-17 (decision rubric): the Go compliance package is replaced by the reference model in one 0.x release, with a release note. Rejected: keeping the old model beside the new one, removing the package, exempting it from parity. The SDK survey of the same day found that Go maps framework-side ids (AIA-1, GOVERN-1) to feature names, while the reference and the Python SDK map 10 AI-SDLC controls to 40 framework references.'
---

## Description

**Gap.** `reference/src/compliance/mappings.ts` defines 10 AI-SDLC controls (`AI_SDLC_CONTROLS`) and, for each of six regulatory frameworks, a list of mappings from a control id to a reference in that framework (40 in total). `checkCompliance` takes the set of enabled control ids and reports the mappings that are not covered. The Python SDK has the same data. `sdk-go/compliance/mappings.go` has a different model: per framework, a list of framework-side ids (`AIA-1`, `GOVERN-1`, `ASI-01`) each with a list of feature names, and `CheckCompliance` takes enabled feature names. The Go package has no list of AI-SDLC controls and no function that returns all control ids. A coverage figure computed in Go cannot be compared with one computed in TypeScript or Python.

**Shape.** The Go compliance package holds the same controls, the same mappings and the same coverage arithmetic as the reference. The old Go model is removed in the same change, not kept beside the new one.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must Go match? Yes, by the operator ruling: compliance ids are part of the contract that all three SDKs share. 2. Deleted: the feature-name model (`ControlMapping.Features`, `FrameworkMappings`, the framework-side ids) is removed outright; no deprecated alias. 3. Simplified or optimised: data and one checker, written as Go literals; no code generation and no JSON loaded at run time. 4. Accelerated: not applicable. 5. Automated: a Go test compares the control ids and the per-framework mapping counts with the values of the reference.

- **Types.** In `sdk-go/compliance/mappings.go`: `ComplianceControl` (id, name, description) and `ControlMapping` (control id, framework, framework reference, description), with the JSON field names of the reference (`id`, `name`, `description`, `controlId`, `framework`, `frameworkReference`). The `Framework` type and its six constants keep their string values.
- **Data.** `AISDLCControls` with the 10 controls of `AI_SDLC_CONTROLS`, and one mapping list per framework with the entries of the reference, in the order of the reference. Copy ids, references and descriptions exactly. `MappingsForFramework(framework)` returns the list, and an empty list for an unknown framework.
- **Checker.** `CheckCompliance(enabledControls, framework)` reports the framework, the total, the covered count, the gaps (the mappings whose control id is not enabled) and the coverage percent, with the arithmetic of `reference/src/compliance/checker.ts` (an empty mapping list is 100 percent). `CheckAllFrameworks(enabledControls)` returns one report per framework in the order of the reference. `AllControlIDs()` returns the ids of the 10 controls.
- **Removal.** Delete the old `ControlMapping` shape with `Features`, `FrameworkMappings`, `ComplianceResult` and any helper that only the old model used. No exported name of the old model remains.
- **Tests.** Replace `sdk-go/compliance/compliance_test.go`: the control ids equal the 10 ids of the reference (written out in the test, with the reference file named in a comment); the mapping count per framework equals the count in the reference; every mapping names a defined control; full, partial and empty coverage; an unknown framework.
- **Parity exemptions.** If `conformance/parity/exemptions.json` exists on the base, remove the Go entries of the sections `complianceControlIds` and `regulatoryFrameworkIds` that this change makes obsolete, and point the Go parity test at the new definitions.
- **Release note.** The commit is `feat(sdk-go)!:` with a `BREAKING CHANGE:` footer that states: the compliance package now takes AI-SDLC control ids, not feature names, and names the removed exported identifiers. `sdk-go/README.md` gains a short section "Migrating the compliance package" with the removed and the new identifiers side by side. Do not edit `sdk-go/CHANGELOG.md`; release-please writes it from the footer.
- **Docs.** If `docs/api-reference/compliance.md` shows the Go API, change it to the new one.
- **Stop rule.** If code outside `sdk-go/compliance/` in this repository uses the old model, change the caller in the same PR only when it is inside `sdk-go/`; for a caller elsewhere, stop and report it in the verdict notes.

Out of scope: the Python SDK; metric and telemetry names in Go; new controls or mappings that the reference does not have; the `operator/` package.

## Acceptance Criteria

- [ ] #1 `sdk-go/compliance` defines the 10 controls of `AI_SDLC_CONTROLS` with the ids, names and descriptions of the reference, and a test asserts the full id set.
- [ ] #2 For each of the six frameworks the Go mapping list has the same control ids and framework references as the reference, in the same order, and a test asserts the count per framework and the total of 40.
- [ ] #3 `CheckCompliance` with all control ids enabled reports 100 percent and no gaps for every framework; with none enabled it reports 0 percent and every mapping as a gap; a test asserts both.
- [ ] #4 `AllControlIDs` returns exactly the 10 ids.
- [ ] #5 No exported identifier of the old model remains in `sdk-go/` (`FrameworkMappings`, `ComplianceResult`, a `Features` field), and `grep -rn "AIA-1" sdk-go/` finds nothing.
- [ ] #6 The commit subject starts with `feat(sdk-go)!:` and its body has a `BREAKING CHANGE:` footer; `sdk-go/README.md` has the migration section; `sdk-go/CHANGELOG.md` is not in the diff.
- [ ] #7 If `conformance/parity/exemptions.json` exists, it has no Go entry for a compliance control id or framework id that the package now defines, and the Go parity test passes.
- [ ] #8 `go build ./... && go vet ./... && go test ./...` pass in `sdk-go/`, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
