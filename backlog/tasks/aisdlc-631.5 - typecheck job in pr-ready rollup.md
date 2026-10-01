---
id: AISDLC-631.5
title: >-
  CI follow-up: run pnpm typecheck as a job feeding the ai-sdlc/pr-ready rollup
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - ci
  - quality-gate
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/quality-gate.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up approved by the operator on 2026-10-01. Merge skew between two green PRs
broke `tsc --noEmit` on `main` while every per-PR check stayed green: no PR check runs
the workspace typecheck. Internal workflow edits are authorized for this task.

## Scope
1. Add a `typecheck` job to `.github/workflows/ai-sdlc-gate.yml` that runs
   `pnpm typecheck` on the rebased merge ref after installing and building workspace
   dependencies in the order the root `build` script uses.
2. Include the job in the `ai-sdlc/pr-ready` rollup so it is required through the
   existing single required check; do not add a new required context.
3. Document the job in `docs/operations/quality-gate.md`.
4. Hermetic workflow test under `.github/workflows/__tests__/` asserting the job
   exists and feeds the rollup, in the style of the existing gate tests.

## Acceptance Criteria
- [ ] A branch that breaks `tsc --noEmit` in any workspace package fails `ai-sdlc/pr-ready` on that PR.
- [ ] A clean branch passes with the job reported in the rollup.
- [ ] The workflow test asserts the job and its rollup wiring.
- [ ] `docs/operations/quality-gate.md` describes the job.
- [ ] `pnpm test:gate-workflow` and the full `pnpm test` pass.
<!-- SECTION:DESCRIPTION:END -->
