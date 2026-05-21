---
id: AISDLC-383.7
title: 'chore(attestation): RFC-0042 Phase 4 cleanup — delete v3/v4/v5 signer code + AISDLC-380 sub-attestation gate'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - phase-4
  - cleanup
  - removal
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.6
priority: low
blocked:
  reason: 'Awaits 30-day soak after AISDLC-383.6 cutover. Operator will unblock when soak window has elapsed AND no rollback needed.'
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
---

## Scope (RFC-0042 Phase 4)

Per RFC-0042 §Migration Phase 4, after a 30-day soak post-cutover (AISDLC-383.6) with no rollback needed, delete the legacy signer code + AISDLC-380 sub-attestation infrastructure. **Verifier code for v3/v4/v5 is retained indefinitely** per OQ-7 (every historical PR remains auditable).

### Deliverables

#### Delete

1. **v3/v4/v5 SIGNER code** in `ai-sdlc-plugin/scripts/sign-attestation.mjs` — the multi-version branching for picking which contentHash algorithm to compute, the chore-commit producer
2. **`scripts/check-attestation-sign.sh` Step 4d** — the AISDLC-380 sub-attestation verification step (replaced by v6 envelope verification)
3. **`scripts/verify-reviewer-sub-attestations.mjs`** — the standalone sub-attestation verifier
4. **`scripts/verify-reviewer-sub-attestations.test.mjs`** — its tests
5. **`ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs`** — per-reviewer signing helper
6. **`ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs`** — per-reviewer key init
7. **`CONTENTHASH_SHARED_CHURN_FILES` exclude list** — only used by v3/v4/v5 signers
8. **AISDLC-274 stale-envelope detection** in `scripts/check-attestation-sign.sh` — no longer relevant
9. **AISDLC-381 fork-PR migration** of `auto-rearm-on-dequeue.yml` — no longer needed (rebase-fragility gone in v6)
10. **`docs/operations/merge-queue-rebase-recovery.md`** runbook
11. **`docs/operations/reviewer-signing-key-runbook.md`** runbook (AISDLC-380 onboarding flow)
12. **`AI_SDLC_LEGACY_VERDICTS=1` env var support** — no longer needed

#### Retain

- **v3/v4/v5 VERIFIER code** in `scripts/verify-attestation.mjs` — moved to `legacy/` subdirectory or behind `// Pre-v6: read-only` comment block (per OQ-7)
- **Trusted reviewers schema** for operator-entry signing keys (still used by v6)
- **Existing v3/v4/v5 envelopes** in `.ai-sdlc/attestations/` — historical, verifiable forever

#### Update

13. **CLAUDE.md attestation section** — rewritten to reflect v6-only signer path; legacy verifier mentioned briefly
14. **Operator runbook** — RFC-0042 transcript-based flow becomes the only documented path

### Acceptance criteria

- [ ] #1 All deletion targets removed; codebase compiles + tests pass
- [ ] #2 v3/v4/v5 verifier code retained in `legacy/` (or equivalent) — verifies existing envelopes correctly
- [ ] #3 No new envelopes can be produced in v3/v4/v5 format (signer-side deleted)
- [ ] #4 CLAUDE.md + runbooks reflect post-cleanup state
- [ ] #5 Test suite for v3/v4/v5 verifiers preserved (so historical-PR re-verification stays tested)
- [ ] #6 No regression on PRs verifying with legacy envelopes
- [ ] #7 Coverage drops expected (mostly removal) — gate-allowed per project policy

## Out of scope

- Removing the operator's own signing key flow (still used by v6)
- Public Rekor integration (deferred to future opt-in per RFC-0042 §Alternatives)
- LLM-as-judge content plausibility (future RFC)

## Source

RFC-0042 §Migration Phase 4 + OQ-7 (keep verifiers indefinitely). The 30-day soak gate is operator-controlled; this task unblocks when operator confirms no v6 regressions surfaced post-cutover.
