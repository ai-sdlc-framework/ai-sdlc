---
id: AISDLC-490
title: >-
  feat(RFC-0042): B+ end-state — eliminate post-sign chore-commit by staging
  attestation into the dev commit
status: To Do
assignee: []
created_date: '2026-05-31 00:00'
labels:
  - attestation
  - rfc-0042
  - ci-friction
dependencies:
  - AISDLC-475
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**B+ end-state from the AISDLC-475 walkthrough (DEC-0008).**

AISDLC-475 (Fix B) eliminated the re-sign loop by making the pre-push hook key
off the content-addressed patch-id file for idempotency, and by stopping the
dual-write of the per-SHA bridge. However, the root mechanism — a post-sign
chore commit that advances HEAD past the signed SHA — remains in place.

This task implements the B+ end-state: make the re-sign loop **structurally
impossible** by not moving HEAD after signing. Instead of committing the
attestation envelope and transcript-leaves as a separate chore commit, stage
them INTO the dev commit (or otherwise avoid the post-sign chore commit). This
removes the chore-commit class entirely from the normal pipeline path.

**Motivation:** The current flow is:
1. Dev commit (source changes)
2. Sign attestation (writes `<patch-id>.v6.dsse.json`)
3. Chore commit (stages the envelope + leaves — moves HEAD)
4. Re-push

With B+, the envelope and leaves are staged into Step 1 (or committed in an
amended-and-force-pushed style before the push), so Step 3 is eliminated.
The `check-attestation-sign.sh` pre-push hook becomes a no-op on every push
because there is never a "signed dev commit without a chore on top" pattern
to detect and paper over.

**Note:** The verifier's per-SHA legacy soak fallback from AISDLC-475 can be
removed once B+ ships (AISDLC-475 AISDLC-490 deletion follow-up, noted in the
code comment added in AISDLC-475).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] AC-1: No `chore: auto-sign attestation` commit is produced by the normal
  pipeline path (`/ai-sdlc execute` + pre-push hook chain). The attestation
  envelope and per-patch-id transcript-leaves file are committed as part of the
  work commit or via a dedicated pre-push amend-and-restage — without creating
  a new separate commit.
- [ ] AC-2: The envelope is committed as part of the work commit (or equivalent
  pre-push restage mechanism) as part of Step 10 of `/ai-sdlc execute` — without
  a follow-on chore commit.
- [ ] AC-3: The re-sign loop is structurally impossible: there is no HEAD
  movement post-sign in the normal pipeline path, demonstrated by an end-to-end
  hermetic test that confirms exactly one commit in the push range after
  sign-attestation.
- [ ] AC-4: The verifier's per-SHA legacy soak fallback (marked with
  `DELETION FOLLOW-UP: remove this per-SHA lookup in AISDLC-490` in
  `scripts/verify-attestation.mjs`) is removed.
- [ ] AC-5: Hermetic tests cover: (a) single-commit push shape after sign; (b)
  no chore-commit subject in any push-range commit; (c) genuine source change
  still invalidates the attestation (replay-protection regression guard from
  AISDLC-475 AC#7c).
<!-- AC:END -->

## References

- AISDLC-475 (Fix B: remove per-SHA bridge, key pre-push hook off patch-id)
- DEC-0008 (decision catalog entry: B+ end-state walkthrough)
- scripts/check-attestation-sign.sh (pre-push hook to simplify/remove)
- scripts/verify-attestation.mjs (AISDLC-490 soak fallback deletion target)
- pipeline-cli/src/attestation/sign-v6.ts
- spec/rfcs/RFC-0042-v6-attestation-merkle-transcript.md
