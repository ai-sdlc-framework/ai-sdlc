---
id: AISDLC-211
title: >-
  Attestation gate keeps failing on rebased/docs-only PRs — systemic root-cause
  cluster
status: Done
assignee: []
created_date: '2026-05-06 05:17'
labels:
  - bug
  - tech-debt
  - ci
  - attestation
  - merge-queue
  - framework-bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Pattern

Across 5+ recurrences (2026-05-04 through 2026-05-06): the attestation gate fails on PR head SHAs that have no `.ai-sdlc/attestations/<sha>.dsse.json` envelope. Each time it gets manually fixed by signing the envelope. The recurrence pattern points at four root-cause gaps in the attestation infrastructure.

## Root causes

### 1. Verdicts file is gitignored — disappears across worktree resets

`.ai-sdlc/verdicts/<task-id-lower>.json` is in `.gitignore`. The pre-push hook auto-signs ONLY when this file exists. When a PR is rebased + force-pushed (manually OR by `auto-rebase-open-prs.yml`), the verdicts file is still on disk in the original worktree — but if the operator (or another agent) cleans up the worktree and recreates it, the file is gone. Also, when a NEW worktree is created via `git worktree add` for a manual fix, the file isn't there.

**Fix options:**
- (a) Make verdicts file tracked (commit it alongside the envelope as part of attestation chore commit). Adds ~500 bytes per PR but eliminates the disappearance.
- (b) Reconstruct verdicts on-demand from the previous envelope payload (the DSSE envelope contains the verdicts as the signed payload — verify-attestation.mjs unmarshals them).
- (c) Compute auto-approved verdicts deterministically when paths-ignore matches (docs-only PRs).

### 2. Docs-only PRs never get a verdicts file in the first place

The dev subagent skips reviewer fan-out for docs-only PRs (no real review needed). So no verdicts file → no auto-sign → manual sign required EVERY time. We hit this on PR #347, #348, #350 tonight (all docs-only chore PRs).

**Fix:** the auto-sign hook should detect docs-only diff (using the same `is-docs-only-changeset.mjs` predicate that AISDLC-206 will ship) and emit auto-approved verdicts inline instead of requiring the file.

### 3. merge_group event runs verify-attestation.yml on docs-only PRs

`paths-ignore` doesn't apply to `merge_group` events. So even though docs-only PRs skip verify-attestation.yml on `pull_request`, the merge queue runs it and finds no envelope → fail.

The docs-only fallback `verify-attestation-docs-only.yml` was supposed to handle this (AISDLC-208 added the merge_group trigger), but it gets cancelled when both fire — possibly because the regular workflow finishes first and posts a status that race-conditions the fallback's status post.

**Fix:** make the regular `verify-attestation.yml` workflow do its own docs-only detection at job-start and short-circuit successfully if the merge_group commit only touches docs paths. Eliminates the race entirely.

### 4. Auto-rebase workflow disarms auto-merge

When `auto-rebase-open-prs.yml` force-pushes the rebased SHA, GitHub clears the `autoMergeRequest` field. The workflow does NOT re-arm. So even if the rebased SHA passes all checks, the PR sits CLEAN-but-not-queued forever.

Was somewhat fixed by AISDLC-189 (PAT switch makes downstream workflows fire) but the auto-merge re-arm step is still missing from auto-rebase.

**Fix:** add a `gh pr merge --auto --rebase` step to `auto-rebase-open-prs.yml` after the force-push, conditional on the PR having had auto-merge armed before the rebase.

## Composes with

- **AISDLC-206**: shared docs-only predicate — needed for fix #2 + #3
- **AISDLC-189**: auto-rebase already uses PAT — fix #4 is the next layer
- **AISDLC-208**: merge_group docs-only fallback — fix #3 supersedes/simplifies it

## Acceptance Criteria
- [ ] #1 Auto-sign hook detects docs-only PRs (using shared predicate from AISDLC-206) and emits auto-approved verdicts inline — no verdicts file required
- [ ] #2 verify-attestation.yml does its own docs-only short-circuit at job start, returning success without needing an envelope when the merge_group commit only touches docs paths
- [ ] #3 auto-rebase-open-prs.yml re-arms auto-merge after force-push (conditional on PR having had auto-merge armed before)
- [ ] #4 Either: verdicts file becomes tracked OR auto-sign reconstructs verdicts from a previous envelope OR auto-sign computes deterministic verdicts for docs-only — any one of these closes the "verdicts file disappeared" failure mode
- [ ] #5 Hermetic test: simulate "PR rebased + force-pushed without verdicts file" → assert auto-sign still produces a valid envelope (or short-circuits)
- [ ] #6 Hermetic test: simulate "merge_group event on docs-only diff" → assert verify-attestation passes without needing an envelope
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

Implementation shipped via PR (parent task — all sub-issues 213/214/215 + 212 done). The lifecycle close was lost when the now-retired `.github/workflows/backlog-task-complete.yml` workflow's chore-close PR (#360/#362/#367/#368) failed to auto-merge (one of the orphan-PR cases that motivated AISDLC-220). Moving to `backlog/completed/` retroactively as part of the post-AISDLC-220 sync sweep.
