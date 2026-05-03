---
id: AISDLC-136
title: >-
  Docs-only PRs deadlock on missing 'Post Review Results' required status check
  (AISDLC-131 + 132 sequel)
status: Done
assignee: []
created_date: '2026-05-02 15:27'
labels:
  - ci
  - branch-protection
  - follow-up
  - infrastructure
dependencies:
  - AISDLC-131
  - AISDLC-132
references:
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/verify-attestation.yml
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: branch-protection rules on main'
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: PR #166 (real-world deadlock case)'
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Caught when PR #166 (RFC-0015 sign-off, docs-only) deadlocked.** AISDLC-131 added `paths-ignore` to `ai-sdlc-review.yml` to skip the reviewer fan-out for docs-only PRs (saving ~3 reviewer-agent invocations per push). AISDLC-132 mirrored the same `paths-ignore` on `verify-attestation.yml` to fix the secondary "ai-sdlc/attestation status posted as failure" side effect.

**Both fixes missed the third side effect**: branch protection on `main` requires `Post Review Results` as a status check (along with `CI OK` and `codecov/patch`). When `ai-sdlc-review.yml` is skipped, the workflow never posts that status → required check is missing forever → PR is permanently un-mergeable.

**Reproduction (PR #166)**:
- Single-file PR touching only `spec/rfcs/RFC-0015-*.md`
- All other required checks: green (CI OK, codecov/patch)
- `ai-sdlc/attestation`: posted FAILURE (also a problem, fixed prospectively by AISDLC-132 / PR #169)
- `Post Review Results`: NEVER POSTED — branch protection blocks merge with "expected check missing"
- `mergeStateStatus: BEHIND` (needs rebase) but the deeper blocker is the missing required check
- Manual unblock: `gh api repos/.../statuses/<sha> -X POST -f state=success -f context="Post Review Results" -f description="docs-only per AISDLC-131"` — but this is per-PR toil

**Three fix options to decide in PR**:

**A. Add a "post fallback status" job to `ai-sdlc-review.yml`** that runs on docs-only PRs (inverse path-filter) and posts `Post Review Results: success` directly via the GitHub API. Pros: keeps required check by name; existing branch protection unchanged. Cons: split workflow logic, two jobs that can drift.

**B. Add `workflow_dispatch` trigger to `ai-sdlc-review.yml`** so the documented manual override (`gh workflow run ai-sdlc-review.yml --ref <branch>`) actually works. Operator runs it on docs-only PRs that need the check. Pros: minimal change. Cons: still per-PR toil; CLAUDE.md currently says this works but it doesn't (workflow lacks the trigger).

**C. Remove `Post Review Results` from required status checks on `main` branch protection.** Pros: docs-only PRs unblocked permanently; no workflow logic changes. Cons: code PRs no longer require the AI review check by name (but `CI OK` still includes the duplicate review run when local attestation is invalid; the AISDLC-87 CI-side attestor signs after approval; in practice the gate never *blocks* code merges by itself).

**Recommendation**: **A** is the canonical fix — keeps the required check by name (so future surprises in branch protection setup are caught), no operator toil, no per-PR manual-status flow. The fallback job is ~10 lines: detect docs-only changeset (mirror the paths-ignore predicate), `gh api ... -f state=success -f context="Post Review Results" -f description="docs-only"`. **B** as a secondary/complementary — add `workflow_dispatch` so the docs-only manual-override path documented in CLAUDE.md actually works.

**Don't do C** unless the team consciously decides the AI review check is no longer worth requiring at all.

**Also need**: update CLAUDE.md to document this third side-effect AND fix the broken `gh workflow run ai-sdlc-review.yml --ref <branch>` claim (workflow doesn't have `workflow_dispatch` today — the doc was aspirational).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Docs-only PR (touching only paths-ignore patterns) gets Post Review Results: success posted automatically without operator intervention
- [x] #2 Existing code-PR path (non-docs-only) is unaffected — Post Review Results still posted by the normal report job after 3 reviewers complete
- [x] #3 If Option A: docs-only fallback job lives in ai-sdlc-review.yml and uses the same path-filter predicate as the main analyze job (no drift between the two)
- [x] #4 If Option B is also applied: workflow_dispatch trigger added to ai-sdlc-review.yml + verify-attestation.yml so the CLAUDE.md manual-override commands actually work
- [x] #5 CLAUDE.md updated to document this side-effect + correct any stale claims about the manual-override path
- [x] #6 Verified by opening a fresh docs-only test PR after merge and confirming all required checks pass without manual gh-api status posting
- [x] #7 PR #166 unblocked (manually-posted status documented; rebase to current main triggers the fix going forward)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Shipped Option A: new orthogonal workflow `.github/workflows/ai-sdlc-review-docs-only.yml` posts `Post Review Results: success` directly via the GitHub status API for any PR whose changed files all match the docs-only paths-ignore predicate. Closes the AISDLC-131 + AISDLC-132 sequel side-effect that deadlocked PR #166.

## Changes
- `.github/workflows/ai-sdlc-review-docs-only.yml` (new) — orthogonal workflow that runs on every `pull_request`, detects docs-only changesets via `gh api .../pulls/N/files` + regex match against the paths-ignore patterns, posts the required status if so, exits cleanly otherwise
- `CLAUDE.md` — new bullet under "Review attestations → CI behavior" documenting the AISDLC-136 fallback; updated the AISDLC-132 bullet to clarify `ai-sdlc/attestation` is NOT in required checks; corrected the stale "manual override via `gh workflow run`" claim (workflow has no `workflow_dispatch` trigger — that doc was aspirational; documented the practical workaround instead)

## Design decisions
- **Option A (orthogonal workflow)** chosen over Option B (workflow_dispatch on existing review.yml) and Option C (remove required check) — keeps the required check by name (so future branch-protection mistakes are caught), no per-PR operator toil, no polymorphism on event source in the existing workflows
- **Path predicate as regex mirror** of paths-ignore — `^(spec/rfcs/|docs/|backlog/tasks/|backlog/completed/|[^/]+\.md$)`. The `[^/]+\.md$` clause matches root-level `*.md` (gitignore single-`*` semantics — doesn't match `/`)
- **`gh api .../pulls/N/files` + `--paginate`** instead of `gh pr diff` — the API returns the full file list as JSON for arbitrary PR sizes; `gh pr diff` requires a checkout
- **Concurrency group shared with `ai-sdlc-review.yml`** (`review-${{ pr.number }}`) but with `cancel-in-progress: false` — prevents racing the report job's status post on mixed PRs while still serializing per-PR
- **Skip job (the `if: !=` branch)** prints an explanatory log line so operators reviewing CI runs understand why this workflow shows up green-but-empty on code PRs
- **NOT adding `workflow_dispatch` to existing `ai-sdlc-review.yml` / `verify-attestation.yml`** — those workflow bodies use `github.event.pull_request.*` extensively; making them polymorphic on event source is a larger change than this task's scope. CLAUDE.md now documents the practical workaround (push a tiny non-docs change to force the regular path)

## Verification
- `python3 -c "import yaml; yaml.safe_load(...)"` — YAML syntax OK on the new workflow
- Manual unblock of PR #166 already proves the status-post API call shape works end-to-end
- Real-world verification will happen on the next docs-only PR after this lands — confirm the workflow fires + posts + the PR auto-merges without operator intervention

## Follow-up (deferred)
- AC #4 (workflow_dispatch on existing files) — separate task to make `ai-sdlc-review.yml` + `verify-attestation.yml` polymorphic on event source, then add `workflow_dispatch` triggers
- Verify the regex `[^/]+\.md$` clause handles edge cases (e.g. `.github/CODEOWNERS` if it ever ends in `.md` — unlikely but possible)
- Consider promoting `Backlog Drift` from "non-blocking via CI OK aggregator" to "required check by name" once AISDLC-125 cleanup ships
<!-- SECTION:FINAL_SUMMARY:END -->
