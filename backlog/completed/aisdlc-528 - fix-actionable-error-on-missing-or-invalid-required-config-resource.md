---
id: AISDLC-528
title: >-
  fix(orchestrator): actionable error on missing/invalid required config
  resource instead of silent-skip then confusing downstream throw
status: Done
assignee: []
labels:
  - bug
  - adopter-experience
  - ci:no-issue-required
dependencies: []
priority: medium
references:
  - orchestrator/src/config.ts
  - orchestrator/src/validate-config.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
External contributor (GitHub #870) reports a confusing failure mode: the getting-started docs suggest a simple `.ai-sdlc/` YAML config, but the JSON Schema requires fields the simple example omits (`promotionCriteria`, `demotionTriggers`, `permissions`, `guardrails`, `monitoring`). A config that fails schema validation is **silently skipped** by the loader (`orchestrator/src/config.ts` skips non-validating/non-resource docs), and then `execute.ts` later throws a cryptic `No QualityGate resource found` — with no link back to the real cause (the QualityGate config was silently dropped because it didn't validate).

Two parts:

1. **Diagnosability (the bug):** when a config file that DOES declare a resource (`apiVersion` + `kind` present) fails schema validation, the loader must NOT silently drop it and let a downstream "resource not found" throw be the only signal. Surface an actionable error/warning that names the file, the `kind`, and the specific schema violation(s), so the adopter knows *which* file to fix and *why*. (Contrast: genuinely non-resource YAMLs — no `apiVersion`/`kind` — should still be skipped silently; that's the AISDLC-722 guard. This task is about resource-shaped files that fail their schema.)

2. **Working minimal examples (the DX):** provide a minimal `.ai-sdlc/` config example (in docs and/or the `init` scaffold) that actually PASSES schema validation, so the getting-started path doesn't produce silently-broken configs. If the schema's required fields are genuinely necessary, the minimal example must include them; if some are over-required for a minimal setup, note that as a follow-up (do not relax the schema in this task without operator sign-off — schema shape is a contract).

Implementer: confirm exact loader/validator behavior in `config.ts` + `validate-config.ts` (note AISDLC-722 is adding a null/non-resource guard to validate-config.ts in parallel — coordinate so the two don't conflict; this task is about resource-shaped-but-invalid files, that task is about non-resource/null files).

Scope: `orchestrator/` + docs/scaffold for the minimal example. Do NOT change the JSON Schema's required-field set without flagging it for operator decision.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A config file declaring a resource (`apiVersion`+`kind` present) that FAILS schema validation produces an actionable error/warning naming the file, the kind, and the violation — instead of being silently dropped and surfacing only as a later `No <Kind> resource found` throw
- [x] #2 Genuinely non-resource / null YAML (no apiVersion+kind) is still skipped silently (no regression; coordinate with AISDLC-722)
- [x] #3 A minimal `.ai-sdlc/` config example that PASSES schema validation is provided (docs and/or `init` scaffold); following the getting-started path no longer yields a silently-invalid config
- [x] #4 The JSON Schema required-field set is NOT changed in this task (flag any over-requirement as a follow-up for operator decision)
- [x] #5 Hermetic test: a resource-shaped file with a schema violation produces the actionable error; pnpm build + pnpm -F @ai-sdlc/orchestrator test + lint + format:check pass
<!-- AC:END -->
