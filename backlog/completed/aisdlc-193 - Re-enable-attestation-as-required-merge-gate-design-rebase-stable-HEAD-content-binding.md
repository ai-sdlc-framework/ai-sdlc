---
id: AISDLC-193
title: >-
  Re-enable attestation as required merge gate + design rebase-stable
  HEAD-content binding
status: Done
assignee: []
created_date: '2026-05-04 22:14'
labels:
  - enhancement
  - ci
  - attestation
  - framework-quality
  - rfc-0012
dependencies: []
references:
  - .github/workflows/verify-attestation.yml
  - scripts/verify-attestation.mjs
  - pipeline-cli/src/incremental-review/incremental.ts
  - pipeline-cli/src/cli/pr-unstick.ts
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal

Reverse AISDLC-140 sub-4 (attestation audit-only demotion) so missing attestations BLOCK merge. Pair with a binding semantic that survives queue rebases.

## Background

AISDLC-140 sub-4 demoted `verify-attestation.yml` to audit-only because of a rebase-invalidation loop:

1. Reviewers approve, envelope signed against PR HEAD content
2. Sibling PR merges into main → main moves
3. Merge queue rebases this PR onto new tip
4. Files this PR touched were ALSO touched by the sibling PR → `baseBlobSha` for those files changed
5. `contentHashV3 = sha256("<baseBlobSha> -> <headBlobSha>")` invalidates (per-file `fileDeltaHash` is base-dependent — see `pipeline-cli/src/incremental-review/incremental.ts:592`)
6. Pre-push hook auto-resigns → triggers CI re-run → queue re-rebases → invalidates again → loop

The audit-only demotion broke the loop but lost the merge-gate guarantee. **Today's empirical evidence**: 6 PRs (#240-#256 batch) shipped to main without ANY attestation OR CI-side review running, and CI didn't catch it (operator caught it manually + filed retroactive attestations as PR #281 → #301).

## Two-stage delivery

### Stage 1 — re-enable as required (this task)

1. Update `.github/workflows/verify-attestation.yml`:
   - Add `permissions: statuses: write`
   - Replace the audit-only "Log audit result" step with one that posts `ai-sdlc/attestation: success` (when verifier returns `valid`) or `failure` (when verifier returns `invalid`)
   - Keep merge_group trigger so queue-tip verification posts the status against the queue branch's HEAD
2. Update branch protection on `main` to add `ai-sdlc/attestation` to required status checks
3. Update CLAUDE.md: remove "audit-only" wording; describe attestation as a required gate again
4. Open a small test PR; observe whether queue rebases break it
5. Document the failure pattern (if any) for stage 2

### Stage 2 — HEAD-content binding (separate child task once stage 1 confirms the failure)

Replace `contentHashV3` (per-file delta hash, base-dependent) with `contentHashV4` (per-file `{path, headBlobSha}` map, base-independent):

```ts
// v3 (current, base-dependent):
fileDeltaHash = sha256("<baseBlobSha> -> <headBlobSha>")

// v4 (proposed, head-only):
contentHashV4 = sha256(JSON.stringify(sorted [{path, headBlobSha}]))
```

Reviewer attests "I reviewed these files at these blob SHAs." Verifier checks: for every currently-changed file, does its current headBlobSha appear in the envelope's per-file map? If yes → content-equivalent regardless of how base moved.

Tradeoff: lose "I reviewed the DELTA" semantic. Acceptable because reviewers approve content at HEAD, not deltas in isolation.

## Composes with

- AISDLC-189 (auto-rebase token): when stage 2 lands, auto-rebase becomes safe again because rebase no longer invalidates attestation
- AISDLC-192 (auto-merge --squash workaround): orthogonal, both ship independently

## What we already know (from today's investigation)

- `contentHashV3` is implemented in `pipeline-cli/src/incremental-review/incremental.ts`
- Verifier walks ancestors looking for content-match; doesn't help in queue branch (PR's old SHAs aren't ancestors of queue tip)
- `pr-unstick.ts:241` already detects "stale-attestation" reason — recovery path exists for individual stuck PRs
- Pre-push hook (`scripts/check-attestation-sign.sh`) auto-signs the envelope, so the local-side flow already works

## Incident log — bumped to top of critical path 2026-05-05

PR #332 (slash-command-body fix for AISDLC-180/AISDLC-156 regressions in `ai-sdlc-plugin/commands/execute.md`) was pushed with `AI_SDLC_SKIP_ATTESTATION_SIGN=1` because Claude was authoring outside a `/ai-sdlc execute` dispatch (no `.active-task` sentinel). CI's `ai-sdlc-review.yml` then skipped all 3 reviewers with `Post Review Results: skipped (budget exhausted)` because the API-key budget cap was hit. Net: a real code-path PR (3 files, 224 insertions) sat at `ai-sdlc/attestation: FAILURE` with NO actual reviewer scrutiny while CI showed green-enough-to-merge. Operator caught it manually and reinforced the discipline:

> "the attestation should be required for PR's to merge if it changes any code paths"
> "CI/CD should have caught it and required you to run the attestation for the PR to merge."

Two memories were added the same session to enforce the Claude-side discipline (`feedback_always_spawn_reviewers.md`, `feedback_always_sign_attestation.md`), but the structural fix is THIS task — making `ai-sdlc/attestation` an actually-required check on `main` so future bypass attempts fail loud at the merge gate. AC #3 was executed inline immediately after this task edit (via `gh api .../branches/main/protection/required_status_checks/contexts -X POST -f 'contexts[]=ai-sdlc/attestation'`).

## Rollback note — same session 2026-05-05 (~1 hour later)

Stage 1's required-check flip immediately reproduced the queue-rebase invalidation loop documented in this task's Background section. PR #334 (AISDLC-205 — the docs-only fallback workflow) entered the queue, the queue created a fresh replay commit `1c93ce75` whose ancestors did NOT include the envelope's subject SHA (`5ceea7da`), the verifier's ancestor walk failed, and `ai-sdlc/attestation: failure — contentHashV3 mismatch (PR content differs from attested content)` got posted on the queue commit → queue rejected the PR.

Empirical confirmation: stage 1 alone is NOT viable without stage 2 (contentHashV4 redesign). The protection flip was rolled back via `gh api ... DELETE` so existing in-flight PRs (#333, #334) can merge. Required checks are back to the pre-flip 3 (`codecov/patch`, `Backlog Drift`, `ai-sdlc/pr-ready`).

**Sequencing now locked:**
1. Land contentHashV4 (stage 2) FIRST — base-independent per-file `{path, headBlobSha}` hash that survives queue rebases. Plus exclusion of `.ai-sdlc/attestations/<sha>.dsse.json` from the hash computation (the envelope file mustn't be hashed by an envelope that doesn't yet contain it — chicken-and-egg).
2. Then re-do stage 1 (re-add `ai-sdlc/attestation` to required_status_checks) — this time the gate actually holds.
3. Then file follow-ups for the verify-attestation-docs-only.yml workflow that #334 added (correct as-is, just needs the gate to be live to be useful).

Until stage 2 lands, the operator-side rule remains: "always sign attestation on code-touching PRs" stays in `feedback_always_sign_attestation.md` (the discipline) — the cryptographic record persists even though merge isn't gated on it yet. AISDLC-205 (the docs-only fallback) ships anyway because once stage 1 is re-attempted, the docs-only deadlock will need the workflow already in place.

Acceptance: stage 1 ACs #1, #2 are already partially in place from AISDLC-140 sub-4 era code (the workflow posts the status; it just isn't required). AC #3 was done + immediately undone. Re-do AC #3 only AFTER stage 2 ships.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 verify-attestation.yml posts ai-sdlc/attestation: success status when verifier returns valid
- [ ] #2 verify-attestation.yml posts ai-sdlc/attestation: failure status when verifier returns invalid (with reason in description)
- [ ] #3 Branch protection on main requires the ai-sdlc/attestation status (separate operator action: gh api repos/.../branches/main/protection/required_status_checks/contexts -X POST -f contexts[]=ai-sdlc/attestation)
- [ ] #4 CLAUDE.md updated: remove 'audit-only' wording; describe attestation as a required gate
- [ ] #5 Stage 2 design task filed once stage 1 reveals the queue-rebase failure (if it does); description must include the contentHashV4 spec from this task's description
- [ ] #6 Test plan: open a no-op docs PR, observe ai-sdlc/attestation: success on the queue branch's HEAD (queue rebase shouldn't invalidate since docs-only PRs skip the verifier via paths-ignore)
- [ ] #7 Test plan: open a code PR that touches a file recently changed by another PR, observe whether ai-sdlc/attestation: failure fires after queue rebase (this is the expected stage-1 failure that motivates stage 2)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped over multiple PRs across two stages: stage 1 attempt → rolled back → stage 2 (PR #335 contentHashV4) → stage 1 redo (re-added ai-sdlc/attestation to required_status_checks); both verified working via PR #336.
<!-- SECTION:FINAL_SUMMARY:END -->
