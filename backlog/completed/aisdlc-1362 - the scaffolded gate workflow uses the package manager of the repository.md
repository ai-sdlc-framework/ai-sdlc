---
id: AISDLC-1362
title: 'The scaffolded gate workflow uses the package manager of the repository'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - adopter
  - bootstrap
  - workflows
dependencies:
  - AISDLC-1353
  - AISDLC-1360
references:
  - orchestrator/src/cli/commands/init-templates.ts
  - orchestrator/src/cli/commands/init-features.ts
  - orchestrator/src/cli/commands/init-features.test.ts
  - orchestrator/src/cli/commands/init-workspace.test.ts
  - pipeline-cli/src/steps/verify-defaults.ts
  - pipeline-cli/src/steps/verification-config.ts
  - docs/operations/init.md
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one render function for the gate and DoR ingress templates, the init writer that picks the manager, one init note and the tests; 5 files changed.'
---

## Description

**Gap.** The gate workflow that `init` writes into an adopter repository always installs pnpm and runs pnpm scripts. A repository that uses npm, yarn or bun gets a gate whose `lint`, `build-test` and `coverage` jobs fail, so `ai-sdlc/pr-ready` never goes green on a pull request, even though the verify step (AISDLC-1360) now runs the right commands.

Operator requirement (2026-11-19): bootstrap a new repository once and have everything configured and running automatically; anything not working says so loudly.

This task is the half of AISDLC-1360 that did not fit its 15 files.

**Cause (read from the source on main).** Each line below was read on the current checkout. The effect on an adopter is inferred from the code; none was run on an adopter repository (unverified).

- The gate template is one constant string, `AI_SDLC_GATE_WORKFLOW` (`orchestrator/src/cli/commands/init-templates.ts:34`). Its `lint`, `build-test` and `coverage` jobs (`init-templates.ts:83-131`) each use `pnpm/action-setup@v4`, `setup-node` with `cache: pnpm`, `pnpm install --frozen-lockfile`, and then `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm test` or `pnpm test:coverage`.
- The DoR ingress template has the same setup and install steps (`init-templates.ts:535-540`; the constant starts at `:502`). Its last step only prints a notice that names pnpm (`:543`).
- Both constants are plain strings placed in static file maps: the gate in `BASELINE_WORKFLOW_TEMPLATES` and `WORKFLOWS_TEMPLATES` (`init-templates.ts:1686`, `:1729`), the ingress in `DOR_TEMPLATES` (`:1151`). The writer copies each `contents` value unchanged (`orchestrator/src/cli/commands/init-features.ts:1498-1530`, the write at `:1528`). Nothing in that path reads the repository, so the template cannot depend on it today.
- The writer has the adapters it needs: `exists` and `readTextFile` (`init-features.ts:805-825`, `readTextFile` at `:825`).
- The only guard today is a note when `package.json` is absent, which prints that the workflows run pnpm and must be edited (`init-features.ts:1538-1560`; documented at `docs/operations/init.md:189-193`). A repository with a `package.json` and a non-pnpm lockfile gets no note and a failing gate (inferred).
- The detector this task reads is the one AISDLC-1360 adds to `pipeline-cli/src/steps/verify-defaults.ts`. On main, `detectVerificationDefaults(exists)` takes only an `exists` function and returns commands for any `package.json`, not the manager name (`verify-defaults.ts:53-66`). AISDLC-1360 adds `detectPackageManager(exists, readText)`, which returns the manager name and reads the `packageManager` field through the optional `readText`, and re-exports it from `verification-config.ts`.
- The orchestrator already imports pipeline-cli through the `./verification` export, which points at `verification-config.js` (`pipeline-cli/package.json:88-91`; `orchestrator/src/cli/commands/init.ts:57`, used at `:489`). A new name used by the orchestrator has to be re-exported from `pipeline-cli/src/steps/verification-config.ts` to be reachable.
- Coverage job. The template runs `pnpm test:coverage` (`init-templates.ts:131`). In this repository that root script exists (`package.json:17`, `pnpm -r test:coverage`). An adopter repository has no such script unless it wrote one. Every manager fails on a missing script: npm with a "missing script" error, yarn and bun with their own not-found errors, pnpm the same (inferred from each tool's behaviour, not run here). So the job already fails loudly in a repository without the script; there is no silent skip today.
- Tests that read the template: `init-features.test.ts:319-321` and `:624-631` (gate contains `ai-sdlc/pr-ready` and `re-actors/alls-green`), `:325-341` (the pnpm note), and `init-workspace.test.ts:440-447`.

**Shape.** At `init` time the writer reads the package manager the repository uses (lockfile first, then the `packageManager` field, pnpm when neither says; the same rule and order as AISDLC-1360) and writes the setup, install and run steps of that manager into the gate and the DoR ingress workflow. A pnpm repository, and a repository with no `package.json`, gets exactly today's bytes. The gate job that AISDLC-1353 adds (`verdict-check`) installs the framework's own packages with npm into a folder outside the checkout; it is not a repository setup step and is left as it is.

**Control.** Does not loosen a control. The gate keeps the same jobs, the same `needs` list and the same `ai-sdlc/pr-ready` rollup; only the commands that spell setup, install and the scripts change. A repository that was failing now runs its own checks, so the gate tightens for it.

**Open question for the operator (not decided here).** What the coverage job does when the repository's `package.json` has no `test:coverage` script. Options: keep the job and fail on the missing script (today's behaviour), leave the job out and drop it from the `pr-ready` needs list, or run the plain `test` script as coverage. Leaving the job out loosens a control for that repository, and running `test` reports coverage that was never measured. Proposal only: keep the job, and have `init` print one line naming the missing `test:coverage` script and the file to edit, so the failure is announced before the first run. Until the operator answers, the developer keeps the job unchanged and prints that line; no step is skipped silently.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should the template name a manager at all? The workflow has to install the repository's dependencies, and the manager is already known from its files, so no. 2. Deleted: the hard-coded `pnpm` words in the gate and ingress templates, and the need for an adopter to hand-edit them. 3. Simplified: one render function with a small table per manager, instead of four copies of the template; `AI_SDLC_GATE_WORKFLOW` stays as the pnpm rendering so nothing else that imports it changes. 4. Accelerated: one detector call per `init`, using the files the writer can already read. 5. Automated: tests render each manager and compare the pnpm output with the previous text byte for byte.

- **Detector.** Call `detectPackageManager` of AISDLC-1360 through the `./verification` export. If that function is not on main when this task starts, stop and report it; do not write a second detector. The lockfile order is the one AISDLC-1360 chose; this task adds no second order. The two pipeline-cli files in the references are read, not changed.
- **Render.** `init-templates.ts` gets `renderGateWorkflow(manager)` and `renderDorIngressWorkflow(manager)`; the exported constants become the pnpm results. Per manager the steps are as below. The `uses`, `cache` and install lines are a proposal for the spelling; any step that sets up the manager, installs from the lockfile without changing it and runs the named script is acceptable.
  - pnpm: unchanged text.
  - npm: no setup action; `setup-node` with `cache: npm`; `npm ci`; `npm run lint`, `npm run format:check`, `npm run build`, `npm test`, `npm run test:coverage`.
  - yarn: no setup action; `setup-node` with `cache: yarn`; `yarn install --immutable` when `.yarnrc.yml` exists or the `packageManager` field names yarn 2 or later, else `yarn install --frozen-lockfile`; `yarn lint`, `yarn format:check`, `yarn build`, `yarn test`, `yarn test:coverage`.
  - bun: `oven-sh/setup-bun@v2`; `setup-node` without a `cache` line, because its cache choices are npm, yarn and pnpm (inferred, unverified); `bun install --frozen-lockfile`; `bun run lint`, `bun run format:check`, `bun run build`, `bun run test`, `bun run test:coverage`.
- **Writer.** `applyFeatureSelection` picks the rendering for the two workflow paths from the detected manager, through `adapters.exists` and `adapters.readTextFile`; every other file is written as before. Dry run lists the same paths.
- **Note.** The no-`package.json` note stays. When a manager other than pnpm is rendered, print one line naming the manager and the files written. Print the missing-`test:coverage` line described in the open question when the manager is known and `package.json` has no such script.
- **Docs.** Rewrite `docs/operations/init.md:189-193` to say init writes the setup, install and run steps of the detected manager, pnpm when neither lockfile nor `packageManager` says, and that the note for a repository without `package.json` is unchanged.
- **Tests.** In the test files listed in the references. The two test files above already hold the template assertions.

Out of scope: the verify defaults and readiness gates (AISDLC-1360), the `verdict-check` job and the attestation workflow (AISDLC-1353), the Node version matrix of the gate, other scaffolded workflows that do not install dependencies, and a repository with no `package.json` (the existing note stays).

## Acceptance Criteria

- [ ] #1 A test shows the gate and the DoR ingress workflow written for a repository with a `pnpm-lock.yaml` are byte-identical to the text on main before this task, and so are the ones written for a repository with no `package.json`.
- [ ] #2 A test shows a `package-lock.json` repository gets a gate with `cache: npm`, `npm ci` and `npm run` scripts, and no `pnpm` string in the jobs.
- [ ] #3 A test shows a `yarn.lock` repository gets `yarn install --frozen-lockfile` for yarn 1 and `yarn install --immutable` when `.yarnrc.yml` exists or `packageManager` is `yarn@4`.
- [ ] #4 A test shows a `bun.lockb` or `bun.lock` repository gets `oven-sh/setup-bun`, `bun install --frozen-lockfile` and `bun run` scripts, and no `cache` line under `setup-node`.
- [ ] #5 A test shows a `package.json` with no lockfile and `"packageManager": "npm@10"` renders npm, and one with neither renders pnpm.
- [ ] #6 A test shows the `needs` list and the `ai-sdlc/pr-ready` job are the same text for every manager.
- [ ] #7 A test shows the init output names the manager and the written workflow files for a non-pnpm repository, and prints the missing `test:coverage` line when the script is absent and stays silent about it when present.
- [ ] #8 A test shows the existing note for a repository without `package.json` is unchanged, and a dry run lists the same paths for every manager.
- [ ] #9 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
