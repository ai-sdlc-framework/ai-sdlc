---
id: AISDLC-1309
title: 'Go SDK validates all eleven resource kinds of the reference'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-go
  - sdk-parity
  - conformance
dependencies:
  - AISDLC-1302
  - AISDLC-1305
  - AISDLC-1308
references:
  - reference/src/core/types.ts
  - reference/src/core/validation.ts
  - spec/schemas/design-system-binding.schema.json
  - spec/schemas/design-intent-document.schema.json
  - spec/schemas/journey.v1.schema.json
  - spec/schemas/dor-config.v1.schema.json
  - spec/schemas/compliance-posture.v1.schema.json
  - spec/schemas/judgment-config.v1.schema.json
  - spec/schemas/capabilities-config.v1.schema.json
  - sdk-go/core/types.go
  - sdk-go/core/validation.go
  - sdk-go/core/schemas
  - sdk-go/conformance_test.go
  - conformance/tests/v1alpha1
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: "draft 1, 2 and 4 and file them" (item 1: shrink the parity exemption list for resource kinds). Operator ruling of the same day: resource kinds and schemas match in all three SDKs; the engines of judgment, usage, capabilities and design-system stay TypeScript-only. The survey read the files: the reference has 11 kinds, the Go SDK 5, and `sdk-go/conformance_test.go` runs a fixed list of five fixture directories.'
---

## Description

**Gap.** `ResourceKind` in `reference/src/core/types.ts` has 11 members. The Go SDK defines 5 kind constants in `sdk-go/core/types.go`, embeds 6 schema files under `sdk-go/core/schemas/`, and `UnmarshalResource` and the `SchemaFiles` map of `sdk-go/core/validation.go` refuse the other six kinds (`DesignSystemBinding`, `DesignIntentDocument`, `DorConfig`, `CompliancePosture`, `JudgmentConfig`, `CapabilitiesConfig`). `sdk-go/conformance_test.go` lists five fixture directories by name, so a fixture directory added for a new kind is not run and nothing fails.

**Shape.** The Go SDK accepts and refuses documents of all 11 kinds exactly as the schema in `spec/schemas/` says, and it runs every resource fixture directory of `conformance/tests/v1alpha1/`. The SDK gains no engine, builder or Kubernetes resource for the six kinds.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must an SDK validate a kind whose engine stays TypeScript-only? Yes, by the operator ruling: a resource document is part of the shared contract. 2. Deleted: the fixed list of fixture directories in the conformance test. 3. Simplified or optimised: one generic struct serves the six kinds; no typed spec structs. 4. Accelerated: not applicable. 5. Automated: the conformance test reads the directory, so a new kind's fixtures run without an edit.

- **Kinds.** Add six kind constants to `sdk-go/core/types.go` with the string values of the reference.
- **Generic resource.** Add one struct (API version, kind, metadata, `Spec` as `map[string]any`) that implements `AnyResource`; `UnmarshalResource` returns it for the six kinds. Do not write typed spec structs.
- **Schemas.** Copy the six schema files named in `references`, plus `journey.v1.schema.json`, from `spec/schemas/` to `sdk-go/core/schemas/` byte for byte; add the six kinds to `SchemaFiles` with the file names that `SCHEMA_FILES` of the reference uses. Extend the byte-equality test of AISDLC-1302 to the new files. The `$ref` from the design intent schema to the journey schema must resolve.
- **Conformance test.** Replace the fixed category list in `sdk-go/conformance_test.go` with a read of the directories of `conformance/tests/v1alpha1/` other than `behavioral`. A directory that cannot be read fails the test instead of skipping.
- **Parity exemptions.** Remove the six kinds from the `go` list of the `resourceKinds` section of `conformance/parity/exemptions.json`.
- **Stop rule.** If the fixture directories of the six kinds are absent on the base, stop and report in the verdict notes; do not write fixtures in this task.

Out of scope: builders; `sdk-go/operator/` (CRDs, deepcopy, RBAC, Helm); the `priority-scoring` behavioural fixtures that the Go test skips; the Python SDK; changes to `spec/schemas/`, `reference/` or `conformance/tests/`.

## Acceptance Criteria

- [ ] #1 `sdk-go/core/types.go` has 11 kind constants whose values equal the members of `ResourceKind` in `reference/src/core/types.ts`, and a test asserts the set.
- [ ] #2 Validation accepts the valid fixture and refuses the invalid fixture of each of the six new kinds.
- [ ] #3 Each new file under `sdk-go/core/schemas/` is byte-equal to the file in `spec/schemas/`, and a test asserts it.
- [ ] #4 `sdk-go/conformance_test.go` names no fixture directory; it runs every directory of `conformance/tests/v1alpha1/` except `behavioral`, and an unreadable directory fails the test.
- [ ] #5 `conformance/parity/exemptions.json` has no entry in `go` / `resourceKinds`, and the Go parity test passes.
- [ ] #6 No file under `sdk-go/operator/`, `sdk-go/builders/`, `spec/schemas/`, `reference/` or `conformance/tests/` is in the diff.
- [ ] #7 `go build ./... && go vet ./... && go test ./...` pass in `sdk-go/`, and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
