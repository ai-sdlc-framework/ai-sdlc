---
id: AISDLC-1294
title: 'Untrusted PR gate fetch container can run the install scripts of the base tree'
status: Done
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
priority: high
dispatchable: true
dispatchableReason: 'Observed on the second end-to-end gate run (fork PR #2634, run 43966782831, 2026-11-17 00:18Z, with the fetch container of AISDLC-1291 on main): the fetch container downloaded all 406 packages, then the install script of `better-sqlite3` failed with `sh: 1: node-gyp: Permission denied` and pnpm exited 126. Stage 2 stopped with "sandbox fetch phase failed", so no outsider pull request can pass the gate. The operator asked on 2026-11-16 for the gate proof to be re-run until it passes.'
---

## Description

**Gap.** AISDLC-1291 added a fetch container that installs the dependencies of the base tree before the no-network run container starts. On this repository's own tree the install does not finish.

- Run 43966782831, job "Stage 2/3", step "Stage 2 — Run Docker sandbox": `corepack pnpm install --frozen-lockfile` resolved and downloaded 406 of 406 packages, then printed `.../node_modules/better-sqlite3 install$ node-gyp rebuild`, `sh: 1: node-gyp: Permission denied`, `ELIFECYCLE Command failed with exit code 126`.
- Exit code 126 with "Permission denied" means the shell found `node-gyp` on `PATH` and was not allowed to execute it.
- `buildFetchScript` in `pipeline-cli/src/pipeline/sandbox-runner.ts` sets `HOME=/tmp/home` and `COREPACK_HOME=/tmp/corepack`, so pnpm itself, and the `node-gyp` launcher that pnpm puts on `PATH` for install scripts, live under `/tmp`.
- `buildFetchDockerArgs` mounts `/tmp` with `--tmpfs /tmp:rw,nosuid,size=1g`. Docker adds `noexec` to a `--tmpfs` mount unless the option `exec` is given, so nothing under `/tmp` can be executed. This is the likely cause; the developer confirms it with the failing test of AC #3 before changing the arguments.
- The integration test of AISDLC-1291 (`sandbox-fetch-integration.test.ts`) passed in CI because its fixture has one dependency with a prebuilt binary and no install script that calls `node-gyp`.

**Shape.** The fetch container can execute what the package manager installs for itself, so an install script of the base tree that calls `node-gyp` runs. The run container keeps `noexec` on `/tmp` and on the workspace.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must install scripts run at all? Yes: `better-sqlite3` is in `onlyBuiltDependencies` of the root `package.json` and the suite needs its native module; `--ignore-scripts` would move the failure to the run container, which has no network and no compiler. 2. Deleted: nothing. 3. Simplified or optimised: one mount option on the fetch container; `HOME` and `COREPACK_HOME` stay where they are, so nothing of the package manager is copied into the prepared tree. 4. Accelerated: not applicable. 5. Automated: the integration fixture gains an install script that calls `node-gyp`, so CI (`AI_SDLC_SANDBOX_INTEGRATION_TESTS=1` in `ai-sdlc-gate.yml`) catches a return of this defect.

- **Mount option.** In `buildFetchDockerArgs`, the `/tmp` tmpfs becomes `/tmp:rw,exec,nosuid,size=1g`. Every other argument of the fetch container is unchanged. `buildDockerRunArgs` (the run container) is unchanged.
- **Why this is not a weaker control.** The fetch container already executes the install scripts of `main` from the output mount, sees only the base tree (no PR diff, no fixture, no proxy host entry, no secret) and the arguments landed by AISDLC-1291 carry no explicit `noexec` for it. The run container, which executes contributor code, keeps `noexec`. State this in the PR body.
- **If the test of AC #3 still fails with `exec` set,** the cause is different from the one named above: stop, report the new output in the verdict notes and do not widen any other argument.
- **Integration fixture.** `sandbox-fetch-integration.test.ts` adds to its fixture a local dependency (`file:` path inside the fixture) with `"install": "node-gyp --version"` and lists it in `pnpm.onlyBuiltDependencies`, so the fetch container must execute pnpm's `node-gyp` launcher. No compiler run is needed.

Out of scope: the image and its digest; the run container; the extra suites of AISDLC-1293 (they use the same `buildFetchDockerArgs` and get the option with it); narrowing which packages are installed.

## Acceptance Criteria

- [ ] #1 `buildFetchDockerArgs` returns `--tmpfs` followed by `/tmp:rw,exec,nosuid,size=1g`; a unit test in `sandbox-runner.test.ts` asserts the exact string.
- [ ] #2 A unit test asserts that the arguments of the run container still contain `/tmp:rw,noexec,nosuid,size=256m` and `/sandbox/workspace:rw,noexec,nosuid`, and the diff changes no line of `buildDockerRunArgs`.
- [ ] #3 The fixture of `sandbox-fetch-integration.test.ts` contains a dependency whose install script runs `node-gyp --version`; the test passes in the CI run of the PR, and the PR body quotes the failure output of the same test without the `exec` option (from a CI run of the first commit, or a local Docker run).
- [ ] #4 The diff changes no other argument of the fetch container (user, capabilities, read-only root, mounts, limits); the PR body states this and gives the reason of the section "Why this is not a weaker control".
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
