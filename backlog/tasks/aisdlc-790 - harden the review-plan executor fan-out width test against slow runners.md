---
id: AISDLC-790
title: >-
  Harden the review-plan executor fan-out width test so peak concurrency is observed deterministically, not through a wall-clock sleep
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - flake
  - test
dependencies: []
references:
  - pipeline-cli/src/review-plan/executor.test.ts
  - pipeline-cli/src/review-plan/executor.ts
  - docs/operations/main-health-monitor.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Main-health issue #1304 (2026-10-09 23:59Z, commit a4a72117, a docs-only RFC-0053 commit) fired on one test out of 429 files: `pipeline-cli/src/review-plan/executor.test.ts:788`, `executePlan: fan-out and the bundle > runs six probes at the configured width and returns one valid entry per probe in plan order`, `AssertionError: expected 2 to be 3`. The test spawns six mock probes that each `await setTimeout(15)` and asserts the observed peak in-flight count equals the configured width of 3. On a loaded runner the 15 ms window is too short for all three slots to be seen in flight at once, so the peak reads 2. Main was green on every main-health run after it (seven consecutive through a24a0c7b, 2026-10-10 15:17Z); the operator ruled #1304 a flake and asked for this hardening task.

Replace the wall-clock sleep with a deterministic barrier: each mock probe records that it started, then awaits a per-probe deferred promise; the test releases probes only once `inFlight` has reached the width (or after it has confirmed, via the executor's own scheduling, that the fourth probe did not start before one of the first three resolved). The assertion `peak === 3` must then hold regardless of CPU contention, and a fourth probe starting while three are in flight must fail the test deterministically. Keep the remaining assertions (six calls, plan order, all ok, valid bundle). Audit the other timing-based tests in the same file (any `setTimeout` used to shape concurrency) and convert them the same way where they assert on ordering or concurrency.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The width test at `executor.test.ts` no longer depends on a wall-clock `setTimeout` to observe peak concurrency; probes are released through a barrier controlled by the test.
- [ ] Running the file 50 times in a loop under CPU load (e.g. `for i in $(seq 50); do pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/review-plan/executor.test.ts -t "configured width" || exit 1; done` with a parallel `yes > /dev/null` burner) passes every time.
- [ ] The test still fails when the executor's width limit is broken (verified once by temporarily bumping the limit in a scratch change; not committed).
- [ ] Any other concurrency or ordering assertion in the same file that relies on sleep durations is converted to the same barrier pattern, or a comment explains why it is safe.
- [ ] `docs/operations/main-health-monitor.md` gains one line under its flake-triage guidance pointing at this pattern (barrier over sleep) for concurrency tests.

## Notes

Reference incident: GitHub issue #1304. Related earlier RCA of clock-dependent tests on red main: `2026-10-09-clock-dependent-test-red-main-rca.md` (AISDLC-768/769/770).
