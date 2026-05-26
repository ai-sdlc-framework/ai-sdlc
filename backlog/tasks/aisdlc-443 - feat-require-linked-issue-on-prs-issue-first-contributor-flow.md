---
id: AISDLC-443
title: 'feat(docs+ci): require linked issue on PRs + friendly issue-first contributor flow (closes #582)'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - documentation
  - ci
  - contributor-experience
  - branch-protection
dependencies: []
references:
  - .github/PULL_REQUEST_TEMPLATE.md
  - .github/workflows/
  - CONTRIBUTING.md
priority: medium
permittedExternalPaths: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (GH issue #582)

External contributor PRs without a linked issue create disproportionate maintainer overhead. Concrete incident: PR #568 (akillies fork) took multi-step maintainer intervention to land (rebase, drop stale chore commit, re-sign attestation against new HEAD, force-push to fork). The actual code change was 4 files of hook fixes.

If an Issue had been opened first, a maintainer could have implemented the same fix via `/ai-sdlc execute` in 5-20 minutes through the standard pipeline.

## Scope (per #582 proposal)

1. **Update `.github/PULL_REQUEST_TEMPLATE.md`** with a friendly "please consider opening an Issue first" preamble explaining the trade-off honestly. Don't shame contributors who skip — frame as "this is why we prefer it; here's the fast path".
2. **Add `.github/workflows/require-issue-link.yml`** that posts `ai-sdlc/issue-link: failure` status on PRs whose body lacks a `Closes/Fixes/Resolves #N` reference (case-insensitive, GitHub-Linked-Issues regex). Status check, not a hard block.
3. **Update `CONTRIBUTING.md`** with a new "Issue-first" section explaining why + the workflow.
4. **Maintainer escape**: label `ci:no-issue-required` bypasses the workflow status for self-evident chore PRs (release-please, dependabot, etc.). Workflow short-circuits when the label is present.

## Source

Operator request 2026-05-20 in active session: *"make it a requirement that all PR's must have an issue, that way we can see the issue land first then work on it"*

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.github/PULL_REQUEST_TEMPLATE.md` updated with friendly issue-first preamble (concrete benefit, not shaming)
- [ ] #2 `.github/workflows/require-issue-link.yml` posts `ai-sdlc/issue-link` status check (failure when body lacks `Closes/Fixes/Resolves #N` pattern; success otherwise)
- [ ] #3 Workflow respects the `ci:no-issue-required` label as bypass (status posts success when label present)
- [ ] #4 `CONTRIBUTING.md` adds an "Issue-first" section explaining the workflow + why
- [ ] #5 Workflow handles edge cases: cross-repo references (`Closes org/repo#N`), multiple references in one PR, references in PR title (not just body)
- [ ] #6 Hermetic tests cover: PR with issue link → success; PR without → failure; PR with bypass label → success
- [ ] #7 PR body closes #582
- [ ] #8 Optional follow-up note in PR description: operator wires `ai-sdlc/issue-link` into required branch-protection checks (out of scope for this task; needs `gh api` PATCH)
- [ ] #9 80%+ patch coverage on workflow logic + tests
<!-- AC:END -->
