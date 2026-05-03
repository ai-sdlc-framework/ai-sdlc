---
id: AISDLC-84
title: >-
  Make attestation verifier rebase-stable — match by predicate content, not by
  commit SHA
status: Done
assignee: []
created_date: '2026-04-29 03:11'
updated_date: '2026-04-29 03:42'
labels:
  - bug
  - ci
  - attestation
  - follow-up
dependencies: []
priority: high
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists: backlog/completed/aisdlc-76 -
      Verifier-walks-parents-to-match-attestation-against-dev-commit.md
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-04-29 during the AISDLC-73/77/76/81 PR-merge cycle. Every PR in the queue produced an `invalid` attestation on the GitHub side, causing CI's `ai-sdlc-review.yml` to fall back to running its own duplicate review. The promised "skip CI review when local attestation valid" never fires in practice.

Root cause: the verifier matches the envelope at `.ai-sdlc/attestations/<sha>.dsse.json` by commit SHA. Three scenarios where the SHA on disk no longer matches the PR head:

1. **Local rebase before merge** (the user's actual workflow): when PR-A merges into main, the operator rebases PR-B onto main locally, then pushes `--force-with-lease`. Rebase rewrites every commit SHA on PR-B. The `<old-sha>.dsse.json` file no longer matches HEAD or any first-parent ancestor.
2. **GitHub merge queue (rebase mode)**: queue rebases each PR against the queue head before testing. Same SHA-rewrite problem.
3. **Force-push to fix a typo / address review comment**: any rewrite of the dev commit invalidates the attestation even if the actual reviewed CONTENT is unchanged.

AISDLC-76 added a parent-walk (`HEAD → HEAD^ → HEAD^^`, default depth 2) that handles the squash-merge / chore-commit-on-top case where ancestry is preserved. It does NOT handle rebase, because rebase rewrites every walked SHA.

## The fix

Stop matching by commit SHA. The envelope's predicate already binds to all the content that actually matters:
- `diffHash` (sha256 of `git diff <base>...<head>`)
- `policyHash` (sha256 of `.ai-sdlc/review-policy.md`)
- `agentFileHashes` (sha256 of each `ai-sdlc-plugin/agents/*-reviewer.md`)
- `pluginVersion` (string from `ai-sdlc-plugin/plugin.json`)
- `schemaVersion` (allowlist check)

These are content-addressed and survive rebase, squash, amend, force-push — anything that doesn't actually change the reviewed content.

New verifier algorithm:
1. Scan `.ai-sdlc/attestations/*.dsse.json` (all envelopes on the PR branch — PR head's tree).
2. For each: parse → recompute predicate from current PR state → compare every binding field.
3. If exactly one envelope's predicate matches, verify its signature against `trusted-reviewers.yaml` and accept.
4. If zero match: reject with the most specific mismatch reason (diff/policy/agent/version) for whichever envelope was closest.
5. If multiple match: accept the one whose signed timestamp is most recent (re-signed after iteration loop overrides earlier round).

The filename SHA becomes purely informational — useful for humans diffing attestation history but not used for verification.

## Threat-model implications

The `subject.digest.gitCommit` field still pins the envelope to a specific commit at sign-time, but the verifier no longer enforces that pin. Trade-off:

- **Lost**: the binding "this attestation was signed against THIS specific commit SHA". An attacker who obtains a valid envelope could theoretically replay it onto any PR with byte-identical diff + policy + agent files.
- **Preserved**: every content binding (diff/policy/agents/plugin-version/schema). Reviewer attests to specific REVIEWED CONTENT; attacker can't substitute different code without invalidating diffHash.
- **In practice**: replay requires obtaining another contributor's signed envelope file (pulled from a public PR is possible since the file lands in `.ai-sdlc/attestations/`) AND opening a PR with byte-identical content. Extremely narrow; the attacker would be replaying *content the reviewer already approved*, which is not an exploit.

If the team wants to keep a tighter binding, an optional middle ground: enforce that the envelope's `subject.digest.gitCommit` is reachable from the PR head (i.e., is some ancestor in `git log --all`). That preserves "the attestation came from a real commit in this repo's history" without requiring it to be the current HEAD. Implement only if security review requests it.

## Related operator action (out of scope for this task)

Enable GitHub merge queue OR auto-merge on the repo so the rebase ladder isn't manual. Once the attestation verifier is rebase-stable, the queue's automatic rebase no longer breaks attestations and the user can click "Merge when ready" once per PR and walk away.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. `scripts/verify-attestation.mjs` `runVerifier()` no longer takes `headSha` as the lookup key. Instead, scans `.ai-sdlc/attestations/*.dsse.json` and matches by recomputed predicate (diffHash + policyHash + agentFileHashes + pluginVersion + schemaVersion) against current PR state.
2. Match selection: exactly one matching envelope → accept; multiple matches → pick the most recent by signed-time; zero matches → reject with most-specific mismatch reason.
3. Signature verification still runs against `.ai-sdlc/trusted-reviewers.yaml` (unchanged).
4. Schema-version allowlist check still runs (unchanged).
5. `.github/workflows/verify-attestation.yml`: workflow inputs unchanged externally; the inner script no longer requires `PR_HEAD_SHA` as the lookup key (still passes it for diff computation).
6. Regression test: rebase scenario — original dev commit at SHA `A`, attestation at `A.dsse.json`, branch rebased so HEAD is now `B` (new SHA, same diff content). Verifier accepts.
7. Regression test: force-push amend with same content (commit message edit only) → still accepts.
8. Regression test: force-push that actually changes the diff → rejects with `diffHash mismatch`.
9. Regression test: force-push that edits `.ai-sdlc/review-policy.md` → rejects with `policyHash mismatch`.
10. Regression test: force-push that edits an agent file → rejects with `agentFileHashes[<name>] mismatch`.
11. Regression test: copy attestation from PR-A onto PR-B with different diff → rejects (diffHash mismatch).
12. Regression test: schema-version not in allowlist → rejects (existing behavior preserved).
13. Regression test: signature from untrusted pubkey → rejects (existing behavior preserved).
14. AISDLC-76's parent-walk code is removed (replaced by the predicate-scan; keeping both is dead code). Update the AISDLC-76 commit's behavior in CHANGELOG/docs.
15. CLAUDE.md "What CI rejects" section updated to reflect the new matching strategy. Add: "Rebase, amend, or force-push that doesn't change reviewed content → still valid (filename SHA is informational only)."
16. `ai-sdlc-plugin/scripts/sign-attestation.mjs` unchanged (still emits `<head-sha>.dsse.json` for human readability and audit trail; verifier just doesn't use the SHA for matching).
17. New code: 80%+ patch coverage. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean.
18. Manual end-to-end verification: run `/ai-sdlc execute` against a small task, locally rebase the resulting PR onto main, push `--force-with-lease`, confirm CI's `verify-attestation` job reports `valid` and `ai-sdlc-review` short-circuits.

## Out of scope

- GitHub merge queue / auto-merge configuration (operator admin action)
- Adding new predicate fields (e.g., test-coverage signature) — separate enhancement
- Cross-PR replay protection beyond what content-binding provides — only if security review requests it
- Modifying the DSSE envelope format or schema — current v1 schema stays
- Multi-reviewer attestation (multiple reviewers co-signing one envelope) — separate concern
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 scripts/verify-attestation.mjs runVerifier() no longer takes headSha as the lookup key. Scans .ai-sdlc/attestations/*.dsse.json and matches by recomputed predicate (diffHash + policyHash + agentFileHashes + pluginVersion + schemaVersion) against current PR state
- [x] #2 Match selection: exactly one matching envelope → accept; multiple matches → pick the most recent by signed-time; zero matches → reject with most-specific mismatch reason
- [x] #3 Signature verification still runs against .ai-sdlc/trusted-reviewers.yaml (unchanged)
- [x] #4 Schema-version allowlist check still runs (unchanged)
- [x] #5 .github/workflows/verify-attestation.yml: workflow inputs unchanged externally; inner script no longer requires PR_HEAD_SHA as lookup key (still passes it for diff computation)
- [x] #6 Regression test: rebase scenario — original dev commit at SHA A, attestation at A.dsse.json, branch rebased so HEAD is B (new SHA, same diff content). Verifier accepts
- [x] #7 Regression test: force-push amend with same content (commit message edit only) → still accepts
- [x] #8 Regression test: force-push that actually changes the diff → rejects with diffHash mismatch
- [x] #9 Regression test: force-push that edits .ai-sdlc/review-policy.md → rejects with policyHash mismatch
- [x] #10 Regression test: force-push that edits an agent file → rejects with agentFileHashes[<name>] mismatch
- [x] #11 Regression test: copy attestation from PR-A onto PR-B with different diff → rejects (diffHash mismatch)
- [x] #12 Regression test: schema-version not in allowlist → rejects (existing behavior preserved)
- [x] #13 Regression test: signature from untrusted pubkey → rejects (existing behavior preserved)
- [x] #14 AISDLC-76's parent-walk code is removed (replaced by the predicate-scan; keeping both is dead code). Update CHANGELOG/docs noting the supersession
- [x] #15 CLAUDE.md 'What CI rejects' section updated. Add: 'Rebase, amend, or force-push that doesn't change reviewed content → still valid (filename SHA is informational only)'
- [x] #16 ai-sdlc-plugin/scripts/sign-attestation.mjs unchanged (still emits <head-sha>.dsse.json for human readability and audit trail; verifier just doesn't use the SHA for matching)
- [x] #17 New code: 80%+ patch coverage. pnpm build && pnpm test && pnpm lint && pnpm format:check clean
- [ ] #18 Manual end-to-end verification: run /ai-sdlc execute against a small task, locally rebase the resulting PR onto main, push --force-with-lease, confirm CI's verify-attestation job reports valid and ai-sdlc-review short-circuits
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Rewrote `scripts/verify-attestation.mjs` to scan every `.ai-sdlc/attestations/*.dsse.json` on the PR branch and match envelopes by recomputed predicate content (diffHash + policyHash + agentFileHashes + pluginVersion + schemaVersion) instead of by `<head-sha>.dsse.json` filename lookup. The verifier is now stable across rebase, amend, force-push, and merge-queue rebase as long as reviewed CONTENT is unchanged. AISDLC-76's parent-walk + chore-commit allowlist code is fully removed (superseded by the predicate-scan).

AC #18 (manual end-to-end verification) deliberately deferred to the human after merge — the next dogfood PR will exercise the full path through CI naturally.

## Changes
- `scripts/verify-attestation.mjs` (rewritten): new exports `loadAllAttestations`, `predicateMatchReason`. Removed `collectAncestors`, `findChoreCommitViolation`, `loadAttestationsBySubject`, `resolveParentWalkDepth`, `AI_SDLC_PARENT_WALK_DEPTH` env var, `CHORE_COMMIT_ALLOWLIST`. Match algorithm: scan all envelopes, recompute predicate per envelope, exact-match → accept; multi-match tie-break by `predicate.signedAt` desc then filename; zero-match → return most-specific mismatch reason via deterministic `MISMATCH_RANK` (schema → diff → policy → agents → pluginVersion). Defense-in-depth: `safeForReason()` strips CR/LF and length-clamps any predicate field before embedding in the `reason` string.
- `scripts/verify-attestation.test.mjs` (extended): 30 tests, all pass under Node built-in test runner. Covers all 8 regression ACs (#6-#13) against a real synthetic git repo with actual signing/verification — these are real regression tests, not shape-checking stubs.
- `CLAUDE.md` (modified): "What CI rejects" section updated. Added explicit "Rebase, amend, or force-push that doesn't change reviewed content → still valid (filename SHA is informational only)" line. Surfaces the threat-model trade-off honestly: the security boundary moves from "this attestation was signed against THIS commit SHA" to "this attestation was signed against THIS reviewed content."

## Design decisions
- **Workflow YAML untouched**: `.github/workflows/verify-attestation.yml` still passes `PR_HEAD_SHA` to the script (used for `git diff <base>...<head>` to compute diffHash). Only the matching algorithm inside the script changed; external workflow contract is identical.
- **`sign-attestation.mjs` unchanged** (AC #16): still emits `<head-sha>.dsse.json` for human readability and audit trail. The verifier just doesn't use the filename SHA for matching.
- **Subject-digest field still present, no longer enforced**: `subject.digest.sha1` flows through the legacy `verifyAttestation` call as a self-comparison no-op; signature verification still runs against `.ai-sdlc/trusted-reviewers.yaml` unchanged.
- **Fail-closed on chosen-envelope signature failure**: when the most-recently-signed matching envelope has an invalid signature, the verifier returns invalid (does NOT fall through to older envelopes). Reviewers flagged this as a small DoS surface (a contributor with merged-PR access could plant a future-dated junk envelope to mask legitimate ones), but the consequence is "CI runs its own duplicate review" — the security boundary is preserved, only the optimization is degraded.

## Verification
- `pnpm build` — clean
- `pnpm test` — 30/30 in `scripts/verify-attestation.test.mjs` (Node built-in test runner), 2746 in orchestrator (vitest), all pass; no regressions
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 1 minor + 3 suggestion; test: 2 minor + 1 suggestion; security: 0 critical/major + 2 low/minor DoS-on-optimization findings)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- Reviewer suggestions (none block merge): (1) fall through to older matched envelopes when chosen one's signature fails, eliminating the multi-match DoS surface; (2) add 1MB sanity cap when reading attestation files in `loadAllAttestations`; (3) add explicit two-envelope test for the closest-rank mismatch logic; (4) add runVerifier integration test for pluginVersion drift; (5) add inverse-of-AC#2 test (most-recent envelope has invalid signature → fail-closed verified).
- AC #18 — once this PR merges, run `/ai-sdlc execute` against any small task, locally rebase, push --force-with-lease, confirm `verify-attestation` reports valid and `ai-sdlc-review` short-circuits.
<!-- SECTION:FINAL_SUMMARY:END -->
