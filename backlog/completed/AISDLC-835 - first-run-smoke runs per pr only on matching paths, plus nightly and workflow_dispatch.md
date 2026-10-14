---
id: AISDLC-835
title: >-
  first-run-smoke runs per PR only on matching paths, plus nightly and workflow_dispatch
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ci.yml
  - scripts/first-run-smoke.mjs
  - .ai-sdlc/gates.yaml
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The `first-run-smoke` job (origin AISDLC-771) is gated by the `first_run` path filter at `ai-sdlc-gate.yml` line 169, which lists `ai-sdlc-plugin/**`, `pipeline-cli/**`, `reference/**`, `orchestrator/**`, `README.md` and `scripts/first-run-smoke*`. In the last 60 sampled gate runs it ran 29 times, 54 s median, 2 failures; the AISDLC-805 audit found 0 failures in 31 PR runs. A nightly run already exists in `ci.yml` (AISDLC-771) but the per-PR filter was never narrowed (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 row D6).

**Five-step review (requirements first).** Requirement questioned: "every PR touching any package source proves a fresh adopter can init" (AISDLC-771). The operator answered DEC-0100 on 2026-10-11 with a third option, not the recorded `nightly-only` weakening: run per PR only when paths match the adopter surface (`ai-sdlc-plugin/**`, init, doctor, templates), plus a nightly schedule as backstop, plus `workflow_dispatch`. This task follows that rationale, not the bare option id: same-PR detection stays on plugin PRs, cost is removed from the rest. Delete: `pipeline-cli/**`, `reference/**`, `orchestrator/**` (except the init/doctor/template files) and `README.md` from the per-PR filter. Simplify: one narrower path list. Accelerate: about half the gate runs lose a 54 s job. Automate: nothing new; the nightly already exists.

## Fix

1. In `.github/workflows/ai-sdlc-gate.yml` narrow the `first_run` filter to `ai-sdlc-plugin/**`, the orchestrator init/doctor/template sources (`orchestrator/src/cli/commands/init*`, `orchestrator/src/cli/commands/doctor*`, `orchestrator/src/cli/commands/init-templates.ts`) and `scripts/first-run-smoke*`; drop `pipeline-cli/**`, `reference/**`, the rest of `orchestrator/**` and `README.md`.
2. Confirm the nightly schedule in `ci.yml` still runs `scripts/first-run-smoke.mjs`, and add `workflow_dispatch` to that nightly (or to a dedicated trigger) if it is missing.
3. Update `.github/workflows/__tests__/first-run-smoke.test.mjs`, `ai-sdlc-gate.test.mjs` and `single-pr-ci-run.test.mjs` to assert the narrowed filter, the nightly schedule and the dispatch trigger.
4. `.ai-sdlc/gates.yaml`: update the `gate-job:first-run-smoke` property text; no entry is added or removed.

**Velocity impact.** Positive: removes a 54 s job from about half of all gate runs while keeping same-PR detection on plugin PRs and a nightly backstop.

Authority: DEC-0100 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The `first_run` path filter in `ai-sdlc-gate.yml` lists only the adopter-surface paths named in the Fix
- [ ] #2 The nightly schedule in `ci.yml` runs first-run-smoke and a `workflow_dispatch` trigger exists for it
- [ ] #3 `.github/workflows/__tests__/first-run-smoke.test.mjs`, `ai-sdlc-gate.test.mjs` and `single-pr-ci-run.test.mjs` assert the narrowed filter, nightly and dispatch; `node --test .github/workflows/__tests__/` passes
- [ ] #4 `.ai-sdlc/gates.yaml` first-run-smoke entry text matches the new scope and `pnpm test:gates` passes with no entry added
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
