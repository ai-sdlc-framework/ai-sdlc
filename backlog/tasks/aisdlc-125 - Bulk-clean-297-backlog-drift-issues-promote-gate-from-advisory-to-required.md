---
id: AISDLC-125
title: Bulk-clean 297 backlog-drift issues + promote gate from advisory to required
status: To Do
assignee: []
created_date: '2026-05-01 21:24'
labels:
  - ci
  - infrastructure
  - backlog-drift
  - follow-up
milestone: m-3
dependencies: []
references:
  - .github/workflows/ci.yml
  - docs/upstream-bug-reports/backlog-drift-url-fragment-false-positive.md
  - >-
    backlog/completed/aisdlc-119 -
    Tighten-the-backlog-drift-husky-pre-commit-hook-to-FAIL-on-errors-not-just-warn.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-119 was scoped as "stop the bleeding" — the gate landed advisory (`continue-on-error: true`, excluded from `ci-ok` `needs[]`) because main carried 259 pre-existing drift issues. The count has grown to 297 (verified on PR #150 CI run 25233237832) and the gate produces ~70% false-positive noise.

**Two-stage cleanup:**

1. **Land the upstream backlog-drift fix** for the URL-fragment false-positive (separate task — see docs/upstream-bug-reports/backlog-drift-url-fragment-false-positive.md). Once `backlog-drift@0.1.3+` ships and lands in our package.json (or our CI pin), 70% of issues evaporate.

2. **Bulk-fix the remaining genuine drift** (~90 issues after the upstream fix). Per CLAUDE.md, `npx backlog-drift fix --task <id>` rewrites in-place. Two sub-passes:
   - Per-task: walk the offender list, run `fix` on each, manually review the diff
   - Genuinely-missing files: `backlog/docs/ppa-product-signoff-rfc0011.md`, `.ai-sdlc/dor-config.yaml`, etc. — decide whether to create the missing file (if it should exist) or remove the reference (if it was speculative)

3. **Promote the gate to required**: drop `continue-on-error: true` from the `backlog-drift` job in `.github/workflows/ci.yml` AND add `backlog-drift` to `ci-ok`'s `needs[]` array. After this, drift introduced by future PRs becomes a hard merge block.

**Why now:** running 297 false-positive failures on every PR erodes operator trust in the gate (and in CI generally). The fix is a one-time investment; the long-term return is a gate that actually catches what it's designed to catch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Upstream backlog-drift URL-fragment fix landed (backlog-drift@0.1.3+ available)
- [ ] #2 Repo's backlog-drift CI pin / package.json updated to the fixed version
- [ ] #3 Run `npx backlog-drift check` against full repo: 0 drift errors
- [ ] #4 Walk every genuinely-missing file reference: either create the file (if planned but never built) or remove the reference (if speculative). Document each decision in the cleanup PR body.
- [ ] #5 `.github/workflows/ci.yml` Backlog Drift job: remove `continue-on-error: true`
- [ ] #6 `.github/workflows/ci.yml` ci-ok job: add `backlog-drift` to `needs[]` array
- [ ] #7 Open a follow-up cleanup PR after promotion to verify the new required gate fires correctly on a deliberately-broken reference
- [ ] #8 CLAUDE.md AISDLC-119 section updated: "strict drift gate" no longer carries the 'currently advisory' caveat
<!-- AC:END -->
