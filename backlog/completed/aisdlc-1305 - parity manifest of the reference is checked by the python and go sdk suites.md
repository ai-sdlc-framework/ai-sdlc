---
id: AISDLC-1305
title: 'Parity manifest of the reference is checked by the Python and Go SDK suites'
status: Done
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-go
  - sdk-parity
  - conformance
dependencies: []
references:
  - conformance/README.md
  - reference/src/core/types.ts
  - reference/src/metrics/types.ts
  - reference/src/telemetry/semantic-conventions.ts
  - reference/src/compliance/mappings.ts
  - sdk-python/tests/test_conformance.py
  - sdk-go/conformance_test.go
  - scripts/check-dark-code.mjs
  - package.json
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: "draft the parity test task as 1305 and file it". The SDK survey of the same day found drift that no test sees: 5 of 11 resource kinds in each SDK, 22 of 27 standard metrics and 34 of 46 telemetry keys in Python, different metric and telemetry names and a different compliance model in Go.'
---

## Description

**Gap.** The conformance fixtures under `conformance/tests/v1alpha1/` check that the Python and Go SDKs accept and refuse the same resource documents as the reference. Nothing checks that an SDK defines the same named things as the reference: resource kinds, standard metric names, telemetry names and keys, compliance control ids. A name added to `reference/` reaches no SDK test, so the SDKs fall behind without a failing check.

**Shape.** One committed file lists the named surface of the TypeScript reference. It is generated from the reference and CI fails when it is out of date. The Python suite and the Go suite each compare their own names with it. What an SDK lacks today is written in an exemption file that can only shrink.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a new check needed, or do the conformance fixtures suffice? They test documents, not names; the drift the survey found passes them. 2. Deleted: nothing. 3. Simplified or optimised: one JSON file for all languages, under `conformance/`, so the existing path filter of the gate (`conformance/**`) already starts both SDK jobs when it changes; no workflow change. One direction only: every name of the reference must exist in the SDK or be exempt. 4. Accelerated: the check of the manifest itself runs in the root `pnpm test`, without Python or Go. 5. Automated: generation is a script; staleness and growth of the exemption file fail CI.

- **Manifest.** `conformance/parity/manifest.json`, written by a new script `scripts/generate-parity-manifest.mjs` from the built `reference` package. Sections, each a sorted list of strings: `resourceKinds`; `standardMetrics` (the `name` of each entry of `STANDARD_METRICS`); `telemetrySpanNames`, `telemetryMetricNames`, `telemetryAttributeKeys` (the values of `SPAN_NAMES`, `METRIC_NAMES`, `ATTRIBUTE_KEYS`); `complianceControlIds` (the ids of `AI_SDLC_CONTROLS`); `regulatoryFrameworkIds` (the ids of `REGULATORY_FRAMEWORKS`). `ResourceKind` is only a type today: add an exported constant list beside it in `reference/src/core/types.ts` and derive the type from the list, with no change to the type's members.
- **Staleness check.** A root script `parity:check` (`node scripts/generate-parity-manifest.mjs --check`) fails when the committed manifest differs from what the reference yields, and prints the command that regenerates it. Add it to the root `test` script beside `dark-code:check`.
- **Exemptions.** `conformance/parity/exemptions.json`: for `python` and for `go`, per section, the sorted list of manifest names that the SDK does not define today. Compute it from the tree at the time of the work; do not copy counts from this task. `parity:check` also fails when a list has an entry that the file on the base ref (`origin/main`) does not have, the same ratchet as `scripts/check-dark-code.mjs`; the first version of the file is accepted as it is.
- **SDK tests.** One Python test and one Go test read both files from the repository. For each section the test computes the manifest names the SDK does not define and asserts that this set equals the SDK's exemption list exactly. So a new name in the reference fails both SDK suites until it is implemented, and an implemented name fails until its exemption is removed.
- **Mapping.** Each SDK test states in one table how a section maps to the SDK's own definitions (for example the Python module and constant that hold the telemetry keys). Compare string values, not identifier names. Where an SDK has no counterpart for a whole section (for example Go has no `AI_SDLC_CONTROLS`), every name of that section goes to its exemption list.
- **Docs.** `conformance/README.md` gains a section "Parity manifest": what the two files are, the regenerate command, and that the exemption file only shrinks.
- **Stop rule.** Do not add, rename or remove a name in either SDK to make a list shorter; this task records the state. If the reference package cannot be loaded by a plain Node script after `pnpm build`, stop and report in the verdict notes.

Out of scope: names an SDK has that the reference lacks; shared input and output vectors for behaviour (policy evaluation, compliance mapping, metric computation); the priority-scoring fixtures that both SDKs skip; any workflow file; the SDK scope decision.

## Acceptance Criteria

- [ ] #1 `conformance/parity/manifest.json` exists with the seven sections named above, each a sorted list, and `node scripts/generate-parity-manifest.mjs` on the merged tree leaves no diff.
- [ ] #2 `pnpm parity:check` fails when a name is added to `STANDARD_METRICS` in the reference without regenerating the manifest; a test of the script asserts this on a fixture.
- [ ] #3 `pnpm parity:check` fails when `conformance/parity/exemptions.json` gains an entry that the base ref does not have; a test of the script asserts this on a fixture.
- [ ] #4 `parity:check` is part of the root `test` script.
- [ ] #5 The Python suite has a test that fails when a manifest name is neither defined in the SDK nor exempt, and fails when an exempt name is defined; the same holds for the Go suite.
- [ ] #6 No name in `sdk-python/src/` or `sdk-go/` was added, renamed or removed, and `ResourceKind` in the reference has the same eleven members as before.
- [ ] #7 `conformance/README.md` describes the manifest, the exemption file and the regenerate command.
- [ ] #8 The Python and Go suites pass, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
