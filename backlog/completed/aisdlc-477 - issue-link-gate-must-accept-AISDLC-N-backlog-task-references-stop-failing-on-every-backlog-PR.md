---
id: AISDLC-477
title: >-
  issue-link gate must accept AISDLC-N backlog-task references (stop failing on
  every backlog PR)
status: To Do
assignee: []
created_date: '2026-05-29 17:43'
labels:
  - ci-friction
  - ci-noise
  - github-workflow
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (audit 2026-05-29)

The `ai-sdlc/issue-link` check (`.github/workflows/require-issue-link.yml`, AISDLC-443) posts a FAILURE on nearly every backlog-task PR because its regex only accepts GitHub issue references:

```bash
# ~line 87
PATTERN='(closes|fixes|resolves)[[:space:]]+(([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)?#[0-9]+)'
```

Backlog-task PRs reference `AISDLC-N` (the two-track workflow: GitHub-issue track vs. Backlog.md track), so they never match → red X on every backlog PR.

## Important: this is NON-BLOCKING but corrosive

Confirmed via audit: `ai-sdlc/issue-link` is NOT in the `ai-sdlc/pr-ready` rollup's `needs:` list and is NOT a branch-protection required check. It does not block merge. BUT a red X on every single PR trains the team to ignore CI and looks broken to any adopter evaluating the framework. Worth fixing for signal hygiene + adoption optics.

## Fix (Option A — minimal, additive)

Extend the regex on ~line 87 to also accept hierarchical AISDLC task IDs:

```bash
PATTERN='(closes|fixes|resolves)[[:space:]]+(([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)?#[0-9]+|AISDLC-[0-9]+(\.[0-9]+)?)'
```

Also accept a bare `References AISDLC-N` / `AISDLC-N` line (backlog PRs use "References AISDLC-N" in the body, not "Closes"), OR exempt branches matching `^ai-sdlc/aisdlc-` (Option B). Decide which during implementation — additive regex (Option A) is lowest-risk.

## NOTE: this is a `.github/workflows/` file

Per governance, agents cannot edit `.github/workflows/**` (hook-blocked + hard rule). This task requires the OPERATOR to apply the change directly, OR to explicitly authorize a dispatch with the workflow-edit restriction lifted for this specific task. The exact one-line regex change is specified above so it can be applied by hand in seconds.

## Source files
- `.github/workflows/require-issue-link.yml` (~line 87 PATTERN; bypass-label logic ~lines 65-77)

Blast radius: very low — additive pattern match, no behavioral change for existing GH-issue PRs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `require-issue-link.yml` regex accepts `AISDLC-N` and hierarchical `AISDLC-N.M` references (closes/fixes/resolves OR a References line), OR exempts `ai-sdlc/aisdlc-*` branches
- [ ] #2 A backlog-task PR referencing `AISDLC-N` posts `ai-sdlc/issue-link: success` instead of failure
- [ ] #3 Existing GitHub-issue PRs using `Closes #N` continue to pass unchanged
- [ ] #4 The `ci:no-issue-required` bypass label continues to work
- [ ] #5 CONTRIBUTING.md updated if the issue-first-workflow rule wording changes
- [ ] #6 Operator applied the change (workflow file) OR explicitly authorized a workflow-edit dispatch for this task
<!-- AC:END -->
