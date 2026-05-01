## Description
Extend the `FakeRunner` test helper to record per-call wall-clock duration so tests can assert ordering.

## Acceptance Criteria
- [ ] #1 `FakeRunnerCall` in `pipeline-cli/src/__test-helpers/fake-runner.ts` includes a `startedAt` Date
- [ ] #2 At least one consuming test in `pipeline-cli/src/steps` asserts ordering using the new field
