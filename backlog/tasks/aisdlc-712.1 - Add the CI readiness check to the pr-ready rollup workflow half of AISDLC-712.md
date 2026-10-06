---
id: AISDLC-712.1
title: >-
  Add the CI readiness check to the pr-ready rollup: workflow half of AISDLC-712
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - ci
  - governance
dependencies:
  - AISDLC-721
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/dor-ingress.yml
  - .github/workflows/__tests__/ai-sdlc-gate.test.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Why this is its own task: the executor's stale-dispatch check stops on any task whose id already has a merged implementation commit, so AISDLC-712 (merged, PR #1214) cannot be re-dispatched for its second half. This task carries the remaining half under a fresh id. Rule going forward: a task that will ship in halves is split when filed.

AISDLC-712 deleted the pre-push readiness gate and the local drift checks per DEC-0056 row 3. Its acceptance criterion 2, adding the "Evaluate backlog tasks changed by PR" check (job `evaluate-pr-tasks` in `.github/workflows/dor-ingress.yml`) to the required `ai-sdlc/pr-ready` rollup (job in `.github/workflows/ai-sdlc-gate.yml`) for pull requests that change task files, was declined in that PR because it edits `.github/workflows/**`, blocked until AISDLC-721.

Depends on AISDLC-721 (workflow edits allowed once its PR merges).

## Acceptance Criteria
- [ ] The `ai-sdlc/pr-ready` rollup requires the "Evaluate backlog tasks changed by PR" check for pull requests that change files under `backlog/`.
- [ ] Pull requests that change no task file are unaffected: no new required run and no slowdown.
- [ ] A docs-only filing pull request still passes the rollup when the check passes.
- [ ] A hermetic workflow test in `.github/workflows/__tests__/` asserts the conditional wiring, and `docs/operations/quality-gate.md` describes it.
- [ ] PR body carries a "Velocity impact" section (DEC-0048): zero new prompts on the happy path, and no added wait for pull requests that touch no task file.
<!-- SECTION:DESCRIPTION:END -->
