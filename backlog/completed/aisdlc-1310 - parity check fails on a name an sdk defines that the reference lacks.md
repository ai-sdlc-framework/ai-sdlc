---
id: AISDLC-1310
title: 'Parity check fails on a name an SDK defines that the reference lacks'
status: Done
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-go
  - sdk-parity
  - conformance
dependencies:
  - AISDLC-1305
  - AISDLC-1306
  - AISDLC-1307
references:
  - conformance/README.md
  - sdk-python/src/ai_sdlc/metrics/types.py
  - sdk-python/src/ai_sdlc/telemetry/semantic_conventions.py
  - sdk-python/src/ai_sdlc/compliance/mappings.py
  - sdk-go/metrics/types.go
  - sdk-go/telemetry/conventions.go
  - sdk-go/compliance/mappings.go
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: "draft 1, 2 and 4 and file them" (item 2: the parity check is one-way). The survey read the files: before AISDLC-1306 and AISDLC-1307 the Go SDK defined 8 standard metrics, 28 telemetry names and 30 compliance control ids that the reference does not have, and no test saw it. The Python SDK defines none.'
---

## Description

**Gap.** The parity tests of AISDLC-1305 compare one way: a name of the manifest that an SDK lacks fails the SDK suite. A name that an SDK defines and the manifest does not have passes. This is how the Go SDK came to carry its own metric names, telemetry names and compliance control ids. AISDLC-1306 and AISDLC-1307 remove those names, and nothing stops the next one.

**Shape.** In each section of the parity manifest, the set of names an SDK defines is a subset of the manifest. An SDK-only name fails that SDK's suite. There is no exemption list for this direction.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: may an SDK ever carry a shared-contract name of its own? No, by the operator ruling of 2026-11-17: metric names, telemetry names, compliance ids and resource kinds are those of the reference; a new name enters through the reference. 2. Deleted: nothing. 3. Simplified or optimised: one more assertion per section in the two existing parity tests; no new file, no script change, no exemption list. 4. Accelerated: not applicable. 5. Automated: the assertion runs in both SDK suites, which the gate already starts on a change under `conformance/`, `sdk-python/` or `sdk-go/`.

- **Python test.** In the parity test of the Python suite, for each manifest section, assert that every name the SDK defines (by the section mapping the test already has) is in the manifest section. The failure message lists the SDK-only names and says that a name is added to the reference first.
- **Go test.** The same assertion in the Go parity test.
- **Docs.** The "Parity manifest" section of `conformance/README.md` states both directions and that the reverse direction has no exemptions.
- **Stop rule.** If the assertion finds an SDK-only name on the base tree, do not remove or rename it and do not add an exemption; list the names per SDK and section in the verdict notes and stop.

Out of scope: names outside the manifest sections (for example the Kubernetes types of `sdk-go/operator/`); behaviour vectors; changes to `reference/` or to the manifest generator.

## Acceptance Criteria

- [ ] #1 The Python parity test fails when a name absent from the manifest is added to one of the SDK's mapped definitions; a test asserts this with a patched definition.
- [ ] #2 The Go parity test fails in the same case; a test asserts this on a constructed name set.
- [ ] #3 `conformance/parity/exemptions.json` and the manifest generator are not in the diff.
- [ ] #4 `conformance/README.md` describes both directions.
- [ ] #5 The Python and Go suites pass, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
