---
id: AISDLC-694
title: >-
  Pre-push attestation step runs the same verifier CI runs and re-signs when it fails
status: In Progress
assignee:
  - dispatch-executor-delta
created_date: '2026-10-03'
labels:
  - attestation
  - hooks
  - security
dependencies: []
references:
  - scripts/check-attestation-sign.sh
  - scripts/check-attestation-sign.test.mjs
  - scripts/verify-attestation.mjs
  - scripts/pre-push-fixups.sh
  - CLAUDE.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`scripts/check-attestation-sign.sh` treats an existing envelope for the current
patch id as proof that nothing needs signing. After a history rewrite (a reword, a
filter, a rebase that re-creates the signing chore commit) the envelope can name a
subject commit that is no longer in the pushed history. The hook then pushes it, and
`verify-attestation` fails in CI. On 2026-10-03 this cost a failed CI run and a manual
re-sign on #1161; the executor had to call the signer directly.

Operator decision, 2026-10-03 (decision rubric): **the pre-push step runs the same
verifier CI runs and re-signs on failure**, chosen over adding a single ancestor check
to the hook (a fourth hand-kept copy of verifier rules; the hook drifted from the
verifier once already, AISDLC-618) and over documenting a manual recipe.

## Conventions
- Bash for the hook, `node --test` hermetic tests in temporary repositories, as the
  existing `scripts/check-attestation-sign.test.mjs` does.
- Trust-sensitive: security review on the strongest reviewer model. The change must not
  let the hook sign when no reviewer verdict file exists, and must not delete an
  envelope it did not just replace.
- No new skip variable. The existing `AI_SDLC_SKIP_ATTESTATION_SIGN` and
  `AI_SDLC_BYPASS_ALL_GATES` keep their meaning.

## Scope
1. When an envelope for the current patch id exists, the hook runs
   `scripts/verify-attestation.mjs` against the local HEAD and merge base, in the same
   mode CI uses, before treating the push as already signed.
2. `status=valid`: unchanged behaviour, no fixup, push proceeds.
3. Not valid, and the sentinel and verdict file are present: re-sign through the
   existing signer path, replace the envelope in a chore commit, and exit through the
   existing "re-run git push" fixup flow. The message names the verifier's reason.
4. Not valid, and no verdict file: fail the push with the verifier's reason and the
   instruction to re-run the review; do not sign.
5. When the built verifier inputs are missing in a fresh worktree, fail with the build
   instruction when an envelope exists, as the DoR gate does for task files; do not
   skip silently.
6. Update the hook description in `CLAUDE.md` (Hooks, item 8).

## Acceptance Criteria
- [ ] Fixture: an envelope whose subject commit is not in the pushed history and whose tree differs is detected, re-signed when the verdict file exists, and the second push is a no-op.
- [ ] Fixture: the same envelope with no verdict file fails the push with the verifier's reason and creates no commit.
- [ ] Fixture: a valid envelope (attestation-only descendant, and tree-equivalent after a clean rebase) passes with no fixup.
- [ ] The hook invokes the verifier script and contains no reimplementation of its acceptance rules (asserted by the test reading the hook text for the script path).
- [ ] With verifier inputs unbuilt and an envelope present, the push fails with the build instruction.
- [ ] `pnpm test:attestation-sign-gate` and `pnpm test:pre-push-fixups-gate` pass.
<!-- SECTION:DESCRIPTION:END -->
