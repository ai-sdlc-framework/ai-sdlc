---
id: AISDLC-448
title: v6 envelope subject/filename binding survives rebase + chore-commits
status: To Do
assignee: []
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

## Acceptance criteria

- [ ] AC-1: AISDLC-419 attestation-only-descendant relaxation extends to BOTH-mismatch case (filename + subject)
- [ ] AC-2: OR signer rewrites envelope subject + filename to current HEAD on each pre-push (not at original sign time)
- [ ] AC-3: OR adopt patch-id as primary subject (decouple from commit SHA entirely)
- [ ] AC-4: Hermetic test fixture: rebase + chore-commit shape that current verifier rejects
- [ ] AC-5: Hermetic test fixture: orphan-ancestor envelope (the actual incident pattern)
- [ ] AC-6: Document the chosen approach in scripts/verify-attestation.mjs head-block + CLAUDE.md
- [ ] AC-7: Re-sign script writes both filenames (patch-id + per-SHA) atomically

## References

- spec/rfcs/RFC-0042-proof-of-execution-attestation.md
- scripts/verify-attestation.mjs:816-855 (filename+subject mismatch logic)
- pipeline-cli/src/attestation/sign-v6.ts (envelope construction)
- ai-sdlc-plugin/scripts/sign-attestation.mjs (signer entry-point)
- AISDLC-419 (initial descendant relaxation)
- AISDLC-398 (content-addressed patch-id filenames)
<!-- SECTION:DESCRIPTION:END -->
