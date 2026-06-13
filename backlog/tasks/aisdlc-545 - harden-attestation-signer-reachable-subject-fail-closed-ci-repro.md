---
id: AISDLC-545
title: >-
  fix(attestation): guarantee a CI-reachable subject + fail-closed local
  CI-repro before push (stop orphan-subject attestation gate failures)
status: To Do
assignee: []
labels:
  - bug
  - ci
  - security
  - attestation
  - ci:no-issue-required
priority: high
dependencies: []
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - scripts/check-attestation-sign.sh
  - scripts/verify-attestation.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Tactical guard half** of preventing the orphan-subject v6-attestation failure class (the
architectural half — relaxing the `subject.sha1` head-binding when patch-id+Merkle+signature
already verify — is routed separately as Decision Catalog DEC-0011, scope `attestation`).

**Incident (2026-06-12):** PR #912 (AISDLC-538) failed the CI `ai-sdlc/attestation` gate with
`v6: envelope filename '<patchid>.v6.dsse.json' does not match expected '<headSha>.v6.dsse.json'`.
Root cause: the envelope's `subject.sha1` pointed at an **orphaned pre-rebase commit** (the PR
was signed when HEAD=X, then rebased, orphaning X, with no re-sign). The verifier's AISDLC-448
tree-equivalence relaxation accepts an orphaned subject **only when the orphan's tree is
available** — true in the local object store but NOT in CI's shallow clone. Net: **local
`verify-attestation` reports status=valid while CI fails** — the asymmetry lets a stale-subject
PR ship and stall at the gate. Fix was a manual re-sign at a reachable HEAD.

This class will recur for any signer path that signs-then-rebases (cron reconcile, parallel
sessions, ad-hoc signs). Codify the existing operator-memory rule
(`feedback_attestation_stale_subject_sha_on_rebase`: "sign against a remote-reachable
ancestor, reproduce the CI gate locally before push") into the tooling so it can't be skipped.

**Fix direction (implementer confirms against the code):**
1. **Signer always binds a current, reachable subject.** Ensure `sign-attestation.mjs` sets
   `subject.sha1` to the current `HEAD` (the commit being pushed), never an older commit that
   could be orphaned. If it already does, add an explicit assertion/log so it's guaranteed.
2. **Pre-push fail-closed CI-repro.** In `scripts/check-attestation-sign.sh` (the pre-push
   auto-sign hook), after signing/finding the envelope, run the SAME verification CI runs —
   `verify-attestation.mjs` with `PR_BASE_SHA=origin/main` and `PR_HEAD_SHA=HEAD` — AND assert
   the envelope's `subject.sha1` is **reachable from the branch tip being pushed** (e.g.
   `git merge-base --is-ancestor <subject> HEAD`, or `git cat-file -e <subject>` reachable via
   a ref). If the subject is an orphan / the CI-repro would fail, RE-SIGN at HEAD automatically
   (preferred) or BLOCK the push with an actionable "re-sign required" message. The point:
   never let a PR push whose attestation passes locally but would fail CI.
3. **Optional CI-side diagnostic.** Improve the `verify-attestation.mjs` failure message for the
   unreachable-subject case to say "subject SHA unreachable in this clone — re-sign at HEAD"
   so future occurrences are diagnosed in seconds.

**Compose with DEC-0011:** if the operator approves the `relax` option in DEC-0011 (drop
subject.sha1 reachability when patch-id+Merkle+sig verify), this guard becomes belt-and-
suspenders rather than load-bearing — still worth having, but the architectural change removes
the root fragility. Implement this guard regardless; it ships faster and protects every signer
path during the DEC-0011 decision window.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `sign-attestation.mjs` binds `subject.sha1` to the current HEAD (the commit being pushed); an assertion/log makes this explicit and a test pins it.
- [ ] #2 `check-attestation-sign.sh` runs a local CI-repro (`verify-attestation.mjs` with `PR_BASE_SHA=origin/main`, `PR_HEAD_SHA=HEAD`) before allowing the push, and asserts the envelope's `subject.sha1` is reachable from the branch tip.
- [ ] #3 When the subject is an orphan / the CI-repro would fail, the hook auto-re-signs at HEAD (preferred) or blocks the push with an actionable "re-sign required" message — never a local-pass/CI-fail push.
- [ ] #4 `verify-attestation.mjs` emits a clear "subject SHA unreachable in this clone — re-sign at HEAD" diagnostic for the unreachable-subject case.
- [ ] #5 Hermetic test reproduces the orphan-subject scenario (sign at commit X, rebase to orphan X, attempt push) and proves the guard catches it (auto-re-sign or block), not a local-pass/CI-fail.
- [ ] #6 `pnpm test` + the attestation-sign-gate hermetic tests + lint pass; no regression to the normal (non-rebased) sign+push path.
<!-- AC:END -->
