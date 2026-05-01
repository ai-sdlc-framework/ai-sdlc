## Description
Add a circuit breaker to `orchestrator/src/admission-enrichment.ts` so a failing GitHub API doesn't crash every triage.

## Acceptance Criteria
- [ ] #1 After 5 consecutive GitHub failures, `admission-enrichment.ts` returns a degraded verdict
- [ ] #2 The breaker resets after a 30s cooldown
- [ ] #3 An integration test in `orchestrator/src/admission-enrichment.test.ts` covers both states
