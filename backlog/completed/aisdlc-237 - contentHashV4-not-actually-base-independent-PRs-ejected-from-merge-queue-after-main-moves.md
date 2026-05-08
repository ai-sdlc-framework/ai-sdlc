---
id: AISDLC-237
title: >-
  contentHashV4 not actually base-independent — PRs ejected from merge queue
  after main moves
status: Done
assignee: []
created_date: '2026-05-07 22:25'
labels:
  - bug
  - attestation
  - merge-queue
  - framework-bug
  - dogfood
dependencies: []
priority: high
references:
  - CLAUDE.md
  - .github/workflows/verify-attestation.yml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

CLAUDE.md describes contentHashV4 as:

> "contentHashV4 (per-file `{path, headBlobSha}` JSON map, base-independent — survives merge-queue rebases)."

In practice it does NOT survive merge-queue rebases. Witnessed empirically multiple times 2026-05-07 with PR #393 (AISDLC-230 workflow fix):

1. PR #393's branch HEAD has a valid attestation envelope. The PR-level `ai-sdlc/attestation` check posts SUCCESS.
2. PR enters the merge queue.
3. Queue rebases #393's commits onto a moved-forward main (after #391/#392/#394 land in succession).
4. Verifier runs on the rebased merge_group commit → `contentHashV4 mismatch` → PR ejected from queue.
5. Operator must manually rebase locally + re-sign attestation + force-push to recover, then re-arm auto-merge. PR enters queue again. If main moves AGAIN before #393's turn, the cycle repeats.

This blocks small-PR iteration: every rebase invalidates the envelope, defeating the design intent of v4.

## Hypotheses for the divergence

The contentHashV4 spec says "per-file `{path, headBlobSha}` JSON map". If that's literally the per-file blob hash for files in the PR's diff, then a clean rebase that preserves blob content should produce the same hash. So one of these is true:

1. **The file collector includes more files than the PR's diff.** Maybe it hashes the full tree state at HEAD, not just diffed files. Any file changed by the previous merge would shift contentHashV4.
2. **Rebase introduces blob churn the operator doesn't see.** Candidates: line-ending normalization, `Co-Authored-By` trailer rewrite when GitHub squashes the queue's commits, autocrlf settings, prettier-on-save in CI.
3. **The verifier computes contentHashV4 against the merge_group commit's tree but the envelope was signed against the PR head's tree.** If the merge_group commit's tree differs by even one byte (e.g. the queue's auto-generated merge-commit message file), the hash differs.
4. **Squash-merge alters the commit's metadata in a way that the file collector picks up.** SQUASH preserves file blobs but rewrites commit headers.

## Reproduction steps (for verification)

1. Open a small code PR (1-3 files modified, no overlap with other in-flight PRs)
2. Sign attestation locally + push
3. Wait for `ai-sdlc/attestation` check to PASS on the PR (PR-level)
4. Have another PR merge to main FIRST (so the queue rebases your PR)
5. Observe: queue should auto-admit your PR, run merge_group CI, verify-attestation should PASS on the rebased commit
6. **Observed:** `ai-sdlc/attestation` check posts FAIL with `contentHashV4 mismatch` → PR ejected

If step 6 reproduces, contentHashV4 is broken. Compute the expected hash from the merge_group commit + compare to the envelope's stored hash to identify which file diverged.

## Proposed fix paths

### Option A: Make the file collector truly per-PR-diff

Audit the file-collector implementation in the verify-attestation logic. Ensure it:
- Collects ONLY files in the PR's diff (`git diff --name-only origin/main...HEAD`)
- Hashes ONLY each file's blob SHA via `git rev-parse HEAD:<path>` (not the file content directly, to avoid line-ending normalization issues)
- Excludes the envelope file itself (already done per CLAUDE.md)

### Option B: Auto-re-sign on the merge_group commit

The verify-attestation workflow runs on `merge_group` events. On entry, if no envelope matches the merge_group commit's SHA, AND the PR's previous envelope was valid, AND the merge_group's tree only differs from PR HEAD by file blobs the previous PR(s) introduced (not by file blobs of the candidate PR), automatically synthesize a re-signed envelope keyed to the merge_group SHA.

This is essentially "trust-on-rebase" — the queue's rebase preserves intent if the diff is clean. The auto-re-sign would need a per-machine key, which the GHA runner doesn't have. Operator-machine signing is the model. So this option is hard.

### Option C: Verifier accepts envelope if PR HEAD's contentHashV4 still matches

If the verifier can locate the PR's pre-rebase HEAD (via `merge_group.head_sha`-related fields) and find an envelope at that SHA, AND that envelope's contentHashV4 matches the rebased merge_group commit's blob set (since the file blobs survive a clean rebase), accept the envelope.

This is the cleanest fix: the PR HEAD's envelope IS the source of truth, and the verifier should look it up via the PR ref rather than the merge_group SHA.

## Acceptance Criteria

- [ ] #1 Reproduce the contentHashV4 mismatch on a controlled fixture: open PR A + B, sign both, wait for B to merge first, observe A's queue-admission attestation fails
- [ ] #2 Identify which file's blob hash diverges between PR HEAD and merge_group commit (via diff of contentHashV4 computations side by side)
- [ ] #3 Determine whether the divergence is (a) more files included than expected, (b) blob churn introduced by the rebase, or (c) verifier looking at wrong commit. Document findings in this task.
- [ ] #4 Apply fix per the chosen option (A, B, C, or other once root cause known)
- [ ] #5 Add a regression test: synthesize a 2-PR fixture, rebase PR-2 over PR-1's tree, verify contentHashV4 stays stable for files in PR-2's diff
- [ ] #6 Update CLAUDE.md if the contract description needs amending (e.g. "survives merge-queue rebases UNLESS X")
- [ ] #7 Document the manual recovery workaround in operator runbook (current path: rebase locally + re-sign + force-push + re-arm auto-merge), at least until the root cause is fixed

## Composes with

- **AISDLC-230** (auto-merge re-arm on check_suite) — both are merge-queue stability fixes; together they make small-PR iteration painless
- **AISDLC-228 / AISDLC-232** (Pattern C / late-rebase) — adjacent contract concerns

## References

- `CLAUDE.md` Review Attestations section (the contract description)
- `.github/workflows/verify-attestation.yml` (the verifier surface)
- `pipeline-cli/src/runtime/attestation.ts` (file collector + hash computation — path approximate)
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` (signer surface for cross-reference)
- AISDLC-193 / AISDLC-193.1 (introducing contentHashV4 — design intent)
- Operator observation 2026-05-07: PR #393 ejected from queue with `contentHashV4 mismatch` after PR #391/#392/#394 landed ahead of it
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Reproduce contentHashV4 mismatch on a controlled 2-PR fixture
- [ ] #2 Identify which file's blob hash diverges between PR HEAD and merge_group commit
- [ ] #3 Document root cause (file-collector overscope / rebase blob churn / verifier wrong-commit lookup)
- [ ] #4 Apply fix per chosen option
- [ ] #5 Regression test: 2-PR fixture, contentHashV4 stable for diffed files after rebase
- [ ] #6 Update CLAUDE.md contract description if amendment needed
- [ ] #7 Document manual recovery workaround in operator runbook
<!-- SECTION:ACCEPTANCE:END -->
