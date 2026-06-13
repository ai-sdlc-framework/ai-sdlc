---
id: AISDLC-516
title: 'docs(rfc-0043): align signing-key secret name to AISDLC_SIGNING_KEY_CONTENT across remaining docs'
status: To Do
assignee: []
created_date: '2026-06-04'
labels:
  - rfc-0043
  - docs
  - follow-up
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-514 made the UCVG signing key materialize from the `AISDLC_SIGNING_KEY_CONTENT`
secret (PEM content) inside the clean-room job — the canonical name going forward. Three
pre-existing docs still describe the secret as `AISDLC_SIGNING_KEY_PATH` (a path-valued
secret, which is meaningless on an ephemeral runner). This is cosmetic, not a security
issue (an env-var name is not a credential), but it can lead an operator to create a
useless path-valued secret. Surfaced by the security reviewer during the AISDLC-514
reconcile.

Files to align (verified present on main at filing time):
- `docs/operations/untrusted-contributor-pr-verification.md` (~line 442)
- `docs/concepts/untrusted-contributor-verification.md` (~line 180)
- `docs/api-reference/rfc-0043-ucvg.md` (~line 646)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The three docs describe the secret as `AISDLC_SIGNING_KEY_CONTENT` (PEM content), noting the workflow materializes it into the `AISDLC_SIGNING_KEY_PATH` env at run time in the clean-room job.
- [ ] #2 No doc instructs storing a filesystem path as the secret, and none teaches `echo "${{ secrets.* }}"` for the key (the secure env+printf+chmod 600 pattern from AISDLC-514 is the reference).
- [ ] #3 `pnpm format:check` clean; the canonical wiring in `docs/ucvg-test-repo-setup/signing-key-setup.md` (already correct) and the three updated docs agree.
<!-- AC:END -->

## Notes

Doc-only change; lands via the docs-only PR path (paths-ignored from review/attestation). Discovered during the RFC-0043 Phase 7 drain (AISDLC-514 security re-review).
