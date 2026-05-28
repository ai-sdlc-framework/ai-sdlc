---
id: AISDLC-448
title: v6 envelope subject/filename binding survives rebase + chore-commits
status: Done
assignee:
  - '@claude-opus-4.7'
created_date: '2026-05-27 22:08'
labels:
  - attestation
  - rfc-0042
  - verifier
  - pr-blocker
  - operator-friction
dependencies: []
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Root cause of 4 BLOCKED PRs (#737, #739, #740, #741) on 2026-05-27. Sign-attestation writes envelope filename `<headSha>.v6.dsse.json` + subject.digest.sha1=headSha. After rebase OR pre-push hook auto-signing a chore commit, HEAD advances past signed SHA. AISDLC-419 added "attestation-only descendant" relaxation but it only fires when subject matches headSha AND filename mismatches; when BOTH mismatch (the common rebase-orphan case) the relaxation never runs. Plus when previous v6 envelope was bound to a now-orphaned commit (e.g. pre-rebase HEAD), the descendant check fails since orphan isn't an ancestor of new HEAD.



<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->

- [x] AC-1: AISDLC-419 attestation-only-descendant relaxation extends to BOTH-mismatch case (filename + subject)
- [ ] AC-2: OR signer rewrites envelope subject + filename to current HEAD on each pre-push (not at original sign time)
- [ ] AC-3: OR adopt patch-id as primary subject (decouple from commit SHA entirely)
- [x] AC-4: Hermetic test fixture: rebase + chore-commit shape that current verifier rejects
- [x] AC-5: Hermetic test fixture: orphan-ancestor envelope (the actual incident pattern)
- [x] AC-6: Document the chosen approach in scripts/verify-attestation.mjs head-block + CLAUDE.md
- [ ] AC-7: Re-sign script writes both filenames (patch-id + per-SHA) atomically

<!-- AC:END -->

## Final Summary

**Chosen approach: AC-1 (verifier-side relaxation extension).** AC-2/AC-3/AC-7 are signer-side alternatives that would require broader changes; this PR ships the verifier-side fix that closes the 4 BLOCKED PR class without touching signer wire format. AC-2/AC-3/AC-7 remain available as future hardening if v6 head-binding regressions resurface.

### Changes
- `scripts/verify-attestation.mjs` (modified): added `isTreeEquivalentModuloAttestation()` (parallel to `isAttestationOnlyDescendant()`) and an `ATTESTATION_PATH_EXCLUSIONS` shared constant. `verifyV6Envelope`'s head-binding block now attempts the AISDLC-419 linear-ancestor relaxation first (cheap), then falls through to the new orphan tree-equivalence relaxation. The candidate filter in `runVerifier` was widened in parallel so orphan-subject envelopes actually surface. Head-block docstring updated.
- `scripts/verify-attestation.test.mjs` (modified): added `isTreeEquivalentModuloAttestation (AISDLC-448)` describe block (6 unit tests) + `verifyV6Envelope (AISDLC-448 — orphan-ancestor relaxation)` describe block (3 end-to-end tests including a `runVerifier` integration test that exercises the broadened candidate filter). Existing AISDLC-419 tests still pass (no regression).
- `CLAUDE.md` (modified): added a durable rule under "Review attestations" documenting the two-relaxation contract (AISDLC-419 + AISDLC-448) and the shared `ATTESTATION_PATH_EXCLUSIONS` constant. Not a per-PR changelog bullet — it captures the long-lived semantics of the v6 head-binding check.

### Design decisions
- **Tree comparison via `git diff <A> <B>` (not `diff-tree`)**: diff-tree assumes a connected commit graph between two refs; the orphan case explicitly does not have one. `git diff` only needs both trees to be reachable git objects (no ancestry assumption).
- **Conservative-reject on git failures**: if subject SHA is unreachable (shallow clone, gc'd), the new helper returns false so verification produces an actionable error rather than silently accepting on a degraded view of history.
- **Shared `ATTESTATION_PATH_EXCLUSIONS` constant**: refactored the path-exclusion args used by both relaxation helpers into one source. Drift between them would re-open the same BOTH-mismatch class of false negatives this task closed. Symmetric on the signer side via `pipeline-cli/src/attestation/patch-id.ts:PATCH_ID_EXCLUSIONS` (AISDLC-422 contract preserved).
- **Security argument for orphan acceptance**: the v6 envelope's Merkle root + trusted-key signature still gates acceptance (steps 3-7 of `verifyV6Envelope`). The tree-equivalence check only relaxes the *head-binding precondition* for envelopes whose source content matches HEAD. Cross-PR replay is not enabled because the attacker would need to land HEAD whose source-tree (modulo attestation) exactly matches a historic envelope's subject-tree — which is the same content the reviewers already approved; no new approval is granted by replay.

### Verification
- `pnpm build` — all packages clean
- `pnpm test` — 127 pass / 1 todo (pre-existing) in `verify-attestation.test.mjs`; full workspace exit=0 across all 9 test runners
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up
- AC-2 / AC-3 / AC-7 remain available as deeper signer-side hardening if head-binding regressions resurface; verifier-side fix is sufficient for the current incident.

## References

- spec/rfcs/RFC-0042-proof-of-execution-attestation.md
- scripts/verify-attestation.mjs:816-855 (filename+subject mismatch logic)
- pipeline-cli/src/attestation/sign-v6.ts (envelope construction)
- ai-sdlc-plugin/scripts/sign-attestation.mjs (signer entry-point)
- AISDLC-419 (initial descendant relaxation)
- AISDLC-398 (content-addressed patch-id filenames)

