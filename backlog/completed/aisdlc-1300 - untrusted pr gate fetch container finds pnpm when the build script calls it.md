---
id: AISDLC-1300
title: 'Untrusted PR gate fetch container finds pnpm when the build script calls it'
status: Done
assignee: []
created_date: '2026-11-17'
labels:
  - untrusted-pr-gate
  - sandbox
dependencies: []
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - pipeline-cli/src/pipeline/sandbox-self-integration.test.ts
  - .github/workflows/ai-sdlc-gate.yml
priority: high
dispatchable: true
dispatchableReason: 'Gate run 44134572329 on fork pull request #2634 (head 6ccbc7a6, 2026-11-17 17:17Z) failed in the fetch phase: the dependency install passed, then the build printed `sh: 1: pnpm: not found`. The operator ordered the gate proof to be brought to a passing run; this is the defect that stops it now.'
---

## Description

**Gap.** `buildFetchScript` in `pipeline-cli/src/pipeline/sandbox-runner.ts` runs `corepack pnpm run build` in the fetch container. The root `build` script of this repository is `pnpm -r build`, which starts a second `pnpm` by name. No `pnpm` is on `PATH` in the fetch container: corepack is called by its own name and never puts a `pnpm` launcher on `PATH`, and the copy that the script installs under `node_modules/.sandbox-tools` is put on `PATH` only in the run container. The fetch phase exits 1 with `sh: 1: pnpm: not found`, so no outside contributor's pull request can pass.

The sandbox self-test of this repository (`sandbox-self-integration.test.ts`) would have shown this, but no CI job ran on the pull request that added it.

**Shape.** In the fetch container, a `build` script that calls `pnpm` by name finds the pnpm of the pinned version, and the gate's sandbox passes on this repository's own tree in CI.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is the build in the fetch container needed? Yes: the test script of the workspace packages needs their built output, and the run container has no network. 2. Deleted: nothing. 3. Simplified or optimised: one `PATH` export in the fetch script, reusing the pnpm the script already installs; no second install. 4. Accelerated: not applicable. 5. Automated: the CI self-test on this repository's own tree runs on this pull request and proves the fetch and run phases together.

- **Fetch script.** In `buildFetchScript`, put the `bin` directory of the pnpm installed under `SANDBOX_TOOLS_DIR` at the front of `PATH` directly after the `npm install -g --prefix ...` line and before the build, so that a nested `pnpm` call in a package script resolves to it. Run the build with that `pnpm`.
- **Unit test.** `sandbox-runner.test.ts` asserts that the script exports this `PATH` entry on a line that comes before the build line.
- **Proof in CI.** This pull request changes `pipeline-cli/src/pipeline/sandbox-runner.ts`, so the step `Sandbox self-test (this repository)` of the `Integration Tests` job runs. It must run (not be skipped) and pass. Quote its `sandbox self-test duration` line in the PR body.
- **Stop rule.** If the self-test fails on a further defect of the fetch or run script in `sandbox-runner.ts`, fix it in this task and name it in the PR body. If the fix would need a change to the Docker arguments of the run container (network, mounts, capabilities, seccomp), stop and report in the verdict notes with the exact error.

Out of scope: the Docker arguments of either container; `.ai-sdlc/untrusted-pr-gate.yaml`; the reviewer stages.

## Acceptance Criteria

- [ ] #1 The script returned by `buildFetchScript` puts the `bin` directory under `node_modules/.sandbox-tools` on `PATH` before it runs the build, and a unit test asserts the order.
- [ ] #2 The CI step `Sandbox self-test (this repository)` ran on this pull request with conclusion success; the PR body quotes its duration line and the run URL.
- [ ] #3 `sandbox-self-integration.test.ts` still asserts `upstreamSuitePassed` and `newTestsPassed` true; no assertion is removed or weakened.
- [ ] #4 The Docker arguments built by `buildFetchDockerArgs` and by the run container are unchanged.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
