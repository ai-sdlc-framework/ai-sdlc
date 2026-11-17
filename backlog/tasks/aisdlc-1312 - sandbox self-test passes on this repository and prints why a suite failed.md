---
id: AISDLC-1312
title: 'Sandbox self-test passes on this repository and prints why a suite failed'
status: To Do
assignee: []
created_date: '2026-11-17'
labels:
  - untrusted-pr-gate
  - sandbox
dependencies:
  - AISDLC-1301
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - pipeline-cli/src/pipeline/sandbox-self-integration.test.ts
  - .github/workflows/ai-sdlc-gate.yml
priority: high
dispatchable: true
dispatchableReason: 'Gate run 44163843533 (2026-11-17 19:55Z, head 3df2a17f, the pull request that put pnpm on PATH in the fetch container) failed the step `Sandbox self-test (this repository)`: the sandbox returned outcome success with `upstreamSuitePassed` false. The same step fails on pull request #2757 (runs 44159417975 and 44169138341). The operator ordered the gate proof to be brought to a passing run; this is the defect that stops it now.'
---

## Description

**Gap.** The sandbox still cannot pass this repository's own test suite. In run 44163843533 the step `Sandbox self-test (this repository)` of the `Integration Tests` job ran for 97 seconds and failed at `sandbox-self-integration.test.ts:47`: `runSandbox` returned outcome `success`, but `differentialTest.upstreamSuitePassed` was false. The cause is not known, because the test prints nothing but the failed assertion: the output of the base and head suites in the run container never reaches the CI log.

Two effects:

- No outside contributor's pull request can pass Stage 2/3 of the untrusted PR gate, so the proof run on fork pull request #2634 cannot pass.
- Every pull request that changes `pipeline-cli/src/pipeline/sandbox-*`, `.ai-sdlc/untrusted-pr-gate.yaml`, `pnpm-lock.yaml` or the root `package.json` fails `Integration Tests` on a defect that is not its own (pull request #2757 today).

The pull request that last changed the fetch script merged 15 seconds after its gate run started, before the self-test finished, so its own acceptance criterion (the self-test passes) was never met. `dependencies` names the task that closes that merge path; with it landed, this pull request cannot merge while the self-test fails.

**Shape.** The step `Sandbox self-test (this repository)` passes in CI on this repository's own tree, and when a suite fails in the sandbox the CI log shows the last lines of what that suite printed.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the sandbox pass this repository's suite? Yes: it is the only proof that Stage 2/3 works that needs no fork pull request and no operator approval. 2. Deleted: nothing. 3. Simplified or optimised: the failure output is printed by the self-test from data `runSandbox` already holds or can return; no new log channel. 4. Accelerated: the cause of the next sandbox defect is read from one CI log instead of from a gate run on a fork pull request. 5. Automated: the self-test already runs in CI on each change to the sandbox paths.

- **Show the cause first.** When `upstreamSuitePassed` or `newTestsPassed` is false, `sandbox-self-integration.test.ts` prints the last 200 lines of the output of the failing suite (base, head or both) and of the fetch phase before it asserts. If `runSandbox` does not return that output today, add it to the result under the differential test (a bounded tail, at most 64 KiB per suite); do not print it anywhere but in this test.
- **Find and fix the cause.** Push the diagnostic change, read the self-test log of that CI run, then fix the defect in the fetch or run script of `sandbox-runner.ts`. Name the cause and quote the log lines that show it in the PR body. Repeat until the self-test passes. Suspected, not verified: the run container runs the root `test` script, which may need tools or built output that the fetch phase did not prepare.
- **Unit test.** `sandbox-runner.test.ts` covers each script change (as the existing fetch-script tests do) and the bounded output tail.
- **Proof in CI.** The step `Sandbox self-test (this repository)` must run (not be skipped) and pass on the final head of this pull request. Quote its `sandbox self-test duration` line and the run URL in the PR body.
- **Stop rule.** If the fix would need a change to the Docker arguments of the run container (network, mounts, capabilities, seccomp), or the suite cannot pass inside `wallClockSeconds` of 1800, stop and report in the verdict notes with the exact log lines. Do not mark the pull request ready while the self-test fails.

Out of scope: the Docker arguments of either container; `.ai-sdlc/untrusted-pr-gate.yaml`; the reviewer stages; the path filter of the step `Detect sandbox changes`.

## Acceptance Criteria

- [ ] #1 When a suite fails in the sandbox, `sandbox-self-integration.test.ts` prints at most the last 200 lines of that suite's output and of the fetch phase before the assertion fails; a unit test covers the bound on the returned output.
- [ ] #2 The CI step `Sandbox self-test (this repository)` ran on the final head of this pull request with conclusion success; the PR body quotes its duration line and the run URL.
- [ ] #3 The PR body names the cause of the failure in run 44163843533 and quotes the log lines that show it.
- [ ] #4 `sandbox-self-integration.test.ts` still asserts `upstreamSuitePassed` and `newTestsPassed` true; no assertion is removed or weakened.
- [ ] #5 The Docker arguments built by `buildFetchDockerArgs` and by the run container are unchanged.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
