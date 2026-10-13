---
id: AISDLC-844
title: >-
  fold the coverage job into build-test so the suite runs once with coverage on
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/__tests__/ai-sdlc-gate.test.mjs
  - .ai-sdlc/gates.yaml
  - scripts/check-pr-patch-coverage.mjs
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`ai-sdlc-gate.yml` `build-test` runs `pnpm install`, `pnpm build`, `pnpm test`; `coverage` runs `pnpm install`, `pnpm build`, `pnpm test:coverage` on a second runner, so the suite runs twice per push. Over a 60-job sample the two jobs are 35 and 32 percent of all gate job time, about 6,300 of about 9,500 gate runner-minutes a week (`docs/audits/2026-10-13-cicd-five-step-audit.md`, finding F2).

**Five-step review (requirements first).** Requirement questioned: "coverage is its own job" (AISDLC-726, AISDLC-376). What survives is the requirement itself: per-package line floors (90 for reference, orchestrator, pipeline-cli, mcp-server, mcp-advisor and sdk-typescript; 85 for dogfood, dashboard and the conformance runner) and the 90 percent patch-coverage gate. Delete: the second install, build and full test run. Simplify: one job runs the suite once with coverage on and applies the floors and the patch gate from that run. Accelerate: about 3,000 runner-minutes a week saved; the wall-clock critical path is unchanged (the two jobs ran in parallel), which is why sharding is a separate later task. Automate: nothing new. Not a weakening: same floors, same gate.

## Fix

1. In `.github/workflows/ai-sdlc-gate.yml` make `build-test` run the coverage-enabled test command (`pnpm test:coverage`, or `pnpm test` with coverage flags if `test:coverage` omits the non-vitest suites; keep whatever `pnpm test` runs beyond vitest) and move the `Patch coverage gate` step (with `fetch-depth: 0`) into it; delete the `coverage` job.
2. Fix every reference to the `coverage` job: the `pr-ready` `needs:` list and its result checks, `detect` output conditions, `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`, `single-pr-ci-run.test.mjs`, and `docs/operations/quality-gate.md`. The required rollup `ai-sdlc/pr-ready` must still fail when a floor or the patch gate fails.
3. `.ai-sdlc/gates.yaml`: delete `gate-job:coverage`; fold its property text into `gate-job:build-test`.
4. Keep the Node 22 only matrix as is. Do not shard in this task.

**Velocity impact.** Positive: one install, one build and one full test run fewer per PR push, about 3,000 runner-minutes a week.

Authority: class (a) decision under `docs/operations/decision-authority.md` (reversible, non-weakening, derived from the 2026-10-13 audit; no decision record required).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ai-sdlc-gate.yml` has no `coverage` job; `build-test` runs the suite once with coverage and then the patch-coverage gate
- [ ] #2 Per-package floors and the 90 percent patch gate are unchanged and still fail `ai-sdlc/pr-ready` when violated (asserted in `ai-sdlc-gate.test.mjs`)
- [ ] #3 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #4 `docs/operations/quality-gate.md` describes the single job
- [ ] #5 `node --test .github/workflows/__tests__/` passes
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
