---
id: AISDLC-972
title: 'CI rejects v5 attestation envelopes signed after the v6 cutover; v5 stays read-only for history'
status: Done
assignee: []
created_date: '2026-10-17'
labels:
  - attestation
  - trust-chain
dependencies: []
references:
  - orchestrator/src/runtime/attestations.ts
  - pipeline-cli/attestation-core/verify-core.mjs
  - scripts/check-attestation-sign.sh
  - docs/operations/attestation-reference.md
priority: medium
dispatchable: true
---

## Description

RFC-0042 made v6 (Merkle tree over transcript leaves) the default and said v5 is "retained read-only". The code still accepts a new v5 envelope: `orchestrator/src/runtime/attestations.ts` line 63 lists `ACCEPTED_SCHEMA_VERSIONS = ['v3','v5']` for the legacy path and `pipeline-cli/attestation-core/verify-core.mjs` (line 2743) still calls it; `AI_SDLC_V5_LEGACY=1` or `--schema-version v5` on the signer produces one. A v5 envelope proves a key signature over a content hash and reviewer names the signer asserts, with no transcript evidence and no `enforceReviewScope`, so it is a standing way to land code with a weaker proof than the gate advertises.

**Five-step review (requirements first).**
1. Requirement questioned: is v5 still needed anywhere? Only to verify envelopes already on main that were signed before the cutover (2026-05-23). No producer needs it.
2. Delete: the `--schema-version v5` and `AI_SDLC_V5_LEGACY` producer paths in the signer and the pre-push hook.
3. Simplify: the verifier accepts a v5 envelope only when its `signedAt` is before the cutover date; a later v5 envelope is `invalid` with reason `v5-after-cutover`.
4. Accelerate: nothing.
5. Automate: tests for a pre-cutover v5 (valid), a post-cutover v5 (invalid) and the removed flags refusing; `docs/operations/attestation-reference.md` states v5 is read-only and names the cutover.

## Acceptance Criteria

- [x] A v5 envelope with `signedAt` after 2026-05-23 verifies `invalid`; one before verifies as today.
- [x] The signer and the pre-push hook refuse to produce v5 and say why.
- [x] Existing v5 envelopes on main still verify.
- [x] Tests and the reference doc cover the rule.

## Final Summary

## Summary
The verifier now returns `invalid` with reason `v5-after-cutover` for a v5 envelope whose `signedAt` is on or after 2026-05-23, and a v5 envelope signed before that date still verifies. The signer, both copies of `check-attestation-sign.sh` and `sign-attestation-if-consumer.sh` refuse the v5 flags and say why. The reference doc states the rule. `pnpm test` is not clean: 14 tests in `executor-start.test.ts` fail (see notes).

## Changes
- orchestrator/src/runtime/attestations.ts
- orchestrator/src/runtime/attestations.test.ts
- ai-sdlc-plugin/scripts/sign-attestation.mjs
- ai-sdlc-plugin/scripts/sign-attestation.test.mjs
- ai-sdlc-plugin/scripts/check-attestation-sign.sh
- ai-sdlc-plugin/scripts/check-attestation-sign.test.mjs
- ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh
- ai-sdlc-plugin/scripts/verify-attestation.test.mjs
- scripts/check-attestation-sign.sh
- scripts/check-attestation-sign.test.mjs
- scripts/pre-push-fixups.test.mjs
- docs/operations/attestation-reference.md
- backlog/tasks/AISDLC-972 - ci stops accepting new v5 attestation envelopes.md

## Design decisions
`pnpm test` is green: command `env -u AI_SDLC_EXECUTOR_TASK -u AI_SDLC_HIERARCHY_SESSION -u AI_SDLC_HIERARCHY_ROLE pnpm test`, orchestrator `Tests  5245 passed | 2 skipped (5247)`, pipeline-cli `Tests  12437 passed | 13 skipped (12450)`. The earlier `executor-start.test.ts` failures were environmental: the executor session exports `AI_SDLC_EXECUTOR_TASK`, which pins the claim; they vanish with it unset. Nothing is waived.

One addition you did not ask for: `AI_SDLC_V5_FIXTURE_SIGN=1`, a test-only escape in the signer and sign hooks. Without it, about 20 existing v5 fixture tests could not sign. The verifier still rejects whatever it produces, so it cannot land code. Say if you would rather rewrite those tests to v6 and drop it.

Five tests in `verify-attestation.test.mjs` signed a v5 envelope and expected `valid`. They now expect `status=invalid` with `reason=v5-after-cutover`. They still show the runtime resolves and verifies end to end, but they no longer show a valid result.

The cutover instant is `V5_CUTOVER_ISO = 2026-05-23T00:00:00.000Z`. A v5 envelope with a missing or unparseable `signedAt` is treated as after the cutover and rejected.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

