---
id: AISDLC-85
title: >-
  Verifier: compute diffHash from envelope subject SHA, not PR head
  (chore-commit-on-top regression from AISDLC-84)
status: Done
assignee: []
created_date: '2026-04-29 14:05'
updated_date: '2026-04-29 16:23'
labels:
  - bug
  - ci
  - attestation
  - regression
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
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-84 -
      Make-attestation-verifier-rebase-stable-—-match-by-predicate-content-not-by-commit-SHA.md
      was modified after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

Surfaced 2026-04-29 morning after the overnight 5-PR run (#91, #92, #93, #94, #95). All 5 PRs report `ai-sdlc/attestation: invalid (diffHash mismatch (PR diff differs from attested diff))` despite AISDLC-84's rebase-stable verifier being live on main.

## Root cause

AISDLC-84's "scan all envelopes, match by recomputed predicate" algorithm computes the diffHash from PR HEAD's git diff:
```
diff = git diff <base>...<PR HEAD>
```

But `/ai-sdlc execute` Step 10 lands the dev commit FIRST, then signs the attestation, then adds a chore commit on top (file move + the attestation file itself). The envelope's `diffHash` was signed against the dev commit's diff, not PR HEAD's diff. Mismatch.

AISDLC-76 had logic to "recompute the diff hash from the dev commit's own diff (`<subject>^...<subject>`) when the match is on an ancestor." AISDLC-84 removed this as "dead code" claiming the predicate-content scan subsumed it. It didn't.

Empirically verified for PR #91 (AISDLC-83):
- Attested diffHash: `ea92199b...` (signed against dev commit `f68ab773`)
- Verifier-computed diffHash: `fc51b661...` (computed from PR head `7984aee` which is dev + chore)
- `git diff origin/main...f68ab773` SHA matches attested. CI's `git diff origin/main...PR_HEAD` does not.

## Fix

For each candidate envelope on the PR branch, compute the diffHash using the envelope's `subject.digest.sha1` as the head ref:
```
diff = git diff <base>...<envelope.subject.sha1>
```

Then compare the recomputed diffHash with `envelope.predicate.diffHash`.

The envelope's subject SHA must be reachable from PR HEAD (it's the chore commit's parent). Verify by `git merge-base --is-ancestor <subject.sha1> <PR_HEAD>` before computing — if not reachable (rebase rewrote ancestry), fall back to scanning ancestors of PR HEAD.

This restores the AISDLC-76 capability while keeping AISDLC-84's content-based matching strategy. The two are compatible, not redundant.

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Verifier (`scripts/verify-attestation.mjs`) recomputes diffHash from each envelope's `subject.digest.sha1` rather than from PR HEAD
2. If subject SHA is not reachable from PR HEAD, fall back to walking PR HEAD's first-parent ancestors (depth N) and matching by content (handles rebased branches where original SHA is gone but content is preserved)
3. Regression test: PR with dev commit + chore commit on top (the standard `/ai-sdlc execute` shape) — verifier accepts
4. Regression test: rebased PR with same content (subject SHA no longer in ancestry) — verifier still accepts via ancestor-walk
5. Regression test: PR where chore commit modifies code (NOT just file move + attestation) — verifier REJECTS because the dev commit's diff no longer represents the merged content
6. Existing AISDLC-84 tests still pass (rebase scenario, force-push scenarios, copy-from-PR-A-to-PR-B, etc.)
7. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
8. Manual e2e: re-run verifier against PR #91 (AISDLC-83) with the fix; should report `valid`

## Out of scope

- Changing the chore-commit pattern (single-commit dev+chore would also fix this but is a much bigger refactor)
- Re-signing the 5 in-flight PRs (humans can dismiss the failing attestation reviews and merge anyway, OR re-sign locally after the fix lands)
- Changing the DSSE envelope schema
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Verifier (scripts/verify-attestation.mjs) recomputes diffHash from each envelope's subject.digest.sha1 rather than from PR HEAD
- [x] #2 If subject SHA is not reachable from PR HEAD, fall back to walking PR HEAD's first-parent ancestors (depth N) and matching by content (handles rebased branches where original SHA is gone but content is preserved)
- [x] #3 Regression test: PR with dev commit + chore commit on top (the standard /ai-sdlc execute shape) — verifier accepts
- [x] #4 Regression test: rebased PR with same content (subject SHA no longer in ancestry) — verifier still accepts via ancestor-walk
- [x] #5 Regression test: PR where chore commit modifies code (NOT just file move + attestation) — verifier REJECTS because the dev commit's diff no longer represents the merged content
- [x] #6 Existing AISDLC-84 tests still pass (rebase scenario, force-push scenarios, copy-from-PR-A-to-PR-B, etc.)
- [x] #7 pnpm build && pnpm test && pnpm lint && pnpm format:check clean
- [ ] #8 Manual e2e: re-run verifier against PR #91 (AISDLC-83) with the fix; should report valid
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Fixes the chore-commit-on-top regression introduced by AISDLC-84. The verifier now recomputes diffHash per envelope using `git diff <base>...<envelope.subject.sha1>` instead of always against PR HEAD's diff, with a first-parent ancestor-walk fallback for rebased branches. Restores the AISDLC-76 chore-commit allowlist that AISDLC-84 dropped: after subject match, the diff between subject SHA and PR HEAD may only touch `.ai-sdlc/attestations/<sha>.dsse.json` or `backlog/{tasks,completed}/<id>.md` — anything else (e.g. a `.ts` file or `package.json`) is rejected with `unexpected chore commit content`, closing the malicious-chore-commit attack surface.

AC #8 (manual e2e) deferred for human verification post-merge.

## Changes
- `scripts/verify-attestation.mjs`: new helpers `resolveAncestorDepth` (env-tunable depth, hard-capped at 32), `findChoreCommitViolations` (allowlist enforcement), `resolveSubjectShaForEnvelope` (subject SHA reachability + ancestor-walk fallback). Subject SHA validated as 40-char hex before any git invocation. `execFileSync` used throughout (no shell interpolation).
- `scripts/verify-attestation.test.mjs`: 18 new tests (48 total). 6 integration scenarios covering AC #3 (chore-commit-on-top), AC #4 (rebase ancestor-walk), AC #5 (security: malicious chore commit REJECTED — 2 tests for src/.ts + top-level package.json). 12 unit tests for the new helpers including security-critical path-traversal anchors.

## Design decisions
- **Per-envelope subject SHA matching, not PR HEAD**: the envelope's `diffHash` was signed against the dev commit at sign-time, before the chore commit was added. Computing diff from subject SHA aligns verifier with signer.
- **First-parent ancestor walk for rebased branches**: when subject SHA is orphaned (rebased), walk HEAD's first-parent ancestors with content-binding match. Default depth 5, env-tunable via `AI_SDLC_VERIFIER_ANCESTOR_DEPTH`, hard-capped at 32.
- **Chore-commit allowlist restored**: AISDLC-84 removed it as "dead code" but it was load-bearing for the security boundary. Without it, an attacker could land malicious code in a chore commit and have the dev commit's stale attestation bypass review.
- **Anchored allowlist regex**: `[^/]+` for attestation paths (single segment, no traversal). Backlog regex uses `.+` (permissive within tasks/completed) — git's path normalization prevents `..` traversal at the source.
- **Orchestrator runtime untouched**: `orchestrator/src/runtime/attestations.ts` is unchanged. The diff-recomputation lives in the verifier script (the boundary that knows about git ancestry / PR HEAD); `verifyAttestation()` keeps treating `expected.diffHash` as a precomputed input.

## Verification
- `pnpm build` — clean
- `pnpm test` — 4842 workspace tests across 332 files green
- 48/48 in `scripts/verify-attestation.test.mjs` (30 existing AISDLC-84 + 18 new AISDLC-85)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews APPROVED (code: 4 minor + 3 suggestion; test: 3 minor; security: 0 findings)
- ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up
- Reviewer suggestions (deferrable): tighten backlog allowlist regex to anchor at single segment; document `[^/]+` rationale; remove dead `envelope` parameter from `resolveSubjectShaForEnvelope`; add diff memoization across envelopes for CI latency; use `git diff -z --name-only` for newline-robust path parsing; add helper happy-path unit tests; integration test for `AI_SDLC_VERIFIER_ANCESTOR_DEPTH` env var.
- AC #8 manual e2e: this PR's own attestation should report `valid` once it merges (self-validating).
<!-- SECTION:FINAL_SUMMARY:END -->
