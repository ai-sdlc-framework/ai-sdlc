---
id: AISDLC-504
title: 'test: make ucvg conformance AC-3 + resource-breach checks end-to-end (AISDLC-502 reviewer minors)'
status: Done
assignee: []
created_date: '2026-06-03'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - test-quality
  - conformance
  - follow-up
dependencies:
  - AISDLC-502
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two non-blocking minors raised by the test-reviewer during the AISDLC-502 (RFC-0043 Phase 6) reconcile review (PR #848). Filed for follow-up at operator request. Both behaviors are already covered in the dedicated module tests (`clean-room-signer.test.ts`, `sandbox-runner.test.ts`); these only make the conformance suite self-contained on its own claims.

In `pipeline-cli/src/pipeline/ucvg-conformance.test.ts`:
1. The AC-3 "clean-room signer mints valid attestation only after Zod boundary validates" / signer-refusal check asserts on hand-constructed fixture data (`consensus.approved === false` on data the test itself built) rather than invoking the real `runCleanRoomSigner()`. It is effectively a data-shape assertion, not an end-to-end signer invocation.
2. Scenario (c) "resource breach event shape for wall-clock exhaustion" constructs a plain object literal and asserts its own constants, rather than calling the exported `buildResourceBreachEvent()` factory from `sandbox-runner.ts`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE_CRITERIA:BEGIN -->
- [ ] The AC-3 conformance check invokes `runCleanRoomSigner()` against an isolated `mkdtemp` work dir (no signing key present) and asserts the real refusal outcome (e.g. `result.phase === 'consensus-rejected'` / failure), exercising production code rather than a hand-built struct.
- [ ] The resource-breach scenario constructs its event via the exported `buildResourceBreachEvent()` (or equivalent factory) from `sandbox-runner.ts` and asserts the real `type`/`limit`/`limitUnit`/`observedValue` fields, including the `not.toMatch(/AISDLC-\d+/)` adopter-facing-string check.
- [ ] All `ucvg-conformance.test.ts` tests pass; no shared `/tmp/.ai-sdlc/` created (isolated mkdtemp invariant preserved).
- [ ] Test-only; no production code change.
<!-- SECTION:ACCEPTANCE_CRITERIA:END -->

## Notes

Source: test-reviewer findings on PR #848, `pipeline-cli/src/pipeline/ucvg-conformance.test.ts` (~line 358 signer check; ~line 765 resource-breach scenario). See also [[feedback_shared_tmp_marker_dir_pollution]] for the isolated-tmpdir requirement.
