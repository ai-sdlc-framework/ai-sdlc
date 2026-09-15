---
id: AISDLC-618
title: Fix check-attestation-sign.sh patch-id backlog-exclusion lockstep gap (breaks task-move PRs)
status: To Do
priority: high
labels:
  - attestation
  - hooks
  - bug
references:
  - AISDLC-610
created: 2026-09-14
---

## Context

Discovered while reconciling AISDLC-616. **AISDLC-610 added `backlog/tasks/` and
`backlog/completed/` to the signer's `PATCH_ID_EXCLUSIONS`
(`pipeline-cli/src/attestation/patch-id.ts`) and the verifier's
`ATTESTATION_PATH_EXCLUSIONS` (`pipeline-cli/attestation-core/verify-core.mjs`),
but did NOT update the bash pre-push hook `scripts/check-attestation-sign.sh`**,
whose patch-id computation (line ~178) still hardcodes only:

```
git diff-tree --no-color -p "${MERGE_BASE}..HEAD" -- \
  ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves/' ':!.ai-sdlc/transcript-leaves.jsonl'
```

The hook's own comment (line ~174) even warns: "Asymmetric exclusion makes this
bash hook compute a different patch-id than pipeline-cli." That is now exactly
what happens for **any PR that moves a backlog task file** (i.e. every
`/ai-sdlc execute` PR, since Step 10 / `check-task-moved.sh` moves the file to
`backlog/completed/` before signing):

- Hook (no backlog exclusion) computes patch-id **A** (e.g. `2d8801d8…`).
- Signer + verifier + CI (with backlog exclusion) compute patch-id **B** (e.g. `5ce5d287…`).

The hook then signs (producing envelope **B**), immediately looks for envelope
**A** in its idempotency check, doesn't find it, and **hard-fails the push**
(`ERROR: signer did not produce <A>.v6.dsse.json; aborting push`).

**Reproduced concretely on AISDLC-616** (PR #1066): raw `git patch-id` without
backlog exclusions = `2d8801d8…`; with backlog exclusions = `5ce5d287…`. CI's
`verify-attestation` uses the exclusion set and PASSED against `5ce5d287…`,
confirming **B** is authoritative and the hook is the wrong side. Workaround used
to land #1066: `AI_SDLC_SKIP_ATTESTATION_SIGN=1 git push` after manually signing
+ committing the correct (**B**) envelope.

## Impact

The standard local pipeline is broken at the pre-push attestation-sign step for
all task-move PRs on current `main`. Every dispatch currently needs the
`AI_SDLC_SKIP_ATTESTATION_SIGN=1` workaround (with a manually-signed envelope) to
push. High priority — it removes the auto-sign guarantee for the common path.

## Scope

- Bring `scripts/check-attestation-sign.sh`'s patch-id `git diff-tree`
  exclusion list into lockstep with `PATCH_ID_EXCLUSIONS` — add
  `':!backlog/tasks/'` and `':!backlog/completed/'` (and `':!.ai-sdlc/reviews/'`
  per AISDLC-616, already excluded on the pipeline-cli side).
- Prefer a SINGLE source of truth rather than a second hardcoded copy: expose
  the canonical exclusion pathspecs from pipeline-cli (e.g. a
  `cli-attestation print-patch-id-exclusions` subcommand, or have the hook shell
  out to the compiled patch-id computation directly) so the two lists can never
  drift again. A hardcoded-but-synced list is acceptable ONLY if guarded by a
  test that asserts equality with `PATCH_ID_EXCLUSIONS`.
- Add a hermetic test under `scripts/check-attestation-sign.test.mjs` (or extend
  the existing gate test) that reproduces a task-move PR and asserts the hook
  computes the SAME patch-id as the signer, and that the idempotency check finds
  the just-signed envelope (no false "did not produce" abort).

## Acceptance Criteria

- [ ] AC-1: On a PR whose diff moves a `backlog/tasks/*.md` to
      `backlog/completed/`, the hook's computed patch-id equals the signer's, and
      the auto-sign + idempotency check succeeds without `AI_SDLC_SKIP_*`.
- [ ] AC-2: The hook's exclusion set is either derived from the pipeline-cli
      single source of truth OR guarded by a test asserting equality with
      `PATCH_ID_EXCLUSIONS`; a future addition to one list cannot silently skip
      the other.
- [ ] AC-3: Hermetic test reproduces the task-move-PR case and asserts hook ==
      signer patch-id + successful idempotent no-op on re-push.
- [ ] AC-4: `pnpm build && test && lint` clean; the AISDLC-610 exclusion-lockstep
      story is updated to include the bash hook as a third synchronized surface.

## References

Found during AISDLC-616 reconcile (PR #1066). Root cause: AISDLC-610 exclusion
addition not propagated to `scripts/check-attestation-sign.sh`. Related lockstep
surfaces: `pipeline-cli/src/attestation/patch-id.ts`,
`pipeline-cli/attestation-core/verify-core.mjs`,
`pipeline-cli/src/attestation/patch-id-exclusion-lockstep.test.ts`.
