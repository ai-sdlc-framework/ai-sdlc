---
id: AISDLC-1296
title: 'Untrusted PR gate run container finds pnpm and a built tree, and tests only the changed packages'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - pipeline-cli
  - untrusted-pr-gate
  - bug
dependencies: []
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - pipeline-cli/src/pipeline/sandbox-fetch-integration.test.ts
  - .github/workflows/ai-sdlc-gate.yml
  - .ai-sdlc/untrusted-pr-gate.yaml
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
dispatchableReason: 'Observed on the third end-to-end gate run (fork PR #2634, run 44087577194, 2026-11-17, head aef612c9): the fetch container now finishes, but the run container prints `sh: 1: pnpm: not found` for the base suite and for the head suite, so `upstreamSuitePassed` and `newTestsPassed` are false, two reviewers refuse and Stage 4 refuses the report. No outsider pull request can pass the gate. The operator ordered on 2026-11-17: "file it and land it then let me know when the next run is ready to test". The operator said on 2026-11-16 that the gate runs only what the pull request needs; the planner applies that here to the Node suite (tests of the changed workspace packages only).'
---

## Description

**Gap.** Three defects stand between the fetch container and a passing Node suite on this repository's own tree. Only the first is proven by a run; the second and third follow from the code and from the limits and are confirmed by the self-test of this task.

1. **No pnpm in the run container (proven).** `buildFetchScript` in `pipeline-cli/src/pipeline/sandbox-runner.ts` activates pnpm with corepack under `COREPACK_HOME=/tmp/corepack`. That directory is a tmpfs of the fetch container and is gone when it exits. The run container (no network) runs `sh -c 'pnpm test 2>&1 || npm test 2>&1'`: `pnpm` is not on `PATH`, and `npm test` runs the root script, which itself calls `pnpm -r ...`. Output of run 44087577194: `sh: 1: pnpm: not found> ai-sdlc@0.1.0 test> pnpm -r --no-bail test && ... sh: 1: pnpm: not found`.
2. **No build output (not yet observed).** The fetch script installs dependencies and never builds. Workspace packages import each other through `dist/`, so their tests cannot pass on an unbuilt tree.
3. **The root script cannot fit (not yet observed).** The root `test` script runs every package and then repository checks (`test:gates`, `rfc:check`, `dark-code:check`, `git-env-hygiene:check`, `lint:publishable`, `knowledge:check`). The run container gets 600 seconds, 2 cores and 4 GB for the base run and the head run together, and its tree is an export with no `.git`. The same script takes more than 8 minutes once in the trusted `Build & Test` job.

**Why the tests missed it.** The fixture of `sandbox-fetch-integration.test.ts` has the test script `node --test test/`, so the `npm test` fallback passes without pnpm, and the fixture has no build step.

**Shape.** The fetch container leaves a prepared tree that holds pnpm itself and the build output. The run container calls that pnpm and runs the tests of the workspace packages the diff touches, on the base tree and on the patched tree. A CI job runs this path against this repository's own tree whenever the sandbox code or its configuration changes, so the next defect is found by a pull request of a maintainer and not by a fork pull request that needs the operator's approval.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the sandbox run the whole root script? No: the trusted `ai-sdlc-gate.yml` run still executes the whole script on the pull request; the sandbox answers one question, whether the changed packages' tests pass before and after the diff, and the operator asked on 2026-11-16 for the gate to run only what the pull request needs. 2. Deleted: the `npm test` fallback for a tree with a pnpm lockfile (it can never work there). 3. Simplified or optimised: pnpm is installed once into the prepared tree; no second image, no network in the run container. 4. Accelerated: only changed packages are tested. 5. Automated: the CI self-test of AC #6.

- **pnpm in the prepared tree.** In `buildFetchScript`, when `pnpm-lock.yaml` exists, pnpm of the resolved version is also installed into a directory of the output mount that is named `node_modules/.sandbox-tools` (the run script links every `node_modules` directory from the read-only, exec-capable mount, so the launcher is executable there). The run script puts that directory's `bin` first on `PATH` and sets `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` and `npm_config_update_notifier=false`. The run container never downloads anything; if pnpm is missing there, the suite output says so in one line that names this directory.
- **Build in the fetch container.** After the install, the fetch script runs the root `build` script when the root `package.json` defines one (`pnpm run --if-present build`). The build runs only on the base tree, in the container that sees no diff and no secret.
- **Changed packages only.** When the base tree has a `pnpm-workspace.yaml`, the host computes, from the paths in the diff, the workspace package directories that contain a changed file (longest matching directory of the `packages:` list; glob entries expanded against the base tree). The base command and the head command become one `pnpm --filter ./<dir> test` call per package, joined with `&&`; the head command keeps `--coverage` as today. Directory names are validated against `^[A-Za-z0-9._/-]+$` before they are interpolated; a name that fails is a configuration refusal, not a shell string. A changed package whose source the diff touches is rebuilt in the run container before its head tests only if its `test` script needs `dist/` of itself; the developer states in the PR body what the self-test showed.
- **No changed package.** When no changed file belongs to a workspace package (for example a pull request that changes only documents), no Node test runs: both results are true and the outputs read `no workspace package changed; no package tests run`. The reviewers still run.
- **No workspace file.** A tree without `pnpm-workspace.yaml` keeps today's root command, with one change: with a pnpm lockfile the command is `pnpm test` alone, with no lockfile of pnpm it is `npm test` alone.
- **Extra suites.** The suites of `sandboxSuites` (Python, Go) keep their own commands and are not changed.
- **Limits.** If the self-test shows that the changed-package run of this repository needs more time, `differentialTest.resourceLimits.wallClockSeconds` in `.ai-sdlc/untrusted-pr-gate.yaml` may be raised, to at most 1800, with the measured time in the PR body. No other key of that file changes.
- **Stop rule.** The arguments of the run container (`--network=none`, `--read-only`, both `noexec` tmpfs mounts, user, capabilities, seccomp) do not change. If the self-test cannot pass without changing one of them, or needs more than 1800 seconds, stop and report the exact output in the verdict notes.
- **Docs.** `docs/operations/quality-gate.md` (section on the untrusted PR gate) states what the sandbox Node suite runs and what it does not.

Out of scope: the image and its digest; the reviewer prompts; `allowedMutationGlobs`; narrowing the Python and Go suites.

## Acceptance Criteria

- [ ] #1 `buildFetchScript` for a tree with `pnpm-lock.yaml` installs pnpm of the resolved version under `node_modules/.sandbox-tools` of the output mount and runs the root build script when one is defined; unit tests in `sandbox-runner.test.ts` assert both lines of the script.
- [ ] #2 The run script puts `node_modules/.sandbox-tools/bin` of the patched repository first on `PATH`; a unit test asserts it, and a unit test asserts that the arguments returned by `buildDockerRunArgs` are identical to those on `main` (the diff changes no line of that function).
- [ ] #3 A unit-tested function maps diff paths to workspace package directories: a file under `orchestrator/` gives `orchestrator`; a file under `ai-sdlc-plugin/mcp-server/` gives that directory and not `ai-sdlc-plugin`; a file under `docs/` gives none; a directory name with a character outside `[A-Za-z0-9._/-]` is refused.
- [ ] #4 With a workspace file and changed packages, the base and head commands contain one `pnpm --filter ./<dir> test` per changed package and no `npm test`; with no changed package both results are true with the output text of the Fix; without a workspace file the root command is used as described. Unit tests cover the three cases.
- [ ] #5 The fixture of `sandbox-fetch-integration.test.ts` becomes a pnpm workspace with two packages, where the test of package `b` imports the build output of package `a`, and the root `test` script exits 1. The test passes for a diff that adds a passing test to `b`, which proves pnpm, the build and the package scope together.
- [ ] #6 A second gated integration test (`AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`, Docker present) runs `runSandbox` on an export of this repository's own `HEAD` with the configuration of `.ai-sdlc/untrusted-pr-gate.yaml` and a diff that adds one passing test file to `orchestrator/src/`, and expects `upstreamSuitePassed` and `newTestsPassed` true. `ai-sdlc-gate.yml` runs it in the `integration` job only when the pull request changes `pipeline-cli/src/pipeline/sandbox-*`, `.ai-sdlc/untrusted-pr-gate.yaml`, `pnpm-lock.yaml` or the root `package.json`. It passes in the CI run of this PR, and the PR body gives its duration.
- [ ] #7 `docs/operations/quality-gate.md` states the scope of the sandbox Node suite; if `wallClockSeconds` changed, the PR body gives the measured time and the new value is at most 1800.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
