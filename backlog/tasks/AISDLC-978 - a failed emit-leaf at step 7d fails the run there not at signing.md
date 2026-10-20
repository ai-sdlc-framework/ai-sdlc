---
id: AISDLC-978
title: 'A failed emit-leaf at step 7d fails the run there, not at signing'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - attestation
dependencies: []
references:
  - pipeline-cli/src/next-step/review-finalize.ts
  - pipeline-cli/src/next-step/ship.ts
priority: medium
dispatchable: true
---

## Description

In `pipeline-cli/src/next-step/review-finalize.ts` the per-reviewer leaf emission is best-effort. At `:290-296` a missing transcript or verdict file after persistence only pushes a warning ("transcript or verdict missing for ... leaf not emitted (the v6 sign step will block)") and continues; at `:326-330` a non-zero exit of `cli-attestation.mjs emit-leaf` pushes a warning ("emit-leaf for ... exited non-zero ... the v6-default sign step will block") and continues. The function then returns `ok: true`. The run proceeds through iterate and the chore commit and only fails at `pipeline-cli/src/next-step/ship.ts:361-367` (Step 10.6, `sign-attestation-if-consumer.sh`) or in the pre-push signing hook, with a message about a missing leaf that no longer says which reviewer or why.

Fix: at step 7c/7d a missing transcript, a missing verdict or a non-zero emit-leaf is a failure of the round: `finalizeReview` returns `ok: false` with the emit-leaf stderr and the reviewer name, and the session stops there with that reason. The v5 legacy escape (`AI_SDLC_V5_LEGACY=1`) keeps the warning behaviour, since v5 needs no leaves. A test covers both: v6 default fails closed with the leaf error, v5 legacy warns and continues.

**Five-step review (requirements first).**
1. Requirement questioned: is a late failure acceptable because the sign step catches it? No; it costs the iterate and chore steps and loses the cause.
2. Delete: the two "the v6 sign step will block" warnings become one failure path.
3. Simplify: fail at the step that has the information.
4. Accelerate: the operator sees the real cause minutes earlier and no work is spent after it.
5. Automate: the test on `finalizeReview` with a failing runner for emit-leaf.

## Acceptance Criteria

- [ ] `finalizeReview` returns `ok: false` with the reviewer name and emit-leaf stderr when a transcript or verdict is missing or emit-leaf exits non-zero (v6 default).
- [ ] With `AI_SDLC_V5_LEGACY=1` the prior warning behaviour is unchanged.
- [ ] A test covers both branches.
- [ ] The sign step in `ship.ts` is unchanged in behaviour (it still blocks on a missing leaf, as a second line).
