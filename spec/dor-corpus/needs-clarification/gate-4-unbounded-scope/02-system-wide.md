## Description
Make the system observable. Touch `orchestrator/src/audit-extended.ts`, every `pipeline-cli/src/steps/*.ts` file, the dashboard at `dashboard/`, and the conformance runner at `conformance/runner/`.

## Acceptance Criteria
- [ ] #1 Every step in `pipeline-cli/src/steps/` emits a structured event
- [ ] #2 Dashboard at `dashboard/` renders the events
- [ ] #3 Conformance runner at `conformance/runner/` validates events
