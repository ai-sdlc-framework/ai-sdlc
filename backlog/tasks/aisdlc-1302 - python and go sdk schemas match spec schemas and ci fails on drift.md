---
id: AISDLC-1302
title: 'Python and Go SDK schemas match spec/schemas and CI fails on drift'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - sdk-python
  - sdk-go
  - sdk-parity
dependencies: []
references:
  - spec/schemas/pipeline.schema.json
  - sdk-python/scripts/generate_schemas.py
  - sdk-python/src/ai_sdlc/core/_generated_schemas.py
  - sdk-go/core/validation.go
  - sdk-go/core/schemas/pipeline.schema.json
  - .github/workflows/ai-sdlc-gate.yml
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-17: file the three mechanical SDK parity tasks of the survey. The survey compared the files: all six schemas in the Python SDK and four of six in the Go SDK differ from `spec/schemas/`.'
---

## Description

**Gap.** Both SDKs ship their own copy of six resource schemas: `adapter-binding`, `agent-role`, `autonomy-policy`, `common`, `pipeline`, `quality-gate`. `sdk-python/src/ai_sdlc/core/_generated_schemas.py` differs from `spec/schemas/` in all six (for example no `soulOverrides`, no AgentRole `governance`/`scope`/`designSystem`, no Pipeline `parallelism`/`harness`/`model`/`backlog`). `sdk-go/core/schemas/` (embedded by `sdk-go/core/validation.go`) differs in `adapter-binding`, `autonomy-policy`, `common` and `quality-gate`. A resource that the TypeScript reference accepts can be refused by an SDK, and the reverse. Nothing fails when a schema changes in `spec/schemas/`: the SDK jobs of the gate start only for changes under `sdk-python/**` or `sdk-go/**`.

**Shape.** The six schemas in each SDK are the same documents as in `spec/schemas/`, and a change to one of them in `spec/schemas/` without the SDK copies fails CI.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: do the SDKs need their own copies? Yes: each package is published alone and cannot read `spec/` at run time. 2. Deleted: nothing. 3. Simplified or optimised: the set stays at the six schemas both SDKs ship today; the other schemas of `spec/schemas/` are not added (SDK scope is an open operator question). 4. Accelerated: not applicable. 5. Automated: one test per SDK compares its copies with `spec/schemas/`, and the SDK jobs also start when `spec/schemas/**` changes.

- **Python.** `sdk-python/scripts/generate_schemas.py` generates exactly the six schemas named above (an explicit list, not a glob of the directory). Regenerate `_generated_schemas.py`.
- **Go.** Copy the six files from `spec/schemas/` to `sdk-go/core/schemas/` byte for byte.
- **Tests.** A Python test loads each of the six files from `spec/schemas/` and asserts equality with the matching entry of `SCHEMAS`. A Go test asserts that each embedded schema is byte-equal to the file in `spec/schemas/`. Both tests fail (not skip) when `spec/schemas/` is absent in a repository checkout; in a published package without the repository they are not shipped.
- **CI.** In `.github/workflows/ai-sdlc-gate.yml`, add `spec/schemas/**` to the `python` and to the `go` path filter of the `sdk-filter` step. No other workflow change.
- **Fallout.** Where an SDK test or conformance fixture fails because a schema is now current, fix the SDK code or test to accept what the reference accepts. Do not edit files under `spec/schemas/` or `conformance/tests/`. If a fix would need a new public type or a breaking change of a public SDK API, stop and report in the verdict notes.

Out of scope: schemas other than the six; new resource kinds; changes to `spec/schemas/`.

## Acceptance Criteria

- [ ] #1 For each of the six schemas, the entry in `sdk-python/src/ai_sdlc/core/_generated_schemas.py` equals the JSON document in `spec/schemas/`, and a Python test asserts it.
- [ ] #2 For each of the six schemas, the file in `sdk-go/core/schemas/` is byte-equal to the file in `spec/schemas/`, and a Go test asserts it.
- [ ] #3 Running `python sdk-python/scripts/generate_schemas.py` on the merged tree leaves no diff.
- [ ] #4 The `python` and `go` path filters of the gate include `spec/schemas/**`.
- [ ] #5 The Python suite, the Go suite and both conformance runs pass; no file under `spec/schemas/` or `conformance/tests/` changed.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
