---
id: AISDLC-1284
title: '`ai-sdlc init` tells a repository without `package.json` that the scaffolded gate and DoR ingress workflows run pnpm'
status: In Progress
assignee: []
created_date: '2026-11-16'
labels:
  - orchestrator
  - adopter
  - docs
dependencies:
  - AISDLC-1283
references:
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/init-templates.ts
  - pipeline-cli/src/steps/verify-defaults.ts
  - docs/operations/init.md
  - docs/operations/quality-gate.md
priority: low
dispatchable: true
dispatchableReason: 'Adopter-reported (issue #2682). Verified by the planner in source at main 1ffab4a1: the gate and DoR ingress templates in `init-templates.ts` run `pnpm install --frozen-lockfile` and pnpm scripts for every project type, and neither the init output nor `docs/operations/init.md` says so. The operator chose the notice-and-docs scope on 2026-11-16; generating the job bodies from the detected project type is not in this task. Depends on AISDLC-1283, which edits the same next-steps function.'
---

## Description

**Gap (issue #2682).** `ai-sdlc init` writes `.github/workflows/ai-sdlc-gate.yml` whatever the project type. Its `lint`, `build-test` and `coverage` jobs run `pnpm install --frozen-lockfile` and pnpm scripts (`orchestrator/src/cli/commands/init-templates.ts`, about lines 83-142), and the `ai-sdlc/pr-ready` rollup needs all three. `dor-ingress.yml`, written when DoR is selected (the default under `--yes`), has the same setup and install steps (about lines 533-543).

The same run detects `pyproject.toml` and writes `uv` commands to `.ai-sdlc/verification.yaml` (`pipeline-cli/src/steps/verify-defaults.ts`), and `docs/operations/init.md` says a non-Node repository needs no `package.json` shim for the verification commands. Nothing tells the adopter that the scaffolded workflows are the Node baseline and that their jobs fail without `package.json` and a pnpm lockfile.

`docs/operations/quality-gate.md` ("Adopter scaffolding") does say to adjust the job bodies, in a paragraph that still describes the init wizard as planned.

**Shape.** Init prints a notice when it scaffolds pnpm workflows into a repository without `package.json`, and the docs say what the scaffolded jobs run. The templates do not change.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should init generate per-language job bodies instead? Not now: AISDLC-143 put that out of scope, and the operator kept it out on 2026-11-16. The adopter only has to be told. 2. Deleted: the stale "planned" paragraph in `quality-gate.md`. 3. Simplified or optimised: one notice, derived from the templates actually written. 4. Accelerated: n/a. 5. Automated: a test for the notice in a repository with `pyproject.toml` and none in a repository with `package.json`.

- When the project directory has no `package.json`, the "Next steps" text gains a line under the workflows step that names each scaffolded workflow containing pnpm steps (`ai-sdlc-gate.yml`, and `dor-ingress.yml` when it was written) and says those steps must be replaced with the project's own commands, pointing to `.ai-sdlc/verification.yaml` for the detected ones.
- The list of workflows in the notice comes from the templates written in that run, by checking their content for pnpm steps, not from a second fixed list.
- `docs/operations/init.md`: a short section that states what the scaffolded `ai-sdlc-gate.yml` jobs run and what a repository without `package.json` must change.
- `docs/operations/quality-gate.md` ("Adopter scaffolding"): describe init as it is today.

## Acceptance Criteria

- [ ] #1 `ai-sdlc init --yes` in a repository with `pyproject.toml` and no `package.json` prints a line that names each scaffolded workflow with pnpm steps and says those steps must be replaced; a test asserts the line and the workflow names.
- [ ] #2 `ai-sdlc init --yes` in a repository with `package.json` prints no such line; a test covers it.
- [ ] #3 `docs/operations/init.md` states what the scaffolded `ai-sdlc-gate.yml` jobs run and what a repository without `package.json` must change.
- [ ] #4 `docs/operations/quality-gate.md` no longer describes the init wizard as planned.
- [ ] #5 In a repository with `package.json`, the scaffolded `ai-sdlc-gate.yml` is unchanged from today (template tests pass unchanged).
- [ ] #6 The PR body carries `Closes #2682`.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
