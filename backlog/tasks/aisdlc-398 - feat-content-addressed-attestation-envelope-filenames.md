---
id: AISDLC-398
title: 'feat(attestation): content-address envelope filenames via git patch-id (decouple from commit SHA)'
status: In Progress
labels: [attestation, ci, merge-queue, v4-kick, root-cause-fix]
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - scripts/verify-attestation.mjs
  - .github/workflows/verify-attestation.yml
  - CLAUDE.md
priority: critical
permittedExternalPaths: []
---

## Description

Attestation envelopes are currently filenamed by HEAD commit SHA (`.ai-sdlc/attestations/<head-sha>.dsse.json`), which couples the envelope's lookup key to git commit history. This caused the v4-kick disaster that consumed 12+ hours on PR #626 (AISDLC-373) and shipped AISDLC-397's CI re-sign bot as a workaround. Operator architectural review (2026-05-23) identified the root cause: the filename binding to commit SHA is **redundant historical metadata pretending to be functional** — git already provides audit history via commit metadata + chore-commit messages; the envelope only needs to be findable by content.

The fix: filename = `git patch-id` of the PR's content diff (excluding `.ai-sdlc/attestations/**`).

## Acceptance criteria

- [ ] AC-1: `sign-attestation.mjs` computes `git patch-id` for `merge-base origin/main HEAD..HEAD` content diff, excluding `.ai-sdlc/attestations/**` from the diff. Writes envelope to `.ai-sdlc/attestations/<patch-id>.{v5,v6}.dsse.json`. Preserves the per-SHA filename as ALSO-written for one release as a legacy compatibility audit (operator can delete legacy filenames later).
- [ ] AC-2: `verify-attestation.mjs` computes patch-id of HEAD diff using the same exclusion list, looks up envelope by patch-id filename. Falls back to per-SHA filename for envelopes signed pre-AISDLC-398. Returns existing verifier outcomes (valid / mismatch / missing) with identical semantics.
- [ ] AC-3: Patch-id computation uses `git diff-tree --no-color -p <base>..<head> -- ':!.ai-sdlc/attestations/' | git patch-id --stable` (stable mode for cross-environment determinism).
- [ ] AC-4: Hermetic tests at `pipeline-cli/src/attestation/patch-id.test.ts`: (a) conflict-free rebase yields same patch-id (the v4-kick scenario), (b) content change yields different patch-id (correctly invalidates), (c) commit reordering yields same patch-id (git patch-id property), (d) squash merge yields same patch-id as the source PR (verifies main-side lookup works), (e) excluded paths (.ai-sdlc/attestations/) don't affect patch-id.
- [ ] AC-5: Workflow update at `.github/workflows/verify-attestation.yml` — verifier uses content-addressed lookup. Same `ai-sdlc/attestation` status posted with same context name.
- [ ] AC-6: CLAUDE.md "Review attestations" section updated: filename convention is now content-addressed; per-SHA legacy lookup retained for one release.
- [ ] AC-7: Pre-push hook `scripts/check-attestation-sign.sh` updated: envelope-existence check uses patch-id-named file.
- [ ] AC-8: Migration: existing per-SHA envelopes in repo continue to work via fallback. New signatures use patch-id. No data migration needed.
- [ ] AC-9: After ship, file follow-up AISDLC-398.1 to close PR #631 (AISDLC-397 re-sign bot — now unnecessary) and re-trigger merge on stuck PRs #626 / #524 once the verifier supports content-addressed lookup.

## Why now

Operator architectural review 2026-05-23 — root cause of v4-kick traced to envelope-SHA coupling. AISDLC-397 (in-flight bot workaround) has 3 critical security findings; the trust-scope schema work required to harden it (~3 days) plus ongoing bot maintenance is obviated by this 1-day root-cause fix. PRs #626 and #524 are blocked on this. Future PRs will block on this until shipped.

## Out of scope

- Removing per-SHA legacy filename support (deferred to next release after soak)
- Closing PR #631 (separate follow-up task)
- v6 cutover env flip (separate, may follow this PR)
- Re-architecting the trust model (TrustedReviewer role/scope) — not needed under content-addressed because the bot is no longer needed

## References

- Operator architectural review thread 2026-05-23
- PR #626 STUCK comment: https://github.com/ai-sdlc-framework/ai-sdlc/pull/626#issuecomment-4524856673
- PR #631 (AISDLC-397) — to be closed as workaround-not-needed once this ships
- CLAUDE.md "Review attestations" + "RFC-0042 Phase 3 cutover" sections
- git patch-id documentation: https://git-scm.com/docs/git-patch-id

## Estimated effort

1 day. Signer + verifier + tests + docs + pre-push hook.
