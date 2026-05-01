---
id: AISDLC-100.6
title: 'Phase 6: Add pipelineVersion field to attestation envelope'
status: Done
assignee: []
created_date: '2026-04-30 22:59'
labels:
  - rfc-0012
  - phase-6
  - attestation
dependencies:
  - AISDLC-100.1
references:
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - orchestrator/src/runtime/buildPredicate.ts
  - scripts/verify-attestation.mjs
  - .ai-sdlc/schemas/attestation.v1.schema.json
parent_task_id: AISDLC-100
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0012 Phase 6 (Section 11) and §10. Add `pipelineVersion` to the attestation predicate so envelopes record which pipeline version produced them. Forensic / audit purpose — verifier doesn't enforce specific versions.

## What changes

- Update sign-attestation script (`ai-sdlc-plugin/scripts/sign-attestation.mjs`) to read `@ai-sdlc/pipeline-cli` version from its `package.json` and include in predicate as `pipelineVersion`
- Update `orchestrator/src/runtime/buildPredicate.ts` (the predicate builder) to include `pipelineVersion`
- Update `verify-attestation.mjs` to read `pipelineVersion` from predicate (informational only — log it but don't enforce)
- Update `.ai-sdlc/schemas/attestation.v1.schema.json` to add OPTIONAL `pipelineVersion` field (so existing v1 envelopes without it still validate). Document that v2 envelopes will REQUIRE it.
- Update CLAUDE.md `Review attestations` section to document the field
- Bump plugin version per `fix:` commit type

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Sign-attestation script reads `pipeline-cli` version and includes in predicate
2. `buildPredicate` helper updated similarly
3. Verifier logs `pipelineVersion` from incoming envelopes (info-level, not enforced)
4. Schema updated with optional `pipelineVersion` field; backward compatible
5. CLAUDE.md updated documenting the new field
6. New envelopes signed in this session contain the field; old envelopes still verify
7. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Sign-attestation script reads `pipeline-cli` version from its package.json and includes as `pipelineVersion` in predicate
- [x] #2 `buildPredicate` helper in orchestrator updated similarly
- [x] #3 Verifier logs `pipelineVersion` from envelopes at info level (not enforced)
- [ ] #4 `.ai-sdlc/schemas/attestation.v1.schema.json` adds optional `pipelineVersion` field; backward compat preserved
- [x] #5 CLAUDE.md `Review attestations` section documents the new field
- [x] #6 New envelopes contain `pipelineVersion`; old envelopes still verify successfully
- [x] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

RFC-0012 Phase 6: optional `pipelineVersion` semver field in DSSE attestation predicate. Forensic / audit only — verifier logs but does NOT enforce. Mirrors AISDLC-87/-94's `pluginVersion` precedent. Fully backward-compatible with v1 envelopes signed before pipeline-cli existed.

## Changes

- `orchestrator/src/runtime/attestations.ts` — `SEMVER` regex constant, `pipelineVersion` in `BuildPredicateInputs`, validation in `validatePredicateShape`, optional emit in `buildPredicate`
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` + `scripts/ci-sign-attestation.mjs` — read `pipeline-cli/package.json` version, pass to predicate (graceful null fallback)
- `scripts/verify-attestation.mjs` — info log of `pipelineVersion` with `<unsafe value redacted>` defense-in-depth fallback
- `CLAUDE.md` — documented under `What CI accepts (intentional)`
- `+17 vitest cases` in attestations.test.ts; `+3 node:test` cases in verify-attestation.test.mjs

## AC status

- ✓ ACs #1, #2, #3, #5, #6, #7 met
- ✗ AC #4 — `.ai-sdlc/schemas/attestation.v1.schema.json` is in agent blockedPaths. Operator hand-edit needed (see Follow-up). Runtime `validatePredicateShape` IS the in-process gate; schema file is informational mirror.

## Verification

- `pnpm build && pnpm lint && pnpm format:check` — clean
- `pnpm vitest run orchestrator/src/runtime/attestations.test.ts` — 127/127 (was 110, +17)
- `node --test scripts/verify-attestation.test.mjs` — 64/64 (was 61, +3)
- `pnpm test` (full workspace) — 4954+ tests pass, no regressions
- 3 reviews approved (code 0c/0M/3m/2s; test 0c/0M/1m/1s; security 0c/0M/0m/0s); ⚠ INDEPENDENCE NOT ENFORCED

## Follow-up (operator + minor polish, all non-blocking)

- **Schema hand-edit (AC #4)**: operator applies under `$defs.predicate.properties` (NOT in `required`):
  ```json
  "pipelineVersion": {
    "type": "string",
    "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9.]+)?$",
    "description": "OPTIONAL. @ai-sdlc/pipeline-cli version (RFC-0012 Phase 6 / AISDLC-100.6). Forensic only."
  }
  ```
- Code minor (verify-attestation.mjs:826): log emission ordering + defensive regex tightening
- Code minor (verify-attestation.mjs:835): point at existing `safeForReason()` helper
- Code minor (attestations.ts:242): JSDoc the leading-zero / +build deviations from strict semver
- Test minor (sign-attestation.test.mjs): add fixture with real `pipeline-cli/package.json` to exercise the present-version branch
- Code suggestion: hoist `?? undefined` shape into shared helper if a 3rd caller appears
<!-- SECTION:FINAL_SUMMARY:END -->
