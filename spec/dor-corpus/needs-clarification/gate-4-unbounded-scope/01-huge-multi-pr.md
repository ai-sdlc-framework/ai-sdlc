## Description
Refactor the entire orchestrator: split `orchestrator/src/admission.ts` into 5 modules, migrate the audit log to SQLite (currently in `orchestrator/src/audit-archival.ts`), rewrite the trust scoring in `orchestrator/src/admission-score.ts`, port the dependency graph to `pipeline-cli/src/deps/dependency-graph.ts`, and overhaul the test suite in `orchestrator/src/` end to end.

## Acceptance Criteria
- [ ] #1 `orchestrator/src/admission.ts` is split into 5 files
- [ ] #2 SQLite migration of `orchestrator/src/audit-archival.ts` is complete
- [ ] #3 Trust scoring in `orchestrator/src/admission-score.ts` is rewritten
- [ ] #4 Dependency graph is ported to `pipeline-cli/src/deps/dependency-graph.ts`
- [ ] #5 New test suite reaches 95% coverage
