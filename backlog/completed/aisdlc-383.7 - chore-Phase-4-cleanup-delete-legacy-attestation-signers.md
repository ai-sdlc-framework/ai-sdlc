---
id: AISDLC-383.7
title: 'chore(attestation): RFC-0042 Phase 4 cleanup — delete v3/v4/v5 signer code + AISDLC-380 sub-attestation gate'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-20'
completed_date: '2026-05-25'
labels:
  - rfc-0042
  - phase-4
  - cleanup
  - removal
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.6
priority: low
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

- [x] #1 All deletion targets removed (subset — see finalSummary); codebase compiles + tests pass
- [x] #2 v3/v4/v5 verifier code retained in `scripts/verify-attestation.mjs` (read-only path; v6 preferred → v5 → v4 → v3 fallback) — verifies existing envelopes correctly
- [ ] #3 No new envelopes can be produced in v3/v4/v5 format — **NOT MET in this PR.** v5 signer path is RETAINED behind `--schema-version v5` / `AI_SDLC_V5_LEGACY=1` for ad-hoc reviewer flows that have not yet wired transcript-leaf emission; full signer deletion deferred (see finalSummary §Follow-up).
- [x] #4 CLAUDE.md + runbooks reflect post-cleanup state (reviewer-signing-key-runbook + merge-queue-rebase-recovery deleted; CLAUDE.md attestation section updated)
- [x] #5 Test suite for v3/v4/v5 verifiers preserved (verify-attestation tests pass 118/118)
- [x] #6 No regression on PRs verifying with legacy envelopes (verify-attestation gate passes)
- [x] #7 Coverage drops expected (mostly removal) — gate-allowed per project policy

## Out of scope

- Removing the operator's own signing key flow (still used by v6)
- Public Rekor integration (deferred to future opt-in per RFC-0042 §Alternatives)
- LLM-as-judge content plausibility (future RFC)

## Source

RFC-0042 §Migration Phase 4 + OQ-7 (keep verifiers indefinitely). The 30-day soak gate is operator-controlled; this task unblocks when operator confirms no v6 regressions surfaced post-cutover.

## finalSummary

### Summary

Phase 4 cleanup delivers the **safe-to-delete subset** of the RFC-0042 §Migration Phase 4 deletion targets — the AISDLC-380 per-reviewer sub-attestation infrastructure (verifier script, signer helper, key-init helper, hook Step 4d gate, reviewer agent prose, env-var support) plus two obsolete operational runbooks. The v6 envelope flow (default since AISDLC-409) does not depend on any of these pieces; v5 signer path remains opt-in for ad-hoc reviewer flows that have not yet wired transcript-leaf emission. v3/v4/v5 **verifier** code is retained per OQ-7 so every historical PR remains auditable. Several originally-scoped deletions were deferred as out-of-band-risky (see Follow-up below).

### Changes

- `scripts/verify-reviewer-sub-attestations.mjs` (deleted), `+ .test.mjs` — standalone sub-attestation verifier + its tests.
- `ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs` (deleted), `+ .test.mjs` — per-reviewer signing helper + tests.
- `ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs` (deleted), `+ .test.mjs` — per-reviewer key-init + tests.
- `docs/operations/merge-queue-rebase-recovery.md` (deleted) — merge queue was removed in AISDLC-400; runbook obsolete.
- `docs/operations/reviewer-signing-key-runbook.md` (deleted) — onboarding flow for the deleted per-reviewer signing keys.
- `scripts/check-attestation-sign.sh` (modified): deleted Step 4d (AISDLC-380 sub-attestation gate). Step 4c (AISDLC-274 stale-envelope detection) is retained because the v5 opt-in chore-commit pattern still depends on it.
- `scripts/check-attestation-sign.test.mjs` (modified): deleted the six tests that exercised the audit-only / hard-fail / TEST_MODE-bypass / v6-skip-message paths of the deleted gate. Retained: bypass, sentinel, verdict-file-absent, idempotency, sign+commit, re-push hint, deferral, signer-failure, signer-silent, uppercase-task-id, iteration-count, loop-prevention (AISDLC-135), brand-new-dev-commit (AISDLC-135), docs-only no-op (AISDLC-387), CODEX_VERSION harness (AISDLC-250), skip-CI-token guard, default-v6 schema, stale-envelope (AISDLC-274). Removed `AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD` / `AI_SDLC_TEST_MODE` stub-injection from `cleanEnv` — no longer consulted by the hook.
- `ai-sdlc-plugin/agents/{code,test,security}-reviewer{,-codex}.md` (modified): replaced the "Sub-attestation (AISDLC-380 — MANDATORY)" / "(KNOWN LIMITATION)" sections with a short "Attestation handoff (post-AISDLC-383.7)" section pointing reviewers at the v6 transcript-leaf flow. Updated the Codex-variant Step 7 "Sign and return the verdict" to "Return the verdict".
- `package.json` (modified): dropped `test:sub-attestation-gate` script + its inclusion in the aggregate `test` chain.
- `.ai-sdlc/agent-role.yaml` (modified): removed `scripts/verify-reviewer-sub-attestations.mjs` from `blockedPaths` and the `*reviewer-keys*` / `*~/.ai-sdlc/reviewer-keys*` entries from `blockedActions`. `scripts/verify-attestation.mjs` remains blocked.
- `.ai-sdlc/trusted-reviewers.yaml` (modified): rewrote the schema docblock to describe only the OPERATOR ENTRY type; called out that historical `type: 'reviewer'` rows are inert post-AISDLC-383.7 and can be removed in a follow-up.
- `scripts/pre-push-fixups.test.mjs` (modified): updated the comment on the env-var scrub for `AI_SDLC_VERIFY_SUB_ATTESTATIONS_CMD` / `AI_SDLC_TEST_MODE` so it explains the post-cleanup defensive scrub semantics.
- `CLAUDE.md` (modified): rewrote the "AISDLC-380 sub-attestation gate" paragraph to "REMOVED (AISDLC-383.7)" and updated the v3/v4/v5 verifier-retention paragraph to reflect that v5 signer is opt-in (not "scheduled for deletion").

### Design decisions

- **Deferred the full v3/v4/v5 signer deletion** (deletion target #1 in the task body): the v5 signer path remains active behind `--schema-version v5` / `AI_SDLC_V5_LEGACY=1` because ad-hoc reviewer flows that do not emit transcript leaves still rely on it. Aggressively deleting v5 mid-soak would have stranded those flows with no migration path; the cleaner sequence is a follow-up that first lands transcript-leaf emission on the remaining ad-hoc paths, then deletes v5 signer in one atomic PR.
- **Retained `CONTENTHASH_SHARED_CHURN_FILES`** (deletion target #7): the task body's claim "only used by v3/v4/v5 signers" is incorrect. The constant is exported from `orchestrator/src/runtime/attestations.ts` and consumed by **both** sides of the v3/v4/v5 hash recomputation in `scripts/verify-attestation.mjs`. Deleting it would break the retained verifier (which AC #2 + OQ-7 require we preserve).
- **Retained AISDLC-274 stale-envelope detection** (deletion target #8): the stale-envelope sweep (Step 4c of `check-attestation-sign.sh`) is still required by the v5 chore-commit re-sign pattern when a rebase shifts the parent SHA. Removing it would have regressed v5 opt-in flows. The block can be deleted alongside the v5 signer once that follow-up lands.
- **Retained AISDLC-381 fork-PR migration** of `auto-rearm-on-dequeue.yml` (deletion target #9): the workflow itself is still in active service (cron-based "ensure auto-merge stays armed" safety net per AISDLC-400). The AISDLC-381 narrative comments in its header could be cleaned up but the `pull_request_target` migration is independent of v6 rebase-fragility and remains necessary for fork-PR support.
- **Kept the `--print-content-hash` mode** in `sign-attestation.mjs`: still consumed by `/ai-sdlc execute` Step 10.5 and `/ai-sdlc rebase` as the AISDLC-102 oracle. Coordinated changes to those slash commands are tracked under RFC-0042 follow-up scope; out of scope for a cleanup PR.

### Verification

- `pnpm build` — clean (orchestrator + pipeline-cli + dashboard all built)
- `pnpm test` — clean (full aggregate; per-gate counts: attestation-sign 22/22, sign-attestation 17/17, pre-push-fixups 10/10, verify-attestation 118/118)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

The following originally-scoped deletions were deferred. File as follow-up sub-tasks under AISDLC-383 (RFC-0042 umbrella); each item names the prerequisite tracked work or rationale inline:

1. **Delete v5 signer path in `sign-attestation.mjs`** (deletion target #1). Blocked on AISDLC-409 follow-up — the ad-hoc reviewer flows that opt into `--schema-version v5` / `AI_SDLC_V5_LEGACY=1` first need transcript-leaf emission wired in.
2. **Delete AISDLC-274 stale-envelope detection** (deletion target #8) — depends on (1).
3. **Delete `--print-content-hash` mode** in `sign-attestation.mjs` and corresponding callers in `/ai-sdlc execute` Step 10.5 and `/ai-sdlc rebase`.
4. **Drop `CONTENTHASH_SHARED_CHURN_FILES`** (deletion target #7) — only safe once the v3/v4/v5 verifier code is also retired (i.e. when OQ-7's "auditable forever" guarantee is relaxed).
5. **Clean the AISDLC-381 narrative comments** in `.github/workflows/auto-rearm-on-dequeue.yml` (deletion target #9) — header comments only; the workflow body is still load-bearing.
6. **Delete inert `type: 'reviewer'` rows** from `.ai-sdlc/trusted-reviewers.yaml` (if any exist on main at follow-up time).
