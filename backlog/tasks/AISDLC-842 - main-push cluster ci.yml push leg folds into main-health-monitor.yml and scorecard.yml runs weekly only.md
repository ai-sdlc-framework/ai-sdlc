---
id: AISDLC-842
title: >-
  main-push cluster: ci.yml push leg folds into main-health-monitor.yml and scorecard.yml runs weekly only
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
dependencies: []
references:
  - .github/workflows/ci.yml
  - .github/workflows/main-health-monitor.yml
  - .github/workflows/scorecard.yml
  - .ai-sdlc/gates.yaml
  - docs/operations/main-health-monitor.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Three workflows fire on every push to main (about 204 pushes in 7 days; `docs/audits/2026-10-13-cicd-five-step-audit.md`, findings F7 and F8). `ci.yml` runs the full suite on push (about 2,300 of its 5,855 weekly runner-minutes) and `main-health-monitor.yml` (AISDLC-406) runs the same full suite again (about 930 runner-minutes). `scorecard.yml` runs on every main push (205 runs, 146 runner-minutes) although its weekly cron (Mondays) is the useful signal.

**Five-step review (requirements first).** Requirement questioned: "the full suite must run twice after every merge" (`ci.yml` push leg, kept when `ai-sdlc-gate.yml` became the PR gate; AISDLC-406 added the monitor for merge-skew) and "scorecard is recomputed on every push" (the template default). The operator answered DEC-0165 (option `fold`, not a weakening) and DEC-0163 (option `move`) on 2026-10-13. Delete: the `push` trigger of `ci.yml` and the `push` trigger of `scorecard.yml`. Simplify: the full suite runs once per main push, in `main-health-monitor.yml`; `ci.yml` keeps only its nightly schedule (and its `first-run-smoke` job) ; scorecard keeps `schedule` and `branch_protection_rule`. Accelerate: about 2,300 plus 146 runner-minutes a week. Automate: nothing new.

## Fix

1. `.github/workflows/ci.yml`: remove the `push` trigger (and the `merge_group` leg if it is still present, since the merge queue was dropped by AISDLC-400); keep the `schedule` and the guards that make only `first-run-smoke` run on it. Check that no job in `ci.yml` is the only place a gate runs: every check `ci.yml` ran on push must also run in `main-health-monitor.yml` (`pnpm -r test` plus the workflow YAML tests). If one does not, add it there before deleting the push leg and say so in the PR body.
2. `.github/workflows/scorecard.yml`: remove the `push` trigger; keep `schedule` and `branch_protection_rule`.
3. Update `.github/workflows/__tests__/single-pr-ci-run.test.mjs`, `main-health-monitor.test.mjs` and any test asserting the old triggers.
4. `.ai-sdlc/gates.yaml`: update entries whose property text mentions the push leg; no entry is added.
5. Docs: `docs/operations/main-health-monitor.md` states the monitor is now the only per-push main suite; CLAUDE.md and `docs/operations` lines saying `ci.yml` runs on pushes to main are corrected.

**Velocity impact.** Positive: removes about 2,450 runner-minutes a week; the post-merge safety net still runs once per push.

Authority: DEC-0165 (answered 2026-10-13, operator present; record lands on main via the decisions-sync PR).
Authority: DEC-0163 (answered 2026-10-13, operator present; record lands on main via the decisions-sync PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ci.yml` has no `push` trigger and keeps its nightly schedule; `scorecard.yml` has no `push` trigger and keeps its weekly schedule
- [ ] #2 `main-health-monitor.yml` still runs the full suite on every push to main and covers every check `ci.yml` ran on push (verified and noted in the PR body)
- [ ] #3 Workflow tests asserting the triggers are updated and `node --test .github/workflows/__tests__/` passes
- [ ] #4 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #5 CLAUDE.md and `docs/operations/main-health-monitor.md` describe the single main-push suite
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
