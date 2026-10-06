---
id: AISDLC-712.1
title: >-
  Add the CI readiness check to the pr-ready rollup: workflow half of AISDLC-712
status: Done
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

Sequencing: AISDLC-721 merges first; workflow edits are allowed after that.

## Acceptance Criteria
- [x] The `ai-sdlc/pr-ready` rollup requires the "Evaluate backlog tasks changed by PR" check for pull requests that change files under `backlog/`.
- [x] Pull requests that change no task file are unaffected: no new required run and no slowdown.
- [x] A docs-only filing pull request still passes the rollup when the check passes.
- [x] A hermetic workflow test in `.github/workflows/__tests__/` asserts the conditional wiring, and `docs/operations/quality-gate.md` describes it.
- [x] PR body carries a "Velocity impact" section (DEC-0048): zero new prompts on the happy path, and no added wait for pull requests that touch no task file.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added `dor-readiness-gate` to the `ai-sdlc/pr-ready` rollup. It runs only when a PR changes `backlog/tasks/*.md` and mirrors the `Evaluate backlog tasks changed by PR` check on the head SHA.

## Changes
- `.github/workflows/ai-sdlc-gate.yml` (modified): `tasks` paths filter in `detect`, `dor-readiness-gate` job, added to `needs` and `allowed-skips`.
- `.github/workflows/__tests__/ai-sdlc-gate.test.mjs` (modified): conditional-wiring, filter-equals-dor-ingress-trigger and rollup-decision tests.
- `docs/operations/quality-gate.md` (modified): new section describing the gate.

## Design decisions
- **Filter is `backlog/tasks/*.md`, not all of `backlog/`**: it must equal the dor-ingress trigger, otherwise a completed-only PR would wait for a check that never starts.
- **Mirror the check instead of re-running it**: no duplicated install/build; the wait is hidden behind build-test/coverage.
- **Stale `skipped`/`cancelled` runs ignored, bound to the `github-actions` app, fails closed at 15 min**: from reviewer findings.

## Verification
- `pnpm build` clean; `pnpm lint` clean; `pnpm format:check` clean
- `node --test .github/workflows/__tests__/*.test.mjs` 406 pass
- `pnpm test`: reference ReDoS timing test (`secret-redact.test.ts`) fails under machine load; unrelated, no TS changed
- Code + security reviews approved (code review fell back to Claude-native: Codex usage limit)

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
