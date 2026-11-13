---
id: AISDLC-1267
title: 'Untrusted PR gate: the sandbox test stage runs, and approval requires its result'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - ucvg
  - security
dependencies: []
references:
  - pipeline-cli/src/pipeline/sandbox-runner.ts
  - pipeline-cli/src/pipeline/sandbox-runner.test.ts
  - pipeline-cli/src/pipeline/reviewer-runner.ts
  - pipeline-cli/src/pipeline/reviewer-runner.test.ts
  - pipeline-cli/src/pipeline/clean-room-signer.ts
  - pipeline-cli/src/pipeline/clean-room-signer.test.ts
  - pipeline-cli/src/pipeline/reviewer-container.ts
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
priority: high
dispatchable: true
dispatchableReason: 'Internal audit 2026-11-13 (findings A2, A3, C3, G2). The image and consensus gaps were verified by the planner in the source; the unstaged base tree is agent-reported and the developer confirms it first. Bounded to four source files.'
---

## Description

**Gap.** Stage 2 of the gate is meant to run the upstream test suite and the PR's new tests in a container with no network. Today it cannot, and nothing downstream notices:

- The default sandbox image is `node:22-slim` (`pipeline-cli/src/pipeline/sandbox-runner.ts`, also `DEFAULT_REVIEWER_IMAGE` in `reviewer-container.ts`). It has no `git`, so the stage errors before a test runs.
- Reported by the audit, not yet verified: the base tree is not staged inside the container, so the differential run would have nothing to compare against even with `git` present. The developer confirms or refutes this first and records the result in the PR body.
- `computeConsensus()` in `reviewer-runner.ts` looks only at the three reviewer verdicts. The Stage 4 check in `clean-room-signer.ts` looks only at consensus. A run whose tests errored or failed can still be approved.
- Raw sandbox test output is passed to the reviewers outside the untrusted-content markers and is not scanned.
- Images are referenced by tag; the relay image is `alpine/socat:latest`.

**Shape.**

1. Use a digest-pinned image that carries `git` and `pnpm`, for the sandbox and for the relay. No `latest` tag.
2. Stage the base tree read-only in the container so the upstream suite runs against the base and the PR's tests against the head.
3. Add the test result to consensus: approval requires that the upstream suite passed and the new tests passed. A sandbox error is a rejection, never a pass. Stage 4 checks the same two flags itself.
4. Give the reviewers the two pass or fail values only; drop the raw test output from the prompt.

RFC-0043 has no open question on this; the RFC already describes Stage 2 as binding.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: RFC-0043 makes approval depend on a differential test run; the alternative of declaring Stage 2 advisory would loosen a control and is not taken. 2. Deleted: the raw test output in the reviewer prompt, and the tag-based image defaults. 3. Simplified or optimised: two booleans cross the boundary; one image constant per role. 4. Accelerated: n/a. 5. Automated: an integration test that runs the sandbox stage against a fixture repository when Docker is available, and unit tests for consensus.

## Acceptance Criteria

- [ ] #1 The default sandbox image and the default relay image are referenced by digest and contain `git` and `pnpm`; no default uses a floating tag.
- [ ] #2 The PR body states whether the base tree was staged in the container before this change, with the evidence.
- [ ] #3 With Docker available, the sandbox stage run against a fixture repository executes the upstream suite and a new test, and reports a pass for a good change and a fail for a change that breaks an upstream test.
- [ ] #4 `computeConsensus()` returns `approved: false` when the upstream suite did not pass, when the new tests did not pass, or when the sandbox errored, even with three approving reviewers. Unit tests cover the three cases.
- [ ] #5 The Stage 4 check in `clean-room-signer.ts` refuses to write an approving record unless both test flags are true, independent of the consensus value it is handed.
- [ ] #6 No reviewer prompt contains sandbox test output; it contains the two pass or fail values only.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
