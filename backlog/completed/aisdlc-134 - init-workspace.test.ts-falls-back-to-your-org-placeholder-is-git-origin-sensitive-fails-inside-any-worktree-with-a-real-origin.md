---
id: AISDLC-134
title: >-
  init-workspace.test.ts > 'falls back to your-org placeholder' is
  git-origin-sensitive — fails inside any worktree with a real origin
status: To Do
assignee: []
created_date: '2026-05-02 03:20'
labels:
  - test-isolation
  - orchestrator
  - flake
  - follow-up
dependencies: []
references:
  - orchestrator/src/cli/commands/init-workspace.test.ts
  - orchestrator/src/cli/commands/git-remote.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Caught during AISDLC-115.6 dispatch (PR #168).** The `init — single-repo (AISDLC-78 git-remote fallback) > falls back to your-org placeholder when git origin is missing` test in `orchestrator/src/cli/commands/init-workspace.test.ts` fails when executed from inside a git worktree that has a real `origin` remote configured.

**Symptom:**
```
AssertionError: expected 'apiVersion: ai-sdlc.io/v1alpha1\nkind…' to contain 'org: your-org'
- Expected: org: your-org
+ Received: ...config: org: ai-sdlc-framework
```

**Root cause:** the test exercises the "no git origin" fallback by relying on the test's working directory not having an origin. Inside `.worktrees/<task>/` (which is a real git worktree of this repo), the origin IS configured, so the function under test returns the real org instead of the `your-org` placeholder.

**Impact:** every `/ai-sdlc execute` run that lands in a worktree fails the husky pre-push coverage gate on this test alone, forcing operators to skip the gate (`AI_SDLC_SKIP_COVERAGE_GATE=1`). This silently disables the rest of the gate for that push — a real regression elsewhere in the workspace would also slip through.

**Fix candidates (decide in PR):**
- A) Use `tmpdir()` + `git init` (no remote) inside the test's `beforeEach` so the test always sees a clean repo with no origin
- B) Mock the git-remote resolver to deterministically return null for this test, regardless of cwd
- C) Add a `process.env.AI_SDLC_FORCE_NO_ORIGIN=1` escape that the test sets, that the resolver checks first

A is canonical — actually exercise the fallback path with realistic state. B is fragile (mocks drift from real behavior). C adds a test-only env var to production code.

**Verification:** run the orchestrator test suite from `.worktrees/<any>/` and confirm `init-workspace.test.ts > falls back to your-org placeholder` passes without env-var skipping.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 init-workspace.test.ts > 'falls back to your-org placeholder' passes when run from inside a worktree with a configured origin
- [ ] #2 Other init-workspace tests still pass (no regression on the happy-path test)
- [ ] #3 No new test-only escape hatches added to production code in orchestrator/src/cli/commands/git-remote.ts (Option A or B preferred over C)
- [ ] #4 pnpm test:coverage from a worktree completes without skipping the coverage gate
<!-- AC:END -->
