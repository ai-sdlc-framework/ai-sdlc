---
id: AISDLC-610
title: Attestation patch-id must be identical across emit-leaf/sign-v6/verifier (exclude backlog/**)
status: To Do
priority: high
labels:
  - adopter-facing
  - attestation
  - security
references:
  - AISDLC-421
  - AISDLC-606
  - AISDLC-607
created: 2026-09-14
---

## Context

Surfaced by an external adopter (local-trades) dogfooding `/ai-sdlc execute`.
Two coupled attestation-trust defects (HIGH-2 + MED-5 of the adopter's report):

**HIGH-2:** `sign-v6` cannot find the transcript leaves `emit-leaf` just wrote —
its per-patch-id lookup computes a DIFFERENT patch-id key than `emit-leaf` did,
so it reports "No transcript leaves found for taskId …" even though
`.ai-sdlc/transcript-leaves/<patch-id>.jsonl` exists under emit-leaf's key. The
adopter's workaround was to copy the leaves into the shared
`.ai-sdlc/transcript-leaves.jsonl` fallback so sign-v6's fallback path reads them.

**MED-5 (the likely root cause of HIGH-2):** `computePatchId`
(`pipeline-cli/src/attestation/patch-id.ts`) excludes `.ai-sdlc/attestations/`
and `.ai-sdlc/transcript-leaves/` but NOT `backlog/{tasks,completed}/`. The
task-Done file move (`tasks/ → completed/`) therefore SHIFTS the content
patch-id. When `emit-leaf` runs before the backlog move and `sign-v6` after (or
vice-versa), the two compute different patch-ids → sign-v6 looks under the wrong
key → leaves "not found". This also breaks the hook flow: signing before
committing the move binds a stale key and CI verify finds no envelope.

## ⚠️ Security / lockstep constraint (READ BEFORE IMPLEMENTING)

The patch-id is the attestation lookup + binding key. It is computed in FOUR
places that MUST agree byte-for-byte, or EVERY attestation in EVERY repo breaks
(the AISDLC-421 class of bug):

1. Signer patch-id: `pipeline-cli/src/attestation/patch-id.ts` (`PATCH_ID_EXCLUSIONS`)
2. Verifier: `scripts/verify-attestation.mjs` (`ATTESTATION_PATH_EXCLUSIONS`)
3. `emit-leaf` (cli-attestation) patch-id computation
4. `sign-v6` per-patch-id leaf lookup

Per CLAUDE.md: "Adding paths to either relaxation requires extending
`ATTESTATION_PATH_EXCLUSIONS` in lockstep on the signer side
(`patch-id.ts:PATCH_ID_EXCLUSIONS`) — asymmetric exclusion lists reproduce the
AISDLC-421 hotfix class of bug." Any exclusion change here MUST be applied to all
four in the SAME PR, with a test that proves they agree.

## Scope

- Add `backlog/tasks/` and `backlog/completed/` to the patch-id exclusion set, in
  LOCKSTEP across all four consumers above (signer, verifier, emit-leaf, sign-v6).
  Rationale: backlog task-file location is lifecycle bookkeeping, not reviewed
  source — the Done-move must not change the attested content identity. (This
  mirrors why `.ai-sdlc/attestations` + `transcript-leaves` are already excluded.)
- Ensure `emit-leaf` and `sign-v6` compute the patch-id via the SAME
  `computePatchId` (same base ref + same exclusions). Additionally, let `sign-v6`
  accept an explicit `--patch-id` (belt-and-suspenders) so a caller that already
  computed it can pass it through and avoid any recomputation drift.
- Do NOT change the base ref in this task (that is the separate AISDLC-606
  branch-agnostic-base follow-up). Keep `origin/main` as-is; only the EXCLUSION
  set + emit/sign agreement are in scope here.
- MED-5 documentation: if there remains any manual (non-hook) signing flow whose
  commit ordering is load-bearing, document the correct order (commit backlog
  move → emit/sign → commit excluded artifacts) in the attestation docs — but the
  code fix (excluding backlog/**) should make ordering NON-load-bearing, which is
  the preferred outcome.

## Acceptance Criteria

- [ ] AC-1: `computePatchId` excludes `backlog/{tasks,completed}/` on the signer,
      and the SAME exclusion is applied on the verifier, `emit-leaf`, and
      `sign-v6` — verified by a test that computes the patch-id before and after a
      simulated `tasks/ → completed/` move and asserts it is UNCHANGED.
- [ ] AC-2: A test reproduces the HIGH-2 flow end-to-end: `emit-leaf` writes
      leaves, a backlog Done-move happens, `sign-v6` runs and FINDS the leaves via
      the per-patch-id file (no shared-fallback needed) and writes a valid
      envelope that `verify-attestation` accepts.
- [ ] AC-3: `sign-v6` accepts an explicit `--patch-id` and uses it verbatim when
      provided; when omitted it computes the identical key `emit-leaf` uses.
- [ ] AC-4: Signer/verifier/emit-leaf/sign-v6 exclusion lists are proven
      identical by a test (guard against future asymmetric drift — AISDLC-421).
- [ ] AC-5: No base-ref change; existing `aisdlc-`/this-repo attestations still
      verify (regression-safe). `pnpm build && test && lint` clean; coverage >=80%.

## References

Adopter report local-trades LT-595 (HIGH-2 + MED-5). Lockstep contract:
CLAUDE.md "Review attestations". Related: AISDLC-421 (asymmetric-exclusion bug
class), AISDLC-606 (deferred branch-agnostic base — NOT this task).
