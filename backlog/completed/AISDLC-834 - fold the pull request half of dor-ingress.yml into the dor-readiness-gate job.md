---
id: AISDLC-834
title: >-
  fold the pull request half of dor-ingress.yml into the dor-readiness-gate job
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
  - governance
  - dor
dependencies: []
references:
  - .github/workflows/dor-ingress.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .ai-sdlc/gates.yaml
  - docs/operations/dor-ingress-gate.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`dor-ingress.yml` (origin AISDLC-161, AISDLC-379) has an `evaluate-issue` job and an `evaluate-pr-tasks` job. The PR half duplicates `dor-readiness-gate` in `ai-sdlc-gate.yml` (AISDLC-588, AISDLC-591). Seven days (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 row D3): 582 runs, 193 skipped, 40 cancelled, 13 failed, about 218 runner-minutes. Two evaluations per PR means the PR comment (report) and the rollup check (decision) come from different runs, the report/decide drift class behind the 2026-05-20 task-breakdown incident.

**Five-step review (requirements first).** Requirement questioned: "the violations comment and the blocking check come from separate workflows" (AISDLC-379 added the failing check on top of the existing comment workflow). The operator answered DEC-0097 on 2026-10-11: fold. Delete: the `evaluate-pr-tasks` job and the `pull_request` trigger of `dor-ingress.yml`. Simplify: one DoR evaluation per PR, comment and check from the same run inside `dor-readiness-gate`; the rubric and the `blocked.reason` override are unchanged; `dor-ingress.yml` keeps only its non-PR sweep (`evaluate-issue`). Accelerate: one fewer workflow run per push touching backlog tasks. Automate: nothing new.

## Fix

1. Move the steps of `evaluate-pr-tasks` (evaluate changed backlog tasks, post/update the violations comment, `Compute has_violations`, `Fail check on unresolved violations`) into `dor-readiness-gate` in `.github/workflows/ai-sdlc-gate.yml`, preserving the `blocked.reason` override via `pipeline-cli` `dor-pr-has-violations` and the check name consumers rely on; the job still skips on PRs that touch no `backlog/tasks/*.md`.
2. Remove the `pull_request` trigger and the `evaluate-pr-tasks` job from `.github/workflows/dor-ingress.yml`; keep `evaluate-issue` and the file.
3. Update `.github/workflows/__tests__/dor-ingress.test.mjs`, `ai-sdlc-gate.test.mjs`, `trusted-reviewers-drift.test.mjs` and `no-new-pr-gate.test.mjs` to the folded shape; keep the `pipeline-cli/src/dor/pr-violations.test.ts` unit coverage untouched.
4. `.ai-sdlc/gates.yaml`: update the `workflow:dor-ingress.yml` entry's property so it no longer claims a PR gate (or delete the entry if the workflow no longer fires on pull request events, since the registry tracks PR-event workflows).
5. Docs: `docs/operations/dor-ingress-gate.md`, `quality-gate.md`, `operator-runbook.md`, `backlog-and-execution-reference.md` and the CLAUDE.md "DoR ingress workflow gate" pointer name the new location of the PR evaluation.

**Velocity impact.** Positive: one DoR evaluation per PR instead of two and no comment/check drift; the rubric and override are unchanged.

Authority: DEC-0097 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `dor-ingress.yml` has no `pull_request` trigger and no `evaluate-pr-tasks` job; `evaluate-issue` is unchanged
- [ ] #2 `dor-readiness-gate` in `ai-sdlc-gate.yml` posts the violations comment and fails on `needs-clarification` without a `blocked.reason` override, from one evaluation per PR
- [ ] #3 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #4 `.github/workflows/__tests__/dor-ingress.test.mjs` and the other tests named in the Fix are updated and `node --test .github/workflows/__tests__/` passes
- [ ] #5 CLAUDE.md pointer line and `docs/operations/dor-ingress-gate.md` describe the single evaluation
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
