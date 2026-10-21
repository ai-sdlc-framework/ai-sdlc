---
id: AISDLC-998
title: 'Step 10.6 signs with the post-rebase patch-id, or sends a changed diff back to review'
status: In Progress
assignee: []
created_date: '2026-10-20'
labels:
  - attestation
  - pipeline
  - bug
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/governance/rebase-rearm.ts
  - ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
---

## Description

In `/ai-sdlc execute`, transcript leaves are emitted at review time with no `--patch-id` (`pipeline-cli/src/next-step/review-finalize.ts:299-325`), so the leaf key is the pre-rebase content patch-id. Step 10.5 then rebases the branch (`pipeline-cli/src/next-step/ship.ts:144`). The consumer signer computes a fresh `PATCH_ID` against `BASE_REF` (`ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh:291-297`) but never passes it to the signer (`:400-406`); `sign-attestation.mjs:552` recomputes against a hard-coded `origin/main` merge point, while the verifier uses the PR base sha (`attestation-core/verify-core.mjs:2583-2595`). When the rebase changes the content patch-id, the envelope and leaves carry the old key and the verifier reports "no envelope matching HEAD <sha> content patch-id <fresh>; only v6 envelopes found". A consumer repo (ai-sdlc-io) hit it on three tasks on 2026-10-20 (IO-10 three times, IO-12, IO-18) and had to pass the fresh `--patch-id` to `emit-leaf` and `sign-v6` by hand each time. AISDLC-984 made ship and resume fail closed on a missing head envelope; it detects the mismatch but does not prevent it.

Fix: in `ship.ts` after the 10.5 rebase (near `:185`), compare the content patch-id before and after with the helper in `governance/rebase-rearm.ts:29`. If it is unchanged, sign. If it changed, the reviewed diff is no longer the diff being signed: the run goes back to the review step (the same path a changed diff takes under AISDLC-989's rule) instead of signing with orphaned leaves. The consumer signer passes `--patch-id "$PATCH_ID"` (`sign-attestation-if-consumer.sh:400-405`) and `sign-attestation.mjs:552` takes the base from the PR base ref instead of a hard-coded `origin/main`, so signer and verifier compute the same key.

Out of scope: the leaf format, the verifier, and the pre-push hooks.

**Five-step review (requirements first).**
1. Requirement questioned: may a signer ever reuse a key computed before its own rebase? No: the key names the diff that was reviewed, so a changed key means a different diff.
2. Delete: the hard-coded `origin/main` base in the signer.
3. Simplify: one patch-id computed once after the rebase and handed to every signing call.
4. Accelerate: a changed diff is caught at 10.5 inside the run, not at the verifier or in CI.
5. Automate: the before/after comparison runs on every ship; no operator ever passes `--patch-id` by hand.

## Acceptance Criteria

- [ ] After the 10.5 rebase, `ship.ts` compares the content patch-id before and after; unchanged signs, changed returns the run to review with a note naming both ids.
- [ ] `sign-attestation-if-consumer.sh` passes the computed `PATCH_ID` to the signer; `sign-attestation.mjs` no longer hard-codes `origin/main` as the base.
- [ ] A unit test covers both branches of the comparison, and a test asserts the consumer script passes `--patch-id`.
- [ ] `docs/operations/attestation-reference.md` states that the signed key is always the post-rebase content patch-id.
