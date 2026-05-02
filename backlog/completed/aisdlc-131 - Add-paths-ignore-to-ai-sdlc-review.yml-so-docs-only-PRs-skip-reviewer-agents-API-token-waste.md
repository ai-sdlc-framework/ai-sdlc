---
id: AISDLC-131
title: >-
  Add paths-ignore to ai-sdlc-review.yml so docs-only PRs skip reviewer agents
  (API token waste)
status: Done
assignee: []
created_date: '2026-05-01 23:46'
labels:
  - ci
  - infrastructure
  - cost
  - follow-up
milestone: m-3
dependencies: []
references:
  - .github/workflows/ai-sdlc-review.yml
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Concrete operator-felt waste**: every push to a PR triggers `ai-sdlc-review.yml` which runs 3 reviewer subagents on the Anthropic API. Docs-only iterations (RFC drafts, backlog task edits, README tweaks) don't need code review but currently trigger the full fan-out anyway.

**Verified live**: 8 review runs on `rfc/0015-autonomous-pipeline-orchestrator-draft` in ~1 hour during the RFC-0015 design session. Each run = 3 reviewer agents = ~24 API invocations on what amounts to spec-document iteration.

**Fix**: add `paths-ignore` to the workflow trigger so PRs that ONLY touch docs/RFC/backlog files skip the review job. Mixed PRs (docs + code) still trigger — `paths-ignore` is "skip if ALL changed files match", which is the right behavior.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
    paths-ignore:
      - 'spec/rfcs/**'
      - 'docs/**'
      - 'backlog/tasks/**'
      - 'backlog/completed/**'
      - '*.md'  # root-level READMEs / CHANGELOGs
      # NOTE: per-package CHANGELOGs at <pkg>/CHANGELOG.md are NOT covered by '*.md' (single-segment glob),
      # but those land via release-please which already skips review per existing branch filter.
```

**Why path-ignore not path-positive**: a positive `paths:` list would require enumerating every code path that DOES need review. Easier to fail-open for code (run the review) and explicitly exempt the docs surfaces.

**Verification approach**: after merging, push a docs-only commit (e.g., RFC iteration) to a test PR and confirm `ai-sdlc-review.yml` doesn't run (use `gh run list --workflow=ai-sdlc-review.yml --branch <test-branch>` — should show no new run for the docs commit).

**Composes with RFC-0015 cost model** (§12): part of the "API tokens consumed only for legitimate code review" budget. Currently the budget is leaking on docs iterations.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `.github/workflows/ai-sdlc-review.yml` `on.pull_request` adds `paths-ignore` covering `spec/rfcs/**`, `docs/**`, `backlog/tasks/**`, `backlog/completed/**`, and root-level `*.md`
- [x] #2 Verify behavior on a test PR: docs-only commit → no `ai-sdlc-review.yml` run; mixed (docs + code) commit → review runs normally
- [x] #3 Verify `verify-attestation.yml` is NOT modified — it should still run on docs-only PRs to keep the `ai-sdlc/attestation` status check current (cheap, no API tokens)
- [x] #4 If a docs-only PR somehow needs a review (rare — e.g., contributor PR that should still get scrutiny), document the manual override: `gh workflow run ai-sdlc-review.yml --ref <branch>`
- [x] #5 CLAUDE.md updated under "## Review attestations" → "### CI behavior" noting that docs-only PRs skip the reviewer fan-out
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added `paths-ignore` to ai-sdlc-review.yml. Docs-only PRs skip the 3-reviewer fan-out. CLAUDE.md updated.

## Verification
- 5/5 ACs met; combined review APPROVED 0c/0M/0m/1s
<!-- SECTION:FINAL_SUMMARY:END -->
