---
id: AISDLC-129
title: >-
  Investigate gh pr create --base flag silently falling back to main on stacked
  PR
status: To Do
assignee: []
created_date: '2026-05-01 22:50'
labels:
  - infrastructure
  - ci
  - follow-up
  - low-priority
milestone: m-3
dependencies: []
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - 'https://github.com/ai-sdlc-framework/ai-sdlc/pull/157'
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When opening AISDLC-128 PR #157 with `gh pr create --base ai-sdlc/aisdlc-126-expand-secret-patterns-registry --head ai-sdlc/aisdlc-128-redact-cosmetic-minors`, GitHub silently used `base=main` instead. The chained-base intent was lost, leading to the StackedPRBaseSquashed failure (RFC-0015 §5.1) when AISDLC-126 PR #154 squash-merged.

Possible causes:
- The `--base` flag was rejected silently because the base branch was an open PR's head (gh CLI may have a fallback)
- Repository config has a default-base auto-fill that overrides
- gh CLI version-specific behavior

Reproduce + decide whether to:
1. Switch to `gh api -X POST repos/.../pulls -f base=...` for stacked PRs (raw API)
2. Document the gh CLI limitation in CLAUDE.md
3. File upstream issue with cli/cli

Low priority — the rebase remediation is mechanical (per RFC-0015's new `StackedPRBaseSquashed` mode); this is just to avoid the trip in the first place.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Reproduce the issue with a fresh stacked PR + identify root cause (gh CLI fallback vs repo config vs version)
- [ ] #2 Document the gh CLI behavior in CLAUDE.md if it's a known limitation
- [ ] #3 Either switch to `gh api` for stacked PRs OR add a guard that warns when `--base` is silently overridden
- [ ] #4 Update RFC-0015 §5.1 `StackedPRBaseSquashed` row if the upstream fix changes the trigger conditions
<!-- AC:END -->
