---
id: AISDLC-174
title: >-
  Register DorConfig as a recognized resource kind in @ai-sdlc/reference
  validator
status: Done
assignee: []
created_date: '2026-05-03 23:06'
updated_date: '2026-05-04 16:49'
labels:
  - bug
  - orchestrator
  - schema
dependencies: []
references:
  - orchestrator/src/config.ts
  - orchestrator/src/config.test.ts
  - .ai-sdlc/dor-config.yaml
  - spec/schemas/
  - reference/
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`orchestrator/src/config.test.ts > loadConfig() — non-fatal warnings > does not include warnings field when every file loads cleanly` is failing on `origin/main` HEAD. The test expects `config.warnings` to be `undefined`, but receives:

```js
[{ file: "dor-config.yaml", error: "validation failed: /spec: must NOT have additional properties" }]
```

## Root cause

`orchestrator/src/config.ts:120` calls `validateResource(doc)` on every YAML file in `.ai-sdlc/`. The reference validator (`@ai-sdlc/reference`) only knows about Pipeline, AgentRole, QualityGate, AutonomyPolicy, AdapterBinding, DesignSystemBinding, and DesignIntentDocument. `DorConfig` (introduced in commit `a7fab6e`) was never registered. Subsequent additions (e.g. `blastRadiusThreshold` in `51ca49b`) tripped the schema's "additionalProperties: false" — but the deeper bug is that the entire kind is unrecognized.

## Fix options

1. **Preferred**: register `DorConfig` as a resource kind in `@ai-sdlc/reference` (add JSON schema under `spec/schemas/`, wire into the validator registry). This makes `dor-config.yaml` validate against its real schema.
2. **Quick fix**: filter `dor-config.yaml` (and `*-dor-config.yaml`) out of the resource-validation loop in `orchestrator/src/config.ts` before calling `validateResource()`. Loses the validation but unblocks the test.

Option 1 is the right durable fix — it's the same pattern other RFC-0011 resources will follow.

## Impact

- Pre-push `check-coverage.sh` gate fails for any branch that touches the orchestrator workspace (forces operators to use `AI_SDLC_SKIP_COVERAGE_GATE=1` even for unrelated changes).
- CI's orchestrator workflow goes red on every PR that doesn't paths-ignore orchestrator.
- Discovered while pushing PR #209's RFC-0009 frontmatter fix (`AI_SDLC_SKIP_COVERAGE_GATE=1` was used to push since the fix was docs-only and CI's `paths-ignore: spec/rfcs/**` skips orchestrator anyway).

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 DorConfig registered as a resource kind in @ai-sdlc/reference (JSON schema added under spec/schemas/ + validator registry updated)
- [ ] #2 orchestrator/src/config.test.ts > loadConfig() — non-fatal warnings test passes against current .ai-sdlc/dor-config.yaml on main
- [ ] #3 Pre-push coverage gate runs cleanly without AI_SDLC_SKIP_COVERAGE_GATE=1 for branches touching only docs
- [ ] #4 Schema covers all current dor-config.yaml fields including blastRadiusThreshold (commit 51ca49b)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
No-op closure. AISDLC-174 was filed on 2026-05-03 to register DorConfig as a recognized resource kind in `@ai-sdlc/reference`. Dispatch investigation on 2026-05-04 found all 4 ACs were already satisfied by prior commits on main — specifically AISDLC-115.1 (`385e660` "feat: rfc-0011 phase 1 schema + needs-clarification status").

## Pre-existing implementation found
- Schema: `spec/schemas/dor-config.v1.schema.json`
- Validator entry: `reference/src/core/validation.ts:35`
- ResourceKind union: `reference/src/core/types.ts:20`
- SCHEMAS map: `reference/src/core/generated-schemas.ts:4507`
- Schema covers all current dor-config.yaml fields including `blastRadiusThreshold` (AC #4)
- 15 DorConfig schema tests at `reference/src/core/dor-schemas.test.ts`

## Verification
- `pnpm --filter @ai-sdlc/orchestrator test src/config.test.ts` — 9/9 pass including the previously-failing `does not include warnings field when every file loads cleanly` test
- Full orchestrator suite: 2997/2997 passing
- Full reference suite: 1258/1258 passing

## Acceptance criteria status
- AC #1 (DorConfig registered) — ✅ already done
- AC #2 (config.test.ts passes) — ✅ verified
- AC #3 (pre-push coverage gate clean without skip) — ✅ underlying cause resolved
- AC #4 (schema covers blastRadiusThreshold) — ✅ verified

## Why filed in error
Bug was filed during the 2026-05-03 witness test of `cli-orchestrator start`. The pre-push coverage gate failed on the dor-config issue, making it look unfixed — but the actual fix was in a separately-merged PR. Future no-op detections like this should land in RFC-0025's framework-quality monitoring corpus as a `redundant-task` signal.

## Follow-up
(none — pre-push coverage gate dor-config issue is resolved)
<!-- SECTION:FINAL_SUMMARY:END -->
